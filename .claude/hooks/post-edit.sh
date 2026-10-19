#!/usr/bin/env bash
# PostToolUse: deno lint on the edited TS file only. No formatter: the code has no agreed style yet.
# Silent when deno is not installed.
set -u
command -v jq >/dev/null 2>&1 || exit 0
f=$(jq -r '.tool_input.file_path // empty')
case "$f" in *.ts|*.js|*.mjs) ;; *) exit 0 ;; esac
case "$f" in */node_modules/*|*/db/drizzle/migrations/*) exit 0 ;; esac
[ -f "$f" ] || exit 0
command -v deno >/dev/null 2>&1 || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
if ! out=$(NO_COLOR=1 deno lint "$f" 2>&1); then
  echo "deno lint errors in $f (fix them, or say why they are pre-existing):" >&2
  echo "$out" | tail -n 40 >&2
  exit 2
fi
exit 0
