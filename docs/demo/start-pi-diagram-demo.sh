#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)

for command in d2 pi; do
  command -v "$command" >/dev/null || {
    printf 'Missing required command: %s\n' "$command" >&2
    exit 1
  }
done

printf '\n== Pi starts with only the local diagram extension loaded ==\n\n'
cd "$project_root"
pi \
  --no-extensions \
  --extension "$project_root/src/index.ts" \
  --no-session
