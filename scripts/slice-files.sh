#!/usr/bin/env bash
# List files added / deleted / modified in each slice commit.
# Usage:
#   scripts/slice-files.sh            # summary counts per slice
#   scripts/slice-files.sh -v         # full file list per slice
#   scripts/slice-files.sh -v A       # only Added files per slice (A|D|M)
#   scripts/slice-files.sh main       # walk a specific branch/ref's history
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

VERBOSE=0; FILTER=""; REF="HEAD"
for a in "$@"; do
  case "$a" in
    -v) VERBOSE=1 ;;
    A|D|M) FILTER="$a" ;;
    *) REF="$a" ;;
  esac
done

# Slice commits = commits whose subject starts with "slice N:", oldest first.
prev=""
while IFS= read -r line; do
  sha="${line%% *}"; subj="${line#* }"
  base="${prev:-$(git hash-object -t tree /dev/null)}"   # empty tree for slice 0
  echo "════════════════════════════════════════════════════════"
  echo "▶ $subj   ($(git rev-parse --short "$sha"))"
  # A/D/M counts
  git diff --name-status "$base" "$sha" \
    | awk '{c[$1]++} END{printf "   added=%d deleted=%d modified=%d\n", c["A"], c["D"], c["M"]}'
  if [ "$VERBOSE" = 1 ]; then
    if [ -n "$FILTER" ]; then
      git diff --name-status --diff-filter="$FILTER" "$base" "$sha" | sed 's/^/   /'
    else
      git diff --name-status "$base" "$sha" | sed 's/^/   /'
    fi
  fi
  prev="$sha"
done < <(git log --reverse --format='%H %s' "$REF" | grep -E '^[0-9a-f]+ slice [0-9]+:')
