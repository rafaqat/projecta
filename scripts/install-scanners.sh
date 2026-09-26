#!/usr/bin/env bash
# Installs the pull-request scanners on a Linux runner, pinned by version and
# SHA-256 (ADR-027). Versions are the single source for CI and are checked
# against the local toolchain by `make scan` output.
set -euo pipefail

GITLEAKS_VERSION=${GITLEAKS_VERSION:-8.30.1}
GITLEAKS_SHA256=${GITLEAKS_SHA256:-551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb}
OSV_SCANNER_VERSION=${OSV_SCANNER_VERSION:-2.4.0}
OSV_SCANNER_SHA256=${OSV_SCANNER_SHA256:-15314940c10d26af9c6649f150b8a47c1262e8fc7e17b1d1029b0e479e8ed8a0}
SEMGREP_VERSION=${SEMGREP_VERSION:-1.157.0}
ZIZMOR_VERSION=${ZIZMOR_VERSION:-1.26.1}

tmp=$(mktemp -d)
curl -sSfL -o "$tmp/gitleaks.tgz" "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
echo "${GITLEAKS_SHA256}  $tmp/gitleaks.tgz" | sha256sum -c -
tar -xzf "$tmp/gitleaks.tgz" -C "$tmp" gitleaks && sudo install -m 0755 "$tmp/gitleaks" /usr/local/bin/gitleaks

curl -sSfL -o "$tmp/osv-scanner" "https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/osv-scanner_linux_amd64"
echo "${OSV_SCANNER_SHA256}  $tmp/osv-scanner" | sha256sum -c -
sudo install -m 0755 "$tmp/osv-scanner" /usr/local/bin/osv-scanner

pipx install "semgrep==${SEMGREP_VERSION}"
pipx install "zizmor==${ZIZMOR_VERSION}"
rm -rf "$tmp"
