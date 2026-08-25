#!/bin/bash
# Simple unattended entry point for launchd or another local scheduler.
set -uo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
JOBOPS_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$JOBOPS_DIR" || exit 1

mkdir -p logs
LOG_PATH="logs/daily-$(date +%F).log"

{
  echo "=== jobOps run: $(date) ==="
  npm run jobs
  RUN_EXIT=$?
  echo "jobOps exit code: $RUN_EXIT"
  echo "=== done: $(date) ==="
  exit "$RUN_EXIT"
} >> "$LOG_PATH" 2>&1
