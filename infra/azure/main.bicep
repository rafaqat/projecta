// projectA — Azure deployment (ADR-0004). The build-once image promoted to Azure Container Apps,
// on Postgres Flexible Server (pgvector), with Key Vault + managed identity. Deploy:
//   az deployment group create -g <rg> -f main.bicep -p main.<env>.bicepparam
targetScope = 'resourceGroup'

@description('Short environment name, e.g. uat or prod.')
param env string
@description('Azure region for all resources.')
param location string = resourceGroup().location
@description('Container image reference for the app (registry/repo@digest — built once, promoted).')
param appImage string
@description('Container image reference for the llm-gateway.')
param gatewayImage string
@description('Postgres administrator login for the flexible server.')
param pgAdminLogin string
@secure()
@description('Postgres administrator password.')
param pgAdminPassword string

var prefix = 'projecta-${env}'

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  params: { name: '${prefix}-logs', location: location }
}

module registry 'modules/registry.bicep' = {
  name: 'registry'
  params: { name: replace('${prefix}acr', '-', ''), location: location }
}

module identity 'modules/identity.bicep' = {
  name: 'identity'
  params: { name: '${prefix}-id', location: location }
}

module vault 'modules/keyvault.bicep' = {
  name: 'keyvault'
  params: {
    name: replace('${prefix}-kv', '-', '')
    location: location
    readerPrincipalId: identity.outputs.principalId
  }
}

module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    name: '${prefix}-pg'
    location: location
    adminLogin: pgAdminLogin
    adminPassword: pgAdminPassword
  }
}

module apps 'modules/containerapp.bicep' = {
  name: 'containerapps'
  params: {
    prefix: prefix
    location: location
    appImage: appImage
    gatewayImage: gatewayImage
    identityId: identity.outputs.id
    logAnalyticsCustomerId: monitoring.outputs.customerId
    logAnalyticsKey: monitoring.outputs.primarySharedKey
    pgFqdn: postgres.outputs.fqdn
    pgDatabase: postgres.outputs.database
  }
}

output appUrl string = apps.outputs.appFqdn
