#!/bin/sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  if [ -x "$PWD/.tools/node-v22.16.0-darwin-arm64/bin/node" ]; then
    PATH="$PWD/.tools/node-v22.16.0-darwin-arm64/bin:$PATH"
    export PATH
  else
    echo "Node.js 22.16以降をインストールしてから実行してください。" >&2
    exit 1
  fi
fi
if [ ! -d node_modules ]; then npm ci; fi
exec npm run dev -- "$@"
