#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
failed=0

report_matches() {
  local label="$1"
  local pattern="$2"
  local matches
  matches="$(rg -l --hidden -i --glob '!.git/**' --glob '!scripts/**' "${pattern}" "${repo_root}" || true)"
  if [[ -n "${matches}" ]]; then
    echo "${label}:" >&2
    echo "${matches}" >&2
    failed=1
  fi
}

report_matches "Possible secrets" '(^|[^A-Za-z0-9])sk-[a-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY|authorization:[[:space:]]*bearer[[:space:]]+[^[:space:]]+'
report_matches "Personal absolute paths" '/Users/|/home/[^/]+/|C:\\Users\\'
report_matches "Private contact data" '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(\+?86[- ]?)?1[3-9][0-9]{9}'
report_matches "Unresolved Obsidian links" '\[\[[^]]+\]\]'

if [[ -e "${repo_root}/AI Agent Evaluation/Agent评测漫谈 —— 由浅入深讲解Agent评测.md" ]]; then
  echo "Third-party article body must not be published." >&2
  failed=1
fi

if [[ -d "${repo_root}/AI Agent Evaluation/_assets/Agent评测漫谈" ]]; then
  echo "Third-party article images must not be published." >&2
  failed=1
fi

if [[ "${failed}" -ne 0 ]]; then
  exit 1
fi

node "${repo_root}/scripts/check-local-links.mjs"

echo "Public repository checks passed."
