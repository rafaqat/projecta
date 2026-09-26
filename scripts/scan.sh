#!/usr/bin/env bash
# Runs every pull-request scanner (ADR-027). The same script runs locally via
# `make scan` and in the `scan` CI job, so a finding fails both the same way.
set -euo pipefail
cd "$(dirname "$0")/.."

status=0
run() {
  local name=$1; shift
  echo "==> $name"
  if "$@"; then echo "    $name: ok"; else echo "    $name: FAILED"; status=1; fi
}

run gitleaks      gitleaks git --no-banner --redact --config .gitleaks.toml --log-opts="HEAD" .
run osv-scanner   osv-scanner scan --lockfile package-lock.json --lockfile services/audit-writer/package-lock.json --lockfile services/llm-gateway/package-lock.json
run lockfile-lint npx --no-install lockfile-lint --path package-lock.json --type npm \
                    --allowed-hosts npm --validate-https
run lockfile-lint-audit-writer npx --no-install lockfile-lint --path services/audit-writer/package-lock.json --type npm \
                    --allowed-hosts npm --validate-https
run lockfile-lint-llm-gateway npx --no-install lockfile-lint --path services/llm-gateway/package-lock.json --type npm \
                    --allowed-hosts npm --validate-https
run semgrep       semgrep scan --config semgrep/ --error --quiet --metrics=off .
run zizmor        zizmor --min-severity low .github/workflows
run payload-scan  scripts/payload-scan.sh

exit $status
