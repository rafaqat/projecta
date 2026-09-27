using 'main.bicep'
param env = 'uat'
param appImage = 'projectaacr.azurecr.io/app@sha256:REPLACE'
param gatewayImage = 'projectaacr.azurecr.io/gateway@sha256:REPLACE'
param pgAdminLogin = 'pgadmin'
param pgAdminPassword = readEnvironmentVariable('PG_ADMIN_PASSWORD', '')
