#!/bin/zsh

set -u

STATE="${1:-idle}"
MESSAGE="${2:-Codex status changed}"
LOG_FILE="/Users/leoclaw/Documents/AgentLight/agent-status-light/logs/codex-hook.log"
STDIN_PAYLOAD="$(cat)"
REPORTER="/Users/leoclaw/Documents/AgentLight/agent-status-light/scripts/codex-hook-reporter.js"

if [[ "$STDIN_PAYLOAD" == *'"hook_event_name"'* && "$STDIN_PAYLOAD" == *'"Stop"'* ]]; then
  STATE="done"
  MESSAGE="Codex finished"
fi

mkdir -p "$(dirname "$LOG_FILE")"
printf '[%s] legacy hook forwarding state=%s message=%s cwd=%s\n' \
  "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  "$STATE" \
  "$MESSAGE" \
  "$PWD" >> "$LOG_FILE"

printf '%s' "$STDIN_PAYLOAD" | node "$REPORTER" "$STATE" "$MESSAGE" >> "$LOG_FILE" 2>&1
exit 0
