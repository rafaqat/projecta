#!/usr/bin/env bash
# Payload marker scan (ADR-013, T-18, AC-WP10-01): adversarial payloads carry an
# `RT-MARK-` marker. It may appear in plaintext only inside the files that
# generate or check it; everywhere else it means a payload was decoded into
# the repository. Exit 1 on any hit.
set -euo pipefail
allow='^(evals/redteam/(seeds\.json|generated/|fixtures/)|app/redteam/(payloads|runner)\.ts|scripts/payload-scan\.sh|tests/functional/redteam/|docs/build-plan\.md|tmp/)'
hits=$(git grep -n -I -e 'RT-MARK-' -- ':!*.png' 2>/dev/null | grep -Ev "^($allow)" || true)
if [ -n "$hits" ]; then
  echo "plaintext payload markers found outside encoded fixture files:" >&2
  echo "$hits" >&2
  exit 1
fi
echo "payload-scan: no plaintext payload markers outside encoded files"
