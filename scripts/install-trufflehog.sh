#!/usr/bin/env bash
# Installs TruffleHog, pinned by version and SHA-256 (ADR-027). Single source of the pin: called both by
# scripts/install-scanners.sh (so `make scan` has it) and by the compiled-build job, which scans the
# image payload (build/) for secrets baked into what actually ships — a surface a git-history scan
# (gitleaks) does not cover.
set -euo pipefail

TRUFFLEHOG_VERSION=${TRUFFLEHOG_VERSION:-3.97.9}
TRUFFLEHOG_SHA256=${TRUFFLEHOG_SHA256:-40377e6572495412fb9ba0bc21c9401f73b72f1d2afd11b9931bc4a5ed622866}

if command -v trufflehog >/dev/null 2>&1 &&
  [ "$(trufflehog --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)" = "$TRUFFLEHOG_VERSION" ]; then
  exit 0
fi

tmp=$(mktemp -d)
curl -sSfL -o "$tmp/trufflehog.tgz" \
  "https://github.com/trufflesecurity/trufflehog/releases/download/v${TRUFFLEHOG_VERSION}/trufflehog_${TRUFFLEHOG_VERSION}_linux_amd64.tar.gz"
echo "${TRUFFLEHOG_SHA256}  $tmp/trufflehog.tgz" | sha256sum -c -
tar -xzf "$tmp/trufflehog.tgz" -C "$tmp" trufflehog
sudo install -m 0755 "$tmp/trufflehog" /usr/local/bin/trufflehog
rm -rf "$tmp"
