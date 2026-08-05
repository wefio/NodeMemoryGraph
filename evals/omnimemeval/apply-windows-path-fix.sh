#!/usr/bin/env bash
# Apply the Windows bash->python env-file path fix to the vendored
# OmniMemEval scripts (.benchmarks/ is gitignored, so the fix cannot be
# committed in-tree — this idempotent script re-applies it after any
# checkout/update).
#
# Root cause: _experiment_utils.sh builds OMNIMEMEVAL_ENV_FILE with plain
# 'pwd', which in git-bash (MSYS2) emits POSIX /c/... paths. Native Windows
# Python silently fails to open them (python-dotenv returns False without
# error), so NMG_ROOT/ANSWER_MODEL/... are never loaded.
#
# Fix:  pwd -W 2>/dev/null || pwd
# (pwd -W is a git-bash/MSYS extension emitting Windows C:/... paths; on
# Linux/WSL it fails and falls back to plain pwd — cross-platform, no WSL
# dependency.)
#
# Usage: bash evals/omnimemeval/apply-windows-path-fix.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FILE="$ROOT/.benchmarks/official/OmniMemEval/scripts/_experiment_utils.sh"

if [[ ! -f "$FILE" ]]; then
    echo "FAIL: $FILE not found (OmniMemEval vendored scripts missing?)"
    exit 1
fi

if grep -q 'pwd -W 2>/dev/null || pwd' "$FILE"; then
    echo "already applied: $FILE"
    exit 0
fi

# Guard: verify the upstream pattern we expect to patch is still intact.
if ! grep -q 'OMNIMEMEVAL_ENV_FILE="$(cd "$(dirname "$2")" && pwd)/' "$FILE"; then
    echo "FAIL: expected upstream pattern not found — OmniMemEval scripts changed;"
    echo "      update this script (evals/omnimemeval/apply-windows-path-fix.sh)."
    exit 1
fi

sed -i 's|&& pwd)/$(basename|&& pwd -W 2>/dev/null || pwd)/$(basename|g' "$FILE"

if grep -q 'pwd -W 2>/dev/null || pwd' "$FILE"; then
    echo "applied: $FILE"
else
    echo "FAIL: replacement did not take effect"
    exit 1
fi

# Verify the whole chain end-to-end via the scanner.
echo "verifying with scan-path-issues.py ..."
python "$ROOT/evals/omnimemeval/scan-path-issues.py" >/dev/null 2>&1 && echo "scan: PASS" || echo "scan: FAIL (check manually)"
