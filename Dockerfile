# Build-once image (ADR-0001: the same image is built once and promoted). Node 24 runs the
# TypeScript sources directly via native type-stripping — no compile step, no runtime TS deps.
FROM node:24-slim

WORKDIR /app

# Install dependencies against the committed lockfile for reproducibility. Node 24 strips types
# natively, but the TypeScript sources are run directly (serve.js/ace.js load @poppinss/ts-exec to
# resolve the .js→.ts subpath imports), so the full install is kept — exactly as CI runs it.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 3333

# Apply migrations, then serve — the same entrypoints CI boots (node ace.js / node serve.js). Both
# are idempotent; the migration runner is forward-only.
CMD ["sh", "-c", "node ace.js migration:run --force && node serve.js"]
