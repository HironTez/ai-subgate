import {
  isImage,
  isText,
  isToolResult,
  isToolUse,
  type ContentBlock,
  type ImageBlock,
  type Message,
  type MessagesRequest,
  type TextBlock,
  type ToolResultBlock,
} from "./types.ts";
import { sha256 } from "./util.ts";

/**
 * Convert string content to blocks, fold `role: "system"` messages (sent by newer clients for
 * per-turn context) into the user turn as tagged text, and merge consecutive same-role messages.
 */
export function normalizeMessages(raw: MessagesRequest["messages"]): Message[] {
  const out: Message[] = [];
  for (const m of raw) {
    let content: ContentBlock[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    let role = m.role as string;
    if (role === "system") {
      const text = content.filter(isText).map((b) => b.text).join("\n\n");
      content = text.trim() ? [{ type: "text", text: `<system_context>\n${text}\n</system_context>` }] : [];
      role = "user";
    }
    if (role !== "user" && role !== "assistant") continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content = [...prev.content, ...content];
    else out.push({ role, content: [...content] });
  }
  return out;
}

export function systemText(system: MessagesRequest["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.filter(isText).map((b) => b.text).join("\n\n");
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Signature of a message that survives the round trip through a client:
 * text is whitespace-normalized and merged, tool calls/results are identified by id only
 * (clients may later truncate old tool results), thinking blocks are ignored.
 */
function messageSig(m: Message): string {
  const parts: string[] = [];
  let text: string[] = [];
  const flushText = () => {
    const t = norm(text.join(" "));
    if (t) parts.push("t:" + t);
    text = [];
  };
  for (const b of m.content) {
    if (isText(b)) text.push(b.text);
    else if (isToolUse(b)) (flushText(), parts.push("u:" + b.id));
    else if (isToolResult(b)) (flushText(), parts.push("r:" + b.tool_use_id));
    else if (isImage(b)) (flushText(), parts.push("i"));
  }
  flushText();
  return m.role + "|" + parts.join("|");
}

/** Fingerprint of (context, conversation). Used to find a live harness session to continue. */
export function fingerprint(context: string, messages: Message[]): string {
  return sha256(context + "\n" + messages.map(messageSig).join("\n"));
}

// ---------------------------------------------------------------------------
// Rendering a conversation into a fresh harness prompt ("replay")

function toolResultText(r: ToolResultBlock): string {
  if (r.content === undefined) return "";
  if (typeof r.content === "string") return r.content;
  return r.content
    .map((b) => (b.type === "text" ? (b as TextBlock).text : b.type === "image" ? "[image]" : `[${b.type}]`))
    .join("\n");
}

function renderBlock(b: ContentBlock): string | null {
  if (isText(b)) return b.text;
  if (isImage(b)) return "[image omitted]";
  if (isToolUse(b)) return `<tool_call id="${b.id}" name="${b.name}">\n${JSON.stringify(b.input)}\n</tool_call>`;
  if (isToolResult(b))
    return `<tool_result id="${b.tool_use_id}"${b.is_error ? ' is_error="true"' : ""}>\n${toolResultText(b)}\n</tool_result>`;
  return null; // thinking, documents, etc.
}

function renderMessage(m: Message): string {
  const body = m.content.map(renderBlock).filter((x): x is string => x !== null).join("\n");
  return `<${m.role}>\n${body}\n</${m.role}>`;
}

export function imagesOf(m: Message): ImageBlock[] {
  const out: ImageBlock[] = [];
  for (const b of m.content) {
    if (isImage(b)) out.push(b);
    if (isToolResult(b) && Array.isArray(b.content))
      for (const c of b.content) if (c.type === "image") out.push(c as ImageBlock);
  }
  return out;
}

/**
 * Turn a full Messages-API history into the first user turn of a fresh harness session.
 * The final user message is passed natively (text + images); earlier turns become a transcript.
 */
export function renderPrompt(messages: Message[], opts: { images: boolean }): ContentBlock[] {
  const last = messages[messages.length - 1];
  const history = messages.slice(0, -1);
  const images = opts.images ? imagesOf(last) : [];
  const hasResults = last.content.some(isToolResult);

  if (history.length === 0 && !hasResults) {
    const blocks: ContentBlock[] = last.content.filter(isText).map((b) => ({ type: "text", text: b.text }));
    if (!opts.images && last.content.some(isImage)) blocks.push({ type: "text", text: "[image omitted]" });
    return [...blocks, ...images];
  }

  const parts: string[] = [];
  if (history.length) {
    parts.push(
      "The conversation so far is reproduced below. You are the assistant. Tool calls shown in it were already executed " +
        "and their results are included; do not repeat them unless you need fresh data.",
      "<conversation_history>",
      ...history.map(renderMessage),
      "</conversation_history>",
    );
  }
  const lastBody = last.content.map(renderBlock).filter((x): x is string => x !== null).join("\n");
  if (hasResults) {
    parts.push("These are the results of your most recent tool calls. Continue from here.", lastBody);
  } else {
    parts.push("The user's latest message:", lastBody);
  }
  return [{ type: "text", text: parts.join("\n\n") }, ...images];
}

/** Rough token estimate for /v1/messages/count_tokens. */
export function estimateTokens(req: MessagesRequest): number {
  const msgs = normalizeMessages(req.messages ?? []);
  let chars = systemText(req.system).length + JSON.stringify(req.tools ?? []).length;
  for (const m of msgs) for (const b of m.content) chars += isImage(b) ? 6000 : (renderBlock(b) ?? "").length;
  return Math.ceil(chars / 3.5);
}
