-- Runs once on an empty data directory as the superuser.
-- The application connects as `app`: a non-superuser without BYPASSRLS, so row-level security
-- applies to every query it runs (ADR-0003). Later-slice roles arrive with their slices.
CREATE ROLE app LOGIN PASSWORD 'app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
-- The audit writer is the only role that may append to audit_events (ADR-025).
-- It bypasses RLS because it serves every workspace's chain.
CREATE ROLE audit_writer LOGIN PASSWORD 'audit' NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
-- The LLM gateway keeps its ledger in its own schema (ADR-010, ADR-024).
CREATE ROLE gateway LOGIN PASSWORD 'gateway' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
-- The cost reconciler reads both ledgers across every workspace and writes nothing (ADR-038).
CREATE ROLE cost_reconciler LOGIN PASSWORD 'cost' NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
ALTER DATABASE app OWNER TO app;
CREATE DATABASE app_test OWNER app;

\connect app
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_textsearch;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
GRANT ALL ON SCHEMA public TO app;
GRANT USAGE ON SCHEMA public TO audit_writer;
GRANT USAGE ON SCHEMA public TO cost_reconciler;

\connect app_test
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_textsearch;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
GRANT ALL ON SCHEMA public TO app;
GRANT USAGE ON SCHEMA public TO audit_writer;
GRANT USAGE ON SCHEMA public TO cost_reconciler;
