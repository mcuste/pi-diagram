#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)

for command in d2 omp; do
  command -v "$command" >/dev/null || {
    printf 'Missing required command: %s\n' "$command" >&2
    exit 1
  }
done

cd "$project_root"
omp \
  --extension "$project_root/packages/plugin/dist/extension.js" \
  --no-session
