import { Env } from '@adonisjs/core/env'

export default await Env.create(new URL('../', import.meta.url), {
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
  HOST: Env.schema.string({ format: 'host' }),
  LOG_LEVEL: Env.schema.string(),

  APP_KEY: Env.schema.secret(),
  APP_URL: Env.schema.string({ format: 'url', tld: false }),
  APP_ENV: Env.schema.enum(['local', 'test', 'uat', 'production'] as const),
  APP_NAME: Env.schema.string(),
  APP_VERSION: Env.schema.string(),

  // Identity. The allowlist is a comma-separated list of issuer URLs.
  OIDC_ISSUER: Env.schema.string({ format: 'url', tld: false }),
  OIDC_ALLOWED_ISSUERS: Env.schema.string(),
  OIDC_CLIENT_ID: Env.schema.string(),
  OIDC_CLIENT_SECRET: Env.schema.secret(),
  OIDC_ALLOWED_TENANTS: Env.schema.string(),

  SESSION_DRIVER: Env.schema.enum(['cookie', 'memory', 'database'] as const),

  // Ingestion: comma-separated allowlist of git hosts the URL policy admits.
  GIT_ALLOWED_HOSTS: Env.schema.string(),

  DB_HOST: Env.schema.string({ format: 'host' }),
  DB_PORT: Env.schema.number(),
  DB_USER: Env.schema.string(),
  DB_PASSWORD: Env.schema.string.optional(),
  DB_DATABASE: Env.schema.string(),

  // Cited answers (Slice 3). LLM egress goes through the gateway: the base URL is
  // llm-gateway in every environment and the "API key" is the gateway's shared token.
  ANTHROPIC_BASE_URL: Env.schema.string({ format: 'url', tld: false }),
  LLM_GATEWAY_TOKEN: Env.schema.secret(),
  CANARY_SAMPLE_RATE: Env.schema.string.optional(),
  LEXICAL_BACKEND: Env.schema.enum.optional(['pg_textsearch', 'tsvector'] as const),

  // Telemetry
  OTEL_EXPORTER_OTLP_ENDPOINT: Env.schema.string.optional({ format: 'url', tld: false }),
})
