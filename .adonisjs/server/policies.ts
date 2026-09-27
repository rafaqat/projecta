export const policies = {
  MainPolicy: () => import('#policies/main'),
  RepositoryPolicy: () => import('#policies/repository_policy'),
  WorkspacePolicy: () => import('#policies/workspace_policy'),
}

