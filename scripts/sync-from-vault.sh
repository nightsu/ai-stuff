#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${AI_NOTES_VAULT_ROOT:-}" ]]; then
  echo "Set AI_NOTES_VAULT_ROOT to the Obsidian vault root." >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_root="${AI_NOTES_VAULT_ROOT}/Tech Notes/AI & LLM"

if [[ ! -d "${source_root}" ]]; then
  echo "Source directory not found: ${source_root}" >&2
  exit 1
fi

sync_dir() {
  local name="$1"
  shift
  rsync -a --delete "$@" "${source_root}/${name}/" "${repo_root}/${name}/"
}

sync_dir "Agent Runtime 与工作流设计"
sync_dir "AI Agent Evaluation" \
  --exclude="Agent评测漫谈 —— 由浅入深讲解Agent评测.md" \
  --exclude="_assets/Agent评测漫谈/" \
  --exclude="THIRD_PARTY_SOURCES.md"
sync_dir "AI Agent 设计与源码研究（2026）"
sync_dir "Bubble List 自动滚动源码学习"
sync_dir "流式 Markdown 渲染器源码学习"

node "${repo_root}/scripts/normalize-markdown-links.mjs"
"${repo_root}/scripts/check-public.sh"

echo "Sync complete. Review git diff before committing."
