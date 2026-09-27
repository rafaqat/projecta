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

# Lockfiles to scan. A slice branch may not have introduced the services yet (audit-writer and
# llm-gateway arrive in slice 4), so scan only the lockfiles present in THIS tree: every slice stays
# green on its own, and main still covers the full set. The root lockfile is always present.
LOCKFILES=(package-lock.json services/audit-writer/package-lock.json services/llm-gateway/package-lock.json)
osv_args=()
for lf in "${LOCKFILES[@]}"; do
  [ -f "$lf" ] && osv_args+=(--lockfile "$lf")
done
run osv-scanner   osv-scanner scan "${osv_args[@]}"

run lockfile-lint npx --no-install lockfile-lint --path package-lock.json --type npm \
                    --allowed-hosts npm --validate-https
for svc in audit-writer llm-gateway; do
  lf="services/$svc/package-lock.json"
  if [ -f "$lf" ]; then
    run "lockfile-lint-$svc" npx --no-install lockfile-lint --path "$lf" --type npm \
                    --allowed-hosts npm --validate-https
  else
    echo "==> lockfile-lint-$svc"; echo "    lockfile-lint-$svc: skipped (not in this slice)"
  fi
done
run semgrep       semgrep scan --config semgrep/ --error --quiet --metrics=off .
run zizmor        zizmor --min-severity low .github/workflows
run payload-scan  scripts/payload-scan.sh

exit $status
