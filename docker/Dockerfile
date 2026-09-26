# syntax=docker/dockerfile:1.7
# Multi-stage build (ADR-020, ADR-027). Production targets: web, worker,
# llm-gateway, audit-writer. Test targets (*-test) alone carry test modules
# and are never pushed to the production registry repository.
ARG NODE_IMAGE=node:24-trixie-slim@sha256:6950b66b4c0cb0151ce89fa75074673850763d096b044f422c6729b588dd4956

# ---------------------------------------------------------------- deps
FROM ${NODE_IMAGE} AS deps
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm rebuild re2

# ---------------------------------------------------------------- models
# Model weights are fetched once per builder into a BuildKit cache mount,
# verified against the pins in models.lock.json on every build (ADR-027,
# SEC-24), then copied into the image; the images never download at runtime.
# `models/` is excluded from the build context so the ~1.7 GB is never
# transferred per image target. The stage sees only the lockfile and the
# fetcher, so a source change never verifies or copies the weights again.
FROM ${NODE_IMAGE} AS models
WORKDIR /src
COPY models.lock.json ./
COPY scripts/fetch-models.mjs scripts/
# ONNX files only: the torch weights and code serve the model server on the host (ADR-040).
RUN --mount=type=cache,id=models,target=/models-cache,sharing=locked \
    MODELS_DIR=/models-cache MODELS_RUNTIME=onnx node scripts/fetch-models.mjs \
 && mkdir -p /models && cd /models-cache && find . -type f ! -name '*.safetensors' ! -name '*.py' -exec sh -c 'mkdir -p "/models/$(dirname "$1")" && cp "$1" "/models/$1"' _ {} \;

# ---------------------------------------------------------------- production dependencies
# Keyed on the manifests alone, so a source change never installs again.
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm rebuild re2

FROM ${NODE_IMAGE} AS gateway-deps
WORKDIR /app
COPY services/llm-gateway/package.json services/llm-gateway/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM ${NODE_IMAGE} AS audit-writer-deps
WORKDIR /app
COPY services/audit-writer/package.json services/audit-writer/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM ${NODE_IMAGE} AS cost-reconciler-deps
WORKDIR /app
COPY services/cost-reconciler/package.json services/cost-reconciler/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# ---------------------------------------------------------------- build
FROM deps AS build
COPY . .
COPY --from=models /models ./models

# The assembler compiles the whole tsconfig include, so tests and services
# are pruned from the production output before the manifest is written.
RUN node ace build \
 && rm -rf build/tests build/services build/scripts build/app/security/ablations.js \
 && node scripts/build-manifest.mjs build build/build-manifest.json production \
 && cp test-modules.json build/test-modules.json \
 && for svc in llm-gateway audit-writer cost-reconciler mock-oidc provider-stub git-fixture; do \
      npx tsc -p services/$svc/tsconfig.json \
      && node scripts/build-manifest.mjs services/$svc/build services/$svc/build-manifest.json $svc; \
    done

# ---------------------------------------------------------------- app base
FROM ${NODE_IMAGE} AS app
ENV NODE_ENV=production
ENV MODELS_DIR=/app/models
# git: the worker fetches repositories with it and web validates ref names with
# `git check-ref-format` (ADR-019); the slim base ships without it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Stable layers first (dependencies, models), the compiled application last.
COPY --from=prod-deps --chown=node:node /src/node_modules ./node_modules
COPY --from=models --chown=node:node /models ./models
COPY --from=build --chown=node:node /src/models.lock.json ./models.lock.json
COPY --from=build --chown=node:node /src/build ./
USER node

FROM app AS web
EXPOSE 3333
HEALTHCHECK --interval=5s --timeout=3s --retries=20 \
  CMD node -e "fetch('http://127.0.0.1:3333/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "bin/server.js"]

FROM app AS worker
HEALTHCHECK --interval=5s --timeout=3s --retries=20 CMD test -f /tmp/worker.ready
CMD ["node", "bin/worker.js"]

