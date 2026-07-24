#!/usr/bin/env bash
# smoke-create.sh — smoke test for `copperhead create` pipeline
#
# Prerequisites:
#   1. KiCad >= 8 installed (kicad-cli on PATH)
#   2. An LLM provider configured (--model or env var)
#   3. Node >= 20, npm dependencies installed
#
# Run from the repo root:
#   bash manual-tests/smoke-create.sh
#
# This test drives the pipeline on the simplest brief (USB‑C breakout) and
# checks that all 8 stages produce their expected artifacts.  It is intended
# for CI runs that have KiCad available but want a low-cost smoke gate.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

BRIEF="examples/simple/usb-c-breakout.md"
MODEL="${COPPERHEAD_MODEL:-claude-code}"
RUN_DIR=".copperhead/runs"

echo "═══ smoke: copperhead create ($MODEL) ═══"

# 1. Build the CLI
npm run build 2>&1 | tail -1

# 2. Verify kicad-cli is reachable
kicad-cli version 2>&1 | head -1

# 3. Create a temp repo with the brief
TMPDIR=$(mktemp -d /tmp/copperhead-smoke-XXXX)
cp "$BRIEF" "$TMPDIR/brief.md"
cd "$TMPDIR"
git init -q
git config user.email smoke@copperhead.local
git config user.name smoke
git add brief.md && git commit -q -m "brief"

# 4. Run the pipeline (stops on first failure)
echo "--- running create pipeline ---"
COPPERHEAD_NO_CACHE=1 copperhead create --brief brief.md --model "$MODEL" --plain 2>&1 | tee run.log

# 5. Check results
echo "--- checking stage artifacts ---"
FAIL=0
for f in docs/SPEC.md docs/SUBSYSTEMS.md docs/BOM.md docs/PINOUT.md docs/LAYOUT.md docs/DEVPLAN.md outputs firmware; do
  if [ -e "$f" ]; then
    echo "  ✓ $f"
  else
    echo "  ✗ $f MISSING"
    FAIL=1
  fi
done

if [ "$FAIL" = 1 ]; then
  echo "═══ SMOKE FAILED ═══"
  exit 1
fi
echo "═══ SMOKE PASSED ═══"
exit 0
