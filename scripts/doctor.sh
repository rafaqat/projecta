#!/usr/bin/env sh
# Preconditions for the local stack (`make doctor`, run first by `make setup`).
# Says exactly what to change; exits non-zero when something would stop the stack.
set -u
status=0

say() { printf '%s\n' "$*"; }
ok() { say "  ok    $*"; }
fix() { say "  FIX   $*"; status=1; }
warn() { say "  warn  $*"; }

say "Docker"
if docker info >/dev/null 2>&1; then
  mem=$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)
  gb=$(( mem / 1073741824 ))
  if [ "$gb" -ge 12 ]; then ok "Docker has ${gb} GB of memory"
  else fix "Docker has ${gb} GB of memory; the worker needs 12 GB or more at the index step (Docker Desktop → Settings → Resources → Memory → 16 GB)"; fi
else
  fix "Docker is not running"
fi

say "Names the browser must resolve (the identity providers are reached by their Compose names)"
for host in mock-oidc keycloak; do
  if grep -qE "^[^#]*[[:space:]]$host([[:space:]]|$)" /etc/hosts 2>/dev/null; then ok "$host is in /etc/hosts"
  else fix "$host is not in /etc/hosts: run   sudo sh -c 'echo \"127.0.0.1 $host\" >> /etc/hosts'"; fi
done

say "Tools"
for tool in node npm git; do
  if command -v "$tool" >/dev/null 2>&1; then ok "$tool $($tool --version 2>/dev/null | head -1)"
  else fix "$tool is not installed"; fi
done
if [ -f .nvmrc ] && command -v node >/dev/null 2>&1; then
  want=$(cat .nvmrc | tr -d 'v \n'); have=$(node --version | tr -d 'v')
  case "$have" in "$want"*) ;; *) warn "node is $have; .nvmrc says $want" ;; esac
fi

say "Ports"
for port in 3333 5433 8080 3000 9000; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    owner=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1}')
    case "$owner" in com.docke*|docker*|Docker*) ok "port $port is held by Docker (the stack)" ;; *) warn "port $port is held by $owner; the stack publishes it (Postgres on 5433 clashes with a native Postgres on 5432 only if POSTGRES_HOST_PORT is 5432)" ;; esac
  fi
done

say "Model server (ADR-040)"
url=$(sed -n 's/^MODEL_SERVER_URL=//p' .env 2>/dev/null | head -1)
if [ -z "$url" ]; then
  say "  info  MODEL_SERVER_URL is not set: the embedder and the classifier run in-process on CPU (make model-server for the GPU)"
else
  probe=$(printf '%s' "$url" | sed 's#model-server.host#127.0.0.1#; s#host.docker.internal#127.0.0.1#')
  health=$(curl -sS --max-time 3 "$probe/healthz" 2>/dev/null)
  case "$health" in
    *'"device"'*) ok "model server at $url serves $(printf '%s' "$health" | sed -n 's/.*"device": *"\([^"]*\)".*/\1/p') ($(printf '%s' "$health" | sed -n 's/.*"backend": *"\([^"]*\)".*/\1/p'))" ;;
    *) warn "MODEL_SERVER_URL=$url but nothing answers at $probe/healthz; run make model-server, or unset it to index in-process" ;;
  esac
fi

[ "$status" -eq 0 ] && say "All preconditions met." || say "Fix the lines marked FIX, then run make setup again."
exit "$status"
