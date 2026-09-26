# Postgres 17 with pgvector (base image) and pg_textsearch (ADR-003).
#
# pg_textsearch is built FROM SOURCE at a pinned commit rather than installed from the
# v1.4.0 release .deb. The released v1.4.0 (the latest tag) segfaults a backend under the
# transaction/rollback + concurrent-BM25-query pattern our test suites exercise: a backend
# frees a bm25 index's shared state on an uncommitted/rolled-back path and later crashes on
# the next query (upstream issue timescale/pg_textsearch#506 — SIGSEGV on x86_64, SIGBUS on
# aarch64; reproduced here as a Postgres crash-recovery cycle that fails whatever turn is
# in-flight). The fix (defer the shared-state free to a commit callback, and hold the index
# lock while freeing) landed on the default branch after v1.4.0 (#477, #465, #478) but is not
# yet in a release, so there is no fixed binary to download — we compile it.
#
# Pinned by commit SHA (content-addressed; git verifies it on checkout). We pin the EARLIEST
# post-v1.4.0 commit that carries the crash fix (#465 "hold index lock while freeing" + #477
# "dispatch compaction requests at commit" = issue #506's deferral pattern) and NOT the later
# query-behaviour changes (#492 restrict-BM25-on-RLS, #480 boolean-tsquery, #500), which
# regressed a byte-fidelity retrieval test. Bump only in a reviewed PR, and revert to the
# release .deb once a release >= this commit ships.
FROM pgvector/pgvector:pg17@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f

# Consumed only so the callers' `--build-arg TARGETARCH=amd64` is not an unused-arg warning;
# the correct arch is selected by the multi-arch base image manifest, and the source build is
# arch-agnostic.
ARG TARGETARCH
ARG PG_TEXTSEARCH_COMMIT=f940210f9a7761529fab1cf85fc10e5d70699f0b

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends build-essential git postgresql-server-dev-17 clang llvm ca-certificates; \
    git clone https://github.com/timescale/pg_textsearch.git /tmp/pgts; \
    cd /tmp/pgts; \
    git checkout "$PG_TEXTSEARCH_COMMIT"; \
    test "$(git rev-parse HEAD)" = "$PG_TEXTSEARCH_COMMIT"; \
    make; make install; \
    apt-get purge -y build-essential git postgresql-server-dev-17 clang llvm; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/* /tmp/*

COPY docker/postgres/init.sql /docker-entrypoint-initdb.d/10-extensions.sql
CMD ["postgres", "-c", "shared_preload_libraries=pg_textsearch"]
