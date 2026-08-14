#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

finish() {
  status=$?
  if [[ -t 0 && "${WORKBENCH_INSTALL_NO_PAUSE:-0}" != "1" ]]; then
    echo
    if [[ $status -eq 0 ]]; then
      read -r -p "部署流程完成。按回车关闭此窗口……" _ || true
    else
      read -r -p "部署已停止，请查看上方原因。按回车关闭此窗口……" _ || true
    fi
  fi
  exit $status
}
trap finish EXIT

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "此安装入口仅支持 macOS。" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "未找到 Git。请先安装 Xcode Command Line Tools：xcode-select --install" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "仓库存在已跟踪文件修改，未自动切换或更新分支。" >&2
  exit 1
fi

git fetch origin main
branch="$(git branch --show-current)"
if [[ "$branch" != "main" ]]; then
  if git show-ref --verify --quiet refs/heads/main; then
    git switch main
  else
    git switch -c main --track origin/main
  fi
fi
git pull --ff-only origin main

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [[ -x "$candidate" ]]; then NODE_BIN="$candidate"; break; fi
  done
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "未找到 Node.js。Personal AI Workbench 2.0 需要 Node.js 24+。" >&2
  exit 1
fi

node_major="$($NODE_BIN -p "Number(process.versions.node.split('.')[0])")"
if [[ "$node_major" -lt 24 ]]; then
  echo "当前 Node.js 版本为 $($NODE_BIN --version)，需要 v24 或更高。" >&2
  exit 1
fi

"$NODE_BIN" scripts/macos-bootstrap.mjs "$@"
