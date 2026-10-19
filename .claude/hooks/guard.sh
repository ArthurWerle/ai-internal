#!/usr/bin/env bash
# PreToolUse guard: blocks reading secrets and editing generated or protected files.
# Exit 2 blocks the tool call; stderr is shown to Claude as the reason.
# Protected paths are listed in .claude/hooks/protected-paths.txt.

set -u
set -f # words below are matched as text, never expanded as globs
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
tool=$(jq -r '.tool_name // empty' <<<"$input")
root=${CLAUDE_PROJECT_DIR:-$(pwd)}
cd "$root" 2>/dev/null || exit 0

block() {
  echo "Blocked by .claude/hooks/guard.sh: $1" >&2
  exit 2
}

rel() {
  local p=$1
  p=${p#"$root"/}
  p=${p#./}
  printf '%s' "$p"
}

is_secret() {
  local base
  base=$(basename -- "$1")
  case "$base" in
    *.example|*.sample|*.template) return 1 ;;
    .env|.env.*|*.env|*.pem|*.key|*.p12|*.pfx|id_rsa*|id_ed25519*|credentials.json|.npmrc|.netrc) return 0 ;;
  esac
  return 1
}

secret_msg() {
  echo "'$1' holds secrets (API keys, DB passwords). Do not read it. Use the matching *.example file to learn which variables exist, or ask the user for the specific non-secret value you need."
}

check_protected() {
  local path list mode pattern reason
  path=$(rel "$1")
  list="$root/.claude/hooks/protected-paths.txt"
  [ -f "$list" ] || return 0
  while IFS='|' read -r mode pattern reason; do
    case "$mode" in ''|\#*) continue ;; esac
    # shellcheck disable=SC2053
    [[ $path == $pattern ]] || continue
    if [ "$mode" = tracked ]; then
      git ls-files --error-unmatch -- "$path" >/dev/null 2>&1 || continue
    fi
    block "'$path' is protected: $reason"
  done <"$list"
}

case "$tool" in
  Read|NotebookRead)
    f=$(jq -r '.tool_input.file_path // empty' <<<"$input")
    [ -n "$f" ] && is_secret "$f" && block "$(secret_msg "$(rel "$f")")"
    ;;
  Grep|Glob)
    # Grep's pattern is a regex over contents, so only its path and glob are paths
    fields='.tool_input.path // empty, .tool_input.glob // empty'
    [ "$tool" = Glob ] && fields="$fields, .tool_input.pattern // empty"
    for f in $(jq -r "$fields" <<<"$input"); do
      is_secret "$f" && block "$(secret_msg "$f")"
    done
    ;;
  Edit|Write|MultiEdit|NotebookEdit)
    f=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' <<<"$input")
    [ -z "$f" ] && exit 0
    is_secret "$f" && block "$(secret_msg "$(rel "$f")") Editing it is also blocked; tell the user which variable to change."
    check_protected "$f"
    ;;
  Bash)
    cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
    # Best effort: look for secret file names among the command's words.
    # `--env-file stack.env` and `--env-file=stack.env` are allowed: they hand the file to a tool without printing it.
    prev=
    for word in $(tr '|;&<>()`"'"'" ' ' <<<"$cmd"); do
      case "$prev" in --env-file|--env) prev=$word; continue ;; esac
      prev=$word
      case "$word" in -*) continue ;; esac
      is_secret "$word" && block "$(secret_msg "$word") This includes shell commands such as cat, grep, head, source or cp on it."
    done
    ;;
esac
exit 0
