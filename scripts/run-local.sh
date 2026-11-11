#!/usr/bin/env bash
# Keeps the subgate gateway running inside the `dev` distrobox, and only there.
#
#   scripts/run-local.sh up          start the supervisor in the background unless it already runs
#                                    (quick and idempotent; called by the box's /etc/profile.d hook)
#   scripts/run-local.sh down        stop the supervisor and the gateway (live harness sessions end)
#   scripts/run-local.sh restart     down, then up
#   scripts/run-local.sh status      supervisor/gateway pids, health and URL
#   scripts/run-local.sh install     write the box's /etc/profile.d/subgate.sh hook (sudo)
#   scripts/run-local.sh uninstall   down, and remove that hook
#   scripts/run-local.sh supervise   the supervisor itself (foreground)
#
# The supervisor runs `bun src/cli.ts serve` (Anthropic-compatible API on http://127.0.0.1:8742)
# and restarts it 10s after it exits. Every process lives in the container, so stopping the box
# stops the service; the host has no unit for it. Entering the box (any login or interactive shell)
# runs the hook, which starts it again.
#
# Logs: var/serve.log (rotated to var/serve.log.1 at 20 MB). Config: subgate.json (uses the claude
# login in the dev box home). Override with SUBGATE_CONFIG; SUBGATE_PORT only changes the URL shown.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
VAR="$ROOT/var"
LOCK="$VAR/supervisor.lock"
SUP_PIDFILE="$VAR/supervisor.pid"
PIDFILE="$VAR/serve.pid"
LOG="$VAR/serve.log"
BOX=dev
HOOK=/etc/profile.d/subgate.sh
PORT="${SUBGATE_PORT:-8742}"
STOP_WAIT_S="${SUBGATE_STOP_WAIT_S:-20}"

log() { printf '%s supervisor: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$*"; }

in_box() { [[ "${CONTAINER_ID:-}" == "$BOX" ]] || grep -qs "name=\"$BOX\"" /run/.containerenv; }

# Prints the pid from pidfile $1 when that process still runs a command matching $2.
live_pid() {
  local pid
  [[ -f "$1" ]] || return 1
  pid="$(<"$1")"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null || return 1
  tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q -- "$2" || return 1
  echo "$pid"
}
serve_pid() { live_pid "$PIDFILE" 'src/cli.ts serve'; }
supervisor_pid() { live_pid "$SUP_PIDFILE" 'run-local.sh supervise'; }

# SIGTERM pid $1 and wait for it to exit, SIGKILL after STOP_WAIT_S.
term_wait() {
  local i
  kill -TERM "$1" 2>/dev/null || return 0
  for ((i = 0; i < STOP_WAIT_S; i++)); do
    kill -0 "$1" 2>/dev/null || return 0
    sleep 1
  done
  log "pid $1 still running after ${STOP_WAIT_S}s, killing it" >&2
  kill -KILL "$1" 2>/dev/null || true
}

supervise() {
  in_box || { echo "run-local: not inside the $BOX distrobox" >&2; exit 1; }
  mkdir -p "$VAR"
  exec 9>"$LOCK"
  flock -n 9 || { log "supervisor already running"; exit 0; }
  echo $$ >"$SUP_PIDFILE"

  export HOME="${SUBGATE_HOME:-/home/v/dbx-homes/$BOX}"
  export PATH="$HOME/.local/bin:/home/v/.bun/bin:/home/v/.nvm/versions/node/v24.12.0/bin:/usr/local/bin:/usr/bin:/bin"
  # The gateway's own harnesses must use the subscription login, never an API key or a base URL
  # that could point back at this gateway.
  unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL
  local bin
  for bin in bun claude flock; do
    command -v "$bin" >/dev/null || { log "$bin not found on PATH"; exit 1; }
  done

  local stopping=0 child='' rc pid
  trap 'stopping=1; [[ -n "$child" ]] && kill -TERM "$child" 2>/dev/null || true' TERM INT
  trap '' HUP
  if pid="$(serve_pid)"; then log "stopping leftover gateway (pid $pid)"; term_wait "$pid"; fi
  log "supervisor started (pid $$)"
  while ((!stopping)); do
    # fd 9 (the lock) must not leak into the gateway or its harnesses
    bun src/cli.ts serve 9>&- &
    child=$!
    echo "$child" >"$PIDFILE"
    rc=0
    while kill -0 "$child" 2>/dev/null; do wait "$child" && rc=0 || rc=$?; done
    child=''
    rm -f "$PIDFILE"
    ((stopping)) && break
    log "gateway exited (status $rc); restarting in 10s"
    sleep 10 &
    wait $! || true
  done
  rm -f "$SUP_PIDFILE"
  log "supervisor stopped"
}

up() {
  in_box || { echo "run-local: not inside the $BOX distrobox" >&2; exit 1; }
  supervisor_pid >/dev/null && return 0
  mkdir -p "$VAR"
  if [[ -f "$LOG" ]] && (($(stat -c %s "$LOG") > 20 * 1024 * 1024)); then mv -f "$LOG" "$LOG.1"; fi
  setsid -f "$ROOT/scripts/run-local.sh" supervise >>"$LOG" 2>&1 </dev/null
  echo "subgate starting: http://127.0.0.1:$PORT (log $LOG)"
}

down() {
  local pid
  if pid="$(supervisor_pid)"; then term_wait "$pid"; fi
  # a gateway without its supervisor (supervisor killed) is stopped too
  if pid="$(serve_pid)"; then term_wait "$pid"; fi
  rm -f "$SUP_PIDFILE" "$PIDFILE"
}

status() {
  local sp vp rc=0
  if sp="$(supervisor_pid)"; then echo "supervisor: running (pid $sp)"; else echo "supervisor: stopped"; rc=1; fi
  if vp="$(serve_pid)"; then echo "gateway:    running (pid $vp), http://127.0.0.1:$PORT"; else echo "gateway:    stopped"; rc=1; fi
  echo "health:     $(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" 2>/dev/null || echo unreachable)"
  echo "log:        $LOG"
  return $rc
}

install_hook() {
  in_box || { echo "run-local: not inside the $BOX distrobox" >&2; exit 1; }
  sudo tee "$HOOK" >/dev/null <<EOF
# subgate: start the local AI gateway when the $BOX distrobox is entered (login or interactive shell).
# It runs inside this box only and stops with it. Manage it with $ROOT/scripts/run-local.sh up|down|status.
if [ "\${CONTAINER_ID:-}" = "$BOX" ] && [ -x "$ROOT/scripts/run-local.sh" ]; then
  "$ROOT/scripts/run-local.sh" up >/dev/null 2>&1 || :
fi
EOF
  echo "installed $HOOK"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  restart) down; up ;;
  status) status ;;
  install) install_hook ;;
  uninstall) down; sudo rm -f "$HOOK"; echo "removed $HOOK" ;;
  supervise) supervise ;;
  *) echo "usage: $0 up|down|restart|status|install|uninstall|supervise" >&2; exit 2 ;;
esac
