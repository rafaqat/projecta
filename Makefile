# Commands listed in CLAUDE.md. Every target is thin: the logic lives in
# Ace commands or scripts so CI and local runs execute the same code.

# COMPOSE_EXTRA adds overlays (CI: -f docker/compose.ci-cache.yml for the registry layer cache).
COMPOSE := docker compose --env-file .env -f docker/compose.yml $(COMPOSE_EXTRA)
WP ?= 00
# Compose profiles: `test` (mock OIDC) by default; add `keycloak` for a real
# identity provider, e.g. `make up PROFILES=test,keycloak`.
PROFILES ?= test
comma := ,
PROFILE_FLAGS := $(foreach p,$(subst $(comma), ,$(PROFILES)),--profile $(p))

# A redeploy must CONSERVE the running stack's provider selections. OIDC_ISSUER_LOCAL (real IdP vs
# the mock) and MODEL_SERVER_URL (GPU host server vs in-process) are chosen by shell env at `up`
# time — compose.yml reads `$${VAR:-default}` — so a bare recreate re-defaults them and silently
# reverts web/worker to the mock OIDC and the in-process model backend. When redeploy is the goal,
# read them back from the running web container and re-export, so the recipe AND the prereqs
# (model-backend-guard) inherit them. An explicit env still wins (?=); empty when the stack is down
# or already on the mock default, so it falls back to .env exactly like a fresh `make up`.
ifneq (,$(filter redeploy,$(MAKECMDGOALS)))
RUNNING_WEB := $(shell $(COMPOSE) ps -q web 2>/dev/null)
ifneq (,$(RUNNING_WEB))
RUNNING_ENV := $(shell docker inspect $(RUNNING_WEB) --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null)
OIDC_ISSUER_LOCAL ?= $(filter-out http://mock-oidc:9000,$(patsubst OIDC_ISSUER=%,%,$(filter OIDC_ISSUER=%,$(RUNNING_ENV))))
MODEL_SERVER_URL ?= $(patsubst MODEL_SERVER_URL=%,%,$(filter MODEL_SERVER_URL=%,$(RUNNING_ENV)))
export OIDC_ISSUER_LOCAL
export MODEL_SERVER_URL
endif
endif

.PHONY: setup doctor seed workspace uat robustness up up-keycloak up-gpu stop-gpu down bridge unbridge build redeploy models model-server lint typecheck test check check-suites evals redteam redteam-generate redteam-discover redteam-import-moonshot scan

# First run, in one go: preconditions, .env, models, images, the stack, and the seed that
# gives the dev identities a workspace. Safe to run again (every step is idempotent).
setup: doctor .env models build up seed
	@echo
	@echo "Ready. Sign in at http://localhost:3333 (mock provider; developer@example.test)."
	@echo "Keycloak (Entra-style) instead: make up-keycloak, then developer / developer."
	@echo "Grafana: http://localhost:3000/d/cia-observability"

doctor:  ## check Docker memory, /etc/hosts names, tools and ports
	sh scripts/doctor.sh

# The stack database from the host, for ace commands run outside Compose.
STACK_DB = DB_HOST=127.0.0.1 DB_PORT=$(POSTGRES_HOST_PORT)
# Tests run against the app_test database on the stack's Postgres (tests/bootstrap migrates it);
# the same database CI uses. Without it `node ace test` would hit the app database.
TEST_DB = $(STACK_DB) DB_DATABASE=app_test
# The functional suite needs the same environment CI sets: the fixture git host allowlisted, the
# in-process mock OIDC issuer, a database session store, the app URL and a fixed gateway policy seed.
# All test-only throwaway values, matching the CI workflows so `make test` reproduces CI locally.
TEST_ENV = $(TEST_DB) \
  APP_ENV=test APP_URL=http://localhost:4444 HOST=localhost PORT=4444 APP_VERSION=0.0.0 \
  GIT_ALLOWED_HOSTS=localhost:8443 \
  OIDC_ISSUER=http://127.0.0.1:9100 OIDC_ALLOWED_ISSUERS=http://127.0.0.1:9100 \
  OIDC_CLIENT_ID=projectA OIDC_CLIENT_SECRET=test-client-secret OIDC_ALLOWED_TENANTS=tenant-local \
  SESSION_DRIVER=database \
  GATEWAY_POLICY_SEED=1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809

seed: .env  ## dev identities and the "Local" workspace (APP_ENV=local only; idempotent)
	$(STACK_DB) node ace dev:seed

# make workspace NAME="Team A" OWNER=someone@example.test  (the owner must have signed in once)
workspace: .env
	$(STACK_DB) node ace workspace:create --name "$(NAME)" --owner "$(OWNER)"

# make uat WS=<workspace handle> REPO=<repository handle> [VARS=styleswap] [AREA="API endpoints"] [OWNER=email]
# Asks the UAT question pack (evals/cases/uat/questions.json) of an indexed repository through the
# stack's web container (real model, real spend) and classifies every answer; exit 1 on a failed
# turn. The run lands in tmp/uat/<REPO>-<timestamp>.json.
VARS ?= styleswap
UAT_OUT := tmp/uat/$(REPO)-$(shell date -u +%Y%m%dT%H%M%SZ).json
uat: .env
	@mkdir -p tmp/uat
	$(COMPOSE) exec -T web node ace uat:run --workspace "$(WS)" --repository "$(REPO)" --questions - \
	  --vars-json "$$(cat evals/cases/uat/vars/$(VARS).json)" $(if $(AREA),--area "$(AREA)",) $(if $(OWNER),--owner "$(OWNER)",) --out /tmp/uat-run.json \
	  < evals/cases/uat/questions.json; status=$$?; \
	$(COMPOSE) cp web:/tmp/uat-run.json $(UAT_OUT) >/dev/null 2>&1 && echo "run: $(UAT_OUT)"; exit $$status

# Pull the pinned third-party images here so `make up` starts from a warm
# cache on a fresh machine; its 180-second budget covers startup, not downloads.
# Pinned model files (models.lock.json); verified by SHA-256, never fetched at runtime.
models:
	node scripts/fetch-models.mjs

# make robustness WS=<workspace handle> OWNER=<email> [ONLY=slug,slug] [ANSWERS=1] [RESUME=1]
# RESUME=1 carries the measurements left in the worker's report: a run cut short starts again at
# the repository it died on, rather than paying for the ones already measured.
# The robustness tier (ADR-039, WP-24): each pinned corpus repository ingested at its commit and
# judged by invariants. Runs in the worker container, where ingest runs. The report lands in
# tmp/robustness/; it becomes evals/runs/robustness-latest.json only through a pull request
# (ADR-011). ANSWERS=1 also asks the UAT pack, which spends model tokens.
# The image carries neither the corpus nor the pack, and the worker's /tmp is a tmpfs on a
# read-only root that `docker cp` cannot reach, so the inputs go in as a tar stream and the
# report comes out through `cat`; a report that cannot be read back fails the target.
# Everything the run logs is teed to tmp/robustness/*.log, whatever the caller does with stdout: the
# first paid run was piped through a filter that dropped the JSON lines, and with them the code and
# hash of the turn that failed (2026-09-20). The pipe's status file keeps the run's exit code.
robustness: .env
	@mkdir -p tmp/robustness
	@COPYFILE_DISABLE=1 tar -cf - config/robustness.json evals/cases/uat | \
	  $(COMPOSE) exec -T worker sh -c 'rm -rf /tmp/robustness-in $(if $(RESUME),,/tmp/robustness.json) && mkdir /tmp/robustness-in && tar -xf - -C /tmp/robustness-in' \
	  || { echo "robustness: could not stream the inputs into the worker" >&2; exit 1; }; \
	log=tmp/robustness/robustness-$$(date -u +%Y%m%dT%H%M%SZ).log; \
	{ $(COMPOSE) exec -T worker node ace robustness:run --inputs /tmp/robustness-in \
	  --workspace "$(WS)" --owner "$(OWNER)" $(if $(ONLY),--only "$(ONLY)",) $(if $(ANSWERS),--answers,) \
	  $(if $(RESUME),--resume,) \
	  --out /tmp/robustness.json; echo $$? > "$$log.status"; } 2>&1 | tee "$$log"; \
	status=$$(cat "$$log.status" || echo 1); rm -f "$$log.status"; \
	echo "log: $$log"; \
	$(MAKE) --no-print-directory robustness-report || exit 1; \
	exit $$status

# Read the report back out of the worker, whose /tmp is a tmpfs `docker cp` cannot reach. Its own
# target because the command writes the report after every repository: a run cut short — CI's step
# budget, a cancelled job — leaves the measurements already taken in there to be rescued.
robustness-report: .env
	@mkdir -p tmp/robustness
	@out=tmp/robustness/robustness-$$(date -u +%Y%m%dT%H%M%SZ).json; \
	if $(COMPOSE) exec -T worker cat /tmp/robustness.json > "$$out"; then \
	  echo "report: $$out ($$(node -e 'const r=require(process.argv[1]);console.log((r.complete?"complete":"partial")+", "+r.repositories.length+" measured")' "$$PWD/$$out"))"; \
	else rm -f "$$out"; echo "robustness: no report to read back from the worker" >&2; exit 1; fi

# The model server (ADR-040): the embedder and the injection classifier on the host's GPU,
# behind one URL. `make model-server` runs it in the foreground; set MODEL_SERVER_URL in .env
# (see .env.example) and restart web and worker to use it. Python via uv, locked.
model-server: models  ## run the model server on this machine's GPU (Metal/CUDA) or CPU
	cd services/model-server && uv sync -q && cd ../.. && \
	  MODELS_DIR=models MODELS_LOCK=models.lock.json services/model-server/.venv/bin/python services/model-server/server.py

# Every image the tests and conformance need, so they find them built: the test target
# (WP-01's positive control) and the conformance overlay's git fixture as well.
build: .env models
	$(COMPOSE) $(PROFILE_FLAGS) pull --ignore-buildable
	$(COMPOSE) $(PROFILE_FLAGS) build
	docker build --target app-test -t cia-app-test -f docker/Dockerfile .
	$(COMPOSE) -f docker/compose.conformance.yml --profile test build git-fixture

# Rebuild the application images and put them in front of a gateway that will accept them.
# The order is the point: `configHash` covers the prompts, app/parse/profiles/*.ts,
# config/scope-policy.json and the model pins, so a build that changes any of them makes the
# running gateway reject every model call with `allowlist.config_hash_unvalidated` — which the
# interface shows as "unvalidated configuration" and nothing names as a stale policy. Signing
# the policy and restarting the gateway is what makes the new hash allowed.
# COMPOSE_PARALLEL_LIMIT=1 keeps the twelve-target build inside a laptop's memory.
# A model server answering on the host while the app would run in-process is a misconfiguration
# that costs a 6x slower ingest and starves the worker (2026-09-21, three times in one night).
# Refuses unless ALLOW_INPROCESS=1 says the CPU path is meant.
model-backend-guard: .env
	@resolved=$$($(COMPOSE) config 2>/dev/null | grep -m1 'MODEL_SERVER_URL:' | sed -E 's/.*MODEL_SERVER_URL: *//; s/^"(.*)"$$/\1/; s/^'"'"'(.*)'"'"'$$/\1/'); \
	if [ -z "$$resolved" ] && [ "$(ALLOW_INPROCESS)" != "1" ] && curl -fs -m 2 -o /dev/null http://127.0.0.1:8765/healthz; then \
	  echo 'model-backend-guard: a model server answers on 127.0.0.1:8765 but MODEL_SERVER_URL resolves empty; set it in .env (MODEL_SERVER_URL=http://host.docker.internal:8765) or pass ALLOW_INPROCESS=1'; exit 1; \
	fi

redeploy: .env model-backend-guard  ## rebuild, re-sign the gateway policy, reload the gateway and app, verify attribution
	COMPOSE_PARALLEL_LIMIT=1 $(MAKE) build
	# Pre-task (sign): re-sign the on-disk policy (what attribution-guard --check validates) AND, via the
	# gateway-policy init service, the shared /policy volume the gateway actually reads. Both are produced
	# from the same APP_KEY+SEED, so they are byte-identical (Ed25519 signatures are deterministic).
	node ace gateway:policy
	# Force-recreate (not restart) so the gateway loads BOTH the new image and the freshly re-signed policy.
	# Recreating the gateway-policy init alongside it re-signs the VOLUME first; the gateway's depends_on
	# gateway-policy:service_completed_successfully blocks it until that finishes. (Recreating the gateway
	# alone with --no-deps skipped the init, so the volume kept a stale policy and a rebuilt app hit
	# attribution_invalid — the exact drift this target exists to prevent.)
	$(COMPOSE) $(PROFILE_FLAGS) up -d --force-recreate gateway-policy llm-gateway
	$(COMPOSE) $(PROFILE_FLAGS) up -d --no-deps --wait --wait-timeout 120 llm-gateway
	$(COMPOSE) $(PROFILE_FLAGS) up -d --wait --wait-timeout 180 web worker
	# Post-task (verify): fail loudly if the signed policy no longer matches this APP_KEY / config.
	$(MAKE) attribution-guard
	@echo 'rebuilt, policy re-signed (disk + volume), provider selections preserved (OIDC + model backend), gateway reloaded, app restarted, attribution verified'

# Fail loudly if the on-disk gateway policy no longer matches this APP_KEY / config — the drift that
# makes the gateway 401 every model call. Runs after every redeploy; run it by hand to diagnose.
attribution-guard: .env
	node ace gateway:policy --check

# tmp/otel receives the Collector's file export; the collector runs as an
# unprivileged uid, so the bind mount must be writable by anyone on Linux.
policy: .env  ## write and sign config/gateway-policy.json for the local stack
	node ace gateway:policy

up: .env model-backend-guard policy
	mkdir -p tmp/otel && chmod 0777 tmp/otel
	$(COMPOSE) $(PROFILE_FLAGS) up -d --wait --wait-timeout 180
	@if [ "$$(grep -E '^APP_ENV=' .env | cut -d= -f2)" = "local" ]; then \
		echo 'seeding dev identities + Local workspace (idempotent)'; \
		$(STACK_DB) node ace dev:seed; \
	fi

# Bring the stack up on the Entra-style Keycloak provider instead of the mock.
# The mock stays the default for `make up` (the functional tests sign in through it
# headlessly). Sign in as developer / developer.
up-keycloak:
	OIDC_ISSUER_LOCAL=http://keycloak:8080/realms/cia $(MAKE) up PROFILES=test,keycloak

# One command for the GPU embedding path: start the host model server (Metal/CUDA,
# ADR-040), wait for it, then bring the stack up pointed at it. Keeps the Entra-style
# Keycloak provider (via up-keycloak) — it never reverts local auth to the mock. The
# server runs on the host because Docker can't pass through the GPU; its log and PID
# land in tmp/. Stop the server with `make stop-gpu`; plain `make up` returns to CPU.
up-gpu:
	@mkdir -p tmp
	@if curl -fs -m 2 -o /dev/null http://127.0.0.1:8765/healthz; then \
	  echo 'model server already running on :8765'; \
	else \
	  echo 'starting host model server (GPU: Metal/CUDA) -> tmp/model-server.log'; \
	  nohup $(MAKE) model-server >tmp/model-server.log 2>&1 & echo $$! >tmp/model-server.pid; \
	  printf 'waiting for :8765/healthz '; \
	  for i in $$(seq 1 90); do \
	    if curl -fs -m 2 -o /dev/null http://127.0.0.1:8765/healthz; then echo 'ready'; break; fi; \
	    printf '.'; sleep 2; \
	    if [ "$$i" = "90" ]; then echo; echo 'timed out; see tmp/model-server.log'; exit 1; fi; \
	  done; \
	fi
	MODEL_SERVER_URL=http://host.docker.internal:8765 $(MAKE) up-keycloak

# Stop the host model server started by `make up-gpu` (the stack keeps running on
# CPU until the next `make up`/`make redeploy` without MODEL_SERVER_URL set).
stop-gpu:
	@pkill -f 'model-server/server.py' 2>/dev/null && echo 'model server stopped' || echo 'no model server running'
	@rm -f tmp/model-server.pid

# The gateway sits on the internal network only, so a run from source (redteam:run --live,
# evals:smoke) cannot reach it. This publishes it on 127.0.0.1:8787 through a socat sidecar for
# as long as you need it. It is a hole in the stack's isolation on purpose: bring it up for a
# run, take it down after. Never in CI, never on a shared host.
bridge:
	docker run --rm -d --name cia-gw-bridge --network cia_internal \
	  -p 127.0.0.1:8787:8787 alpine/socat TCP-LISTEN:8787,fork,reuseaddr TCP:llm-gateway:8787
	docker network connect cia_ingress cia-gw-bridge
	@printf 'gateway on 127.0.0.1:8787 → '
	@curl -s -m 5 -o /dev/null -w '%{http_code} (401 is the gateway asking for attribution: ready)\n' \
	  -X POST http://127.0.0.1:8787/v1/messages -d '{}' || echo 'unreachable'
	@echo 'run `make unbridge` when you are done'

unbridge:
	-docker rm -f cia-gw-bridge
	@curl -s -m 3 -o /dev/null http://127.0.0.1:8787/v1/messages && echo 'still reachable' || echo 'gateway unreachable from the host again'

down:
	$(COMPOSE) --profile test --profile keycloak down --volumes --remove-orphans

lint:
	npm run lint

typecheck:
	npm run typecheck

test:
	$(TEST_ENV) node ace test

# The sanity tier (owner 2026-09-15): what a push must pass before anything else — lint, types,
# and the unit and structural suites, where the deterministic logic lives. Runs against the
# laptop stack's Postgres in about three minutes; CI runs the same in sanity.yml.
check: .env lint typecheck check-suites  ## the quick check: lint, types, unit + structural suites

check-suites: .env
	$(TEST_ENV) node ace test unit structural

# The deterministic eval suites: the correctness, robustness and adversarial tiers over the
# committed cases (evals/harness). DB-free — reads the cases, computes each tier's metrics,
# writes evals/runs/latest.json and ratchets against evals/baselines/baseline.json. Same
# entrypoint as `npm run evals`; the ratchet canary tests run under `npm run test:evals`.
evals:
	node evals/harness/run.ts

# The stack database as seen from the host, as the application role (never a superuser: the
# boot guard refuses one outside local, and tenancy must not depend on a bypass).
# The ingress publishes Postgres on POSTGRES_HOST_PORT (5432 unless .env says otherwise).
POSTGRES_HOST_PORT ?= $(shell sed -n 's/^POSTGRES_HOST_PORT=//p' .env 2>/dev/null)
ifeq ($(POSTGRES_HOST_PORT),)
POSTGRES_HOST_PORT := 5432
endif

redteam: .env  ## structural red-team regression with ablations
	node ace redteam:run

# Offline / UAT only (design §12): (re)generate the PyRIT converter attack variants from the
# committed seeds into evals/redteam/generated/pyrit-variants.json (base64-encoded), for HUMAN
# review before promotion into the frozen adversarial set (R-06/R-08 — this target never promotes).
# Not run in CI: the deterministic adversarial eval consumes the already-promoted variants.json.
# Deps are pinned in evals/redteam/tools/uv.lock and installed on demand into a local (gitignored)
# .venv; requires uv.
redteam-generate:
	uv --directory evals/redteam/tools run pyrit_variants.py

# Offline / UAT only (ADR-0006, Architecture A): bridge the PyRIT-generated variants into a
# CANDIDATE live case file. Run `make redteam-generate` first. Then execute + score against the
# running assistant with the existing live lane (needs an indexed workspace/repo + real model):
#   node ace redteam:run --live --workspace <ws> --repository <repo> \
#     --cases evals/redteam/generated/discovered-cases.json \
#     --variants evals/redteam/generated/pyrit-variants.json
# Breaches are candidates only; a person promotes them into cases/regression.json (R-06/R-08).
redteam-discover:
	node ace redteam:discover

# Offline / UAT only (ADR-0008): fetch the MIT-licensed Moonshot corpora (CyberSecEval prompt
# injection + jailbreak-DAN, see evals/redteam/tools/moonshot_datasets.md) and stage them as attack
# variants over this product's seeds -> evals/redteam/generated/moonshot-variants.json. Feed them to
# the discovery live lane the same way as PyRIT:
#   node ace redteam:run --live --workspace <ws> --repository <repo> \
#     --cases evals/redteam/generated/discovered-cases.json \
#     --variants evals/redteam/generated/moonshot-variants.json
# (run `node ace redteam:discover --variants evals/redteam/generated/moonshot-variants.json` first to
# build the candidate case file). Breaches are candidates only; a person promotes them (R-06/R-08).
redteam-import-moonshot:
	uv --directory evals/redteam/tools run moonshot_import.py

# Local environment file from the example, with a generated APP_KEY.
.env:
	cp .env.example .env
	node ace generate:key

scan:
	scripts/scan.sh
