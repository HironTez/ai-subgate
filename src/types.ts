// Subset of the Anthropic Messages API that the gateway understands.

export type TextBlock = { type: "text"; text: string; [k: string]: unknown };
export type ImageSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string };
export type ImageBlock = { type: "image"; source: ImageSource; [k: string]: unknown };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown; [k: string]: unknown };
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content?: string | Array<TextBlock | ImageBlock | { type: string; [k: string]: unknown }>;
  is_error?: boolean;
  [k: string]: unknown;
};
export type OtherBlock = { type: string; [k: string]: unknown };
export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | OtherBlock;

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface ToolDef {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  type?: string;
}

export interface MessagesRequest {
  model: string;
  messages: Array<{ role: "user" | "assistant" | "system"; content: string | ContentBlock[] }>;
  system?: string | TextBlock[];
  tools?: ToolDef[];
  tool_choice?: { type: "auto" | "any" | "tool" | "none"; name?: string };
  stream?: boolean;
  max_tokens?: number;
  [k: string]: unknown;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export const zeroUsage = (): Usage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
});

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "refusal";

export const isText = (b: ContentBlock): b is TextBlock => b.type === "text";
export const isImage = (b: ContentBlock): b is ImageBlock => b.type === "image";
export const isToolUse = (b: ContentBlock): b is ToolUseBlock => b.type === "tool_use";
export const isToolResult = (b: ContentBlock): b is ToolResultBlock => b.type === "tool_result";
