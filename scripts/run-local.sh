#!/usr/bin/env bash
# Manage the real host-user systemd service; no detached setsid supervisor.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
BOX=dev
UNIT=box-subgate.service
in_box() { [[ "${CONTAINER_ID:-}" == "$BOX" ]] || grep -qs "name=\"$BOX\"" /run/.containerenv; }
prepare_env() {
  in_box || { echo "run-local: not inside $BOX" >&2; return 1; }
  export HOME="${SUBGATE_HOME:-/home/v/dbx-homes/$BOX}"
  export PATH="$HOME/.local/bin:/home/v/.bun/bin:/home/v/.nvm/versions/node/v24.12.0/bin:/usr/local/bin:/usr/bin:/bin"
  unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL
  local bin
  for bin in bun claude; do
    command -v "$bin" >/dev/null || { echo "$bin not found on PATH" >&2; return 1; }
  done
}
manage() {
  if [[ -n "${AGENT_SESSION_ID:-}" ]] && command -v managed-service >/dev/null; then
    case "$1" in
      start|stop|restart|status) command managed-service subgate "$1" ;;
      *) echo 'Enabling/disabling units requires the administrative login.' >&2; return 2 ;;
    esac
  elif in_box; then
    command distrobox-host-exec /usr/bin/systemctl --user "$@" "$UNIT"
  else
    /usr/bin/systemctl --user "$@" "$UNIT"
  fi
}
case "${1:-}" in
  up) manage start ;;
  down) manage stop ;;
  restart) manage restart ;;
  status) manage status --no-pager ;;
  install) manage enable --now ;;
  uninstall) manage disable --now ;;
  check-service) prepare_env ;;
  exec-service) prepare_env; exec bun src/cli.ts serve ;;
  supervise) echo 'Detached supervision retired; use scripts/run-local.sh up (systemd).' >&2; exit 2 ;;
  *) echo "usage: $0 up|down|restart|status|install|uninstall" >&2; exit 2 ;;
esac