# ---------------------------------------------------------------- services
FROM ${NODE_IMAGE} AS llm-gateway
ENV NODE_ENV=production
WORKDIR /app
COPY --from=gateway-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /src/services/llm-gateway/package.json /src/services/llm-gateway/package-lock.json ./
COPY --from=build --chown=node:node /src/services/llm-gateway/build ./build
COPY --from=build --chown=node:node /src/services/llm-gateway/build-manifest.json ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=5s --timeout=3s --retries=20 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "build/services/llm-gateway/src/server.js"]

FROM ${NODE_IMAGE} AS audit-writer
ENV NODE_ENV=production
WORKDIR /app
COPY --from=audit-writer-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /src/services/audit-writer/package.json /src/services/audit-writer/package-lock.json ./
COPY --from=build --chown=node:node /src/services/audit-writer/build ./build
COPY --from=build --chown=node:node /src/services/audit-writer/build-manifest.json ./
USER node
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD node -e "process.exit(0)"
CMD ["node", "build/services/audit-writer/src/main.js"]

FROM ${NODE_IMAGE} AS cost-reconciler
ENV NODE_ENV=production
WORKDIR /app
COPY --from=cost-reconciler-deps --chown=node:node /app/node_modules ./node_modules
RUN mkdir -p /var/lib/cost-reconciler && chown node:node /var/lib/cost-reconciler
COPY --from=build --chown=node:node /src/services/cost-reconciler/package.json /src/services/cost-reconciler/package-lock.json ./
COPY --from=build --chown=node:node /src/config/prices.json ./config/prices.json
COPY --from=build --chown=node:node /src/services/cost-reconciler/build ./build
COPY --from=build --chown=node:node /src/services/cost-reconciler/build-manifest.json ./
USER node
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD node -e "process.exit(0)"
CMD ["node", "build/services/cost-reconciler/src/main.js"]

# ---------------------------------------------------------------- test targets
# Full source tree with dev dependencies so Japa runs inside the container.
FROM build AS app-test
ENV NODE_ENV=test
WORKDIR /src
RUN node scripts/build-manifest.mjs . build-manifest.json test
USER node

FROM app-test AS web-test
EXPOSE 3333
CMD ["node", "ace", "serve"]

FROM app-test AS worker-test
CMD ["node", "ace", "test"]

FROM ${NODE_IMAGE} AS mock-oidc
ENV NODE_ENV=test
WORKDIR /app
COPY --from=build --chown=node:node /src/services/mock-oidc/build ./build
COPY --from=build --chown=node:node /src/services/mock-oidc/package.json ./
USER node
EXPOSE 9000
HEALTHCHECK --interval=5s --timeout=3s --retries=20 \
  CMD node -e "fetch('http://127.0.0.1:9000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "build/server.js"]


# Scripted provider for deployment conformance (WP-17); test profile only.
FROM ${NODE_IMAGE} AS provider-stub
ENV NODE_ENV=test
WORKDIR /app
COPY --from=build --chown=node:node /src/services/provider-stub/build ./build
COPY --from=build --chown=node:node /src/services/provider-stub/frames ./frames
COPY --from=build --chown=node:node /src/services/provider-stub/package.json ./
USER node
EXPOSE 9200
HEALTHCHECK --interval=5s --timeout=3s --retries=10 \
  CMD node -e "fetch('http://127.0.0.1:9200/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "build/server.js"]

# Smart-HTTP git server with the shop fixture for deployment conformance (WP-17); test profile only.
FROM ${NODE_IMAGE} AS git-fixture
ENV NODE_ENV=test
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /src/services/git-fixture/build ./build
COPY --from=build --chown=node:node /src/services/git-fixture/package.json ./
COPY --from=build --chown=node:node /src/evals/fixtures/node-express-shop ./fixtures/node-express-shop
# The CA volume is seeded from this directory's ownership on first mount, so the service can write the certificate.
RUN mkdir -p /fixture-ca && chown node:node /fixture-ca
USER node
EXPOSE 8443
HEALTHCHECK --interval=5s --timeout=3s --retries=20 \
  CMD node -e "process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';fetch('https://127.0.0.1:8443/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "build/server.js"]
