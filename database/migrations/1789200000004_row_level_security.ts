import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Row-level security as defence in depth (SEC-06). The scope
 * functions raise when the transaction has not set `app.user_id` and
 * `app.workspace_id`, so a query on a tenant table outside a scoped
 * transaction aborts instead of silently returning nothing (SEC-39).
 * FORCE makes the policies apply to the table owner too.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.raw(`
      CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS integer
      LANGUAGE plpgsql STABLE AS $$
      DECLARE v text := current_setting('app.user_id', true);
      BEGIN
        IF v IS NULL OR v = '' THEN
          RAISE EXCEPTION 'app.user_id is not set for this transaction' USING ERRCODE = 'P0002';
        END IF;
        RETURN v::integer;
      END $$;

      -- The workspace scope is validated, not trusted: the acting user must be
      -- a member, so an application that sets a foreign workspace (ablation
      -- no_app_scope_checks) still cannot read across workspaces.
      CREATE OR REPLACE FUNCTION app_current_workspace_id() RETURNS uuid
      LANGUAGE plpgsql STABLE AS $$
      DECLARE v text := current_setting('app.workspace_id', true);
      BEGIN
        IF v IS NULL OR v = '' THEN
          RAISE EXCEPTION 'app.workspace_id is not set for this transaction' USING ERRCODE = 'P0002';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM workspace_memberships m
          WHERE m.workspace_id = v::uuid AND m.user_id = app_current_user_id()
        ) THEN
          RAISE EXCEPTION 'app.workspace_id does not belong to the acting user' USING ERRCODE = '42501';
        END IF;
        RETURN v::uuid;
      END $$;

      -- Directory tables are scoped by the acting user: a user reads only
      -- their own memberships and the workspaces those grant. The read policy
      -- on memberships calls no scope function, which keeps the policy graph
      -- free of recursion. Creating a workspace is an application action, so
      -- INSERT is open; the row stays invisible until a membership exists.
      ALTER TABLE workspace_memberships ENABLE ROW LEVEL SECURITY;
      ALTER TABLE workspace_memberships FORCE ROW LEVEL SECURITY;
      CREATE POLICY memberships_read ON workspace_memberships FOR SELECT
        USING (user_id = app_current_user_id());
      CREATE POLICY memberships_write ON workspace_memberships FOR INSERT
        WITH CHECK (user_id = app_current_user_id() OR workspace_id = app_current_workspace_id());
      CREATE POLICY memberships_delete ON workspace_memberships FOR DELETE
        USING (workspace_id = app_current_workspace_id());

      ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
      ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
      CREATE POLICY workspaces_read ON workspaces FOR SELECT
        USING (EXISTS (
          SELECT 1 FROM workspace_memberships m
          WHERE m.workspace_id = workspaces.id AND m.user_id = app_current_user_id()
        ));
      CREATE POLICY workspaces_insert ON workspaces FOR INSERT WITH CHECK (true);
      CREATE POLICY workspaces_update ON workspaces FOR UPDATE
        USING (id = app_current_workspace_id());

      ALTER TABLE repository_members ENABLE ROW LEVEL SECURITY;
      ALTER TABLE repository_members FORCE ROW LEVEL SECURITY;
      CREATE POLICY repository_members_workspace ON repository_members
        USING (workspace_id = app_current_workspace_id());

      ALTER TABLE repositories ENABLE ROW LEVEL SECURITY;
      ALTER TABLE repositories FORCE ROW LEVEL SECURITY;
      CREATE POLICY repositories_insert ON repositories FOR INSERT
        WITH CHECK (workspace_id = app_current_workspace_id());
      CREATE POLICY repositories_acl ON repositories FOR ALL
        USING (
          workspace_id = app_current_workspace_id()
          AND (
            visibility = 'workspace'
            OR EXISTS (
              SELECT 1 FROM repository_members rm
              WHERE rm.repository_id = repositories.id AND rm.user_id = app_current_user_id()
            )
          )
        );
    `)
  }

  async down() {
    this.schema.raw(`
      DROP POLICY IF EXISTS repositories_acl ON repositories;
      DROP POLICY IF EXISTS repositories_insert ON repositories;
      DROP POLICY IF EXISTS repository_members_workspace ON repository_members;
      DROP POLICY IF EXISTS workspaces_update ON workspaces;
      DROP POLICY IF EXISTS workspaces_insert ON workspaces;
      DROP POLICY IF EXISTS workspaces_read ON workspaces;
      DROP POLICY IF EXISTS memberships_delete ON workspace_memberships;
      DROP POLICY IF EXISTS memberships_write ON workspace_memberships;
      DROP POLICY IF EXISTS memberships_read ON workspace_memberships;
      ALTER TABLE repositories NO FORCE ROW LEVEL SECURITY; ALTER TABLE repositories DISABLE ROW LEVEL SECURITY;
      ALTER TABLE repository_members NO FORCE ROW LEVEL SECURITY; ALTER TABLE repository_members DISABLE ROW LEVEL SECURITY;
      ALTER TABLE workspaces NO FORCE ROW LEVEL SECURITY; ALTER TABLE workspaces DISABLE ROW LEVEL SECURITY;
      ALTER TABLE workspace_memberships NO FORCE ROW LEVEL SECURITY; ALTER TABLE workspace_memberships DISABLE ROW LEVEL SECURITY;
      DROP FUNCTION IF EXISTS app_current_workspace_id();
      DROP FUNCTION IF EXISTS app_current_user_id();
    `)
  }
}
