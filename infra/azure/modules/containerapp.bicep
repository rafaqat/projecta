param prefix string
param location string
param appImage string
param gatewayImage string
param identityId string
param logAnalyticsCustomerId string
@secure()
param logAnalyticsKey string
param pgFqdn string
param pgDatabase string

resource envmt 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-env'
  location: location
  properties: {
    // Peer-to-peer encryption for internal traffic carrying code + attribution tokens (ADR-012).
    peerTrafficConfiguration: { encryption: { enabled: true } }
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logAnalyticsCustomerId, sharedKey: logAnalyticsKey }
    }
  }
}

// The gateway is the only egress to the provider (INV-02): internal ingress only.
resource gateway 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${prefix}-gateway'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identityId}': {} } }
  properties: {
    managedEnvironmentId: envmt.id
    configuration: { ingress: { external: false, targetPort: 8080 } }
    template: {
      containers: [ { name: 'gateway', image: gatewayImage, resources: { cpu: json('0.5'), memory: '1Gi' } } ]
      scale: { minReplicas: 1, maxReplicas: 3 }
    }
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${prefix}-app'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identityId}': {} } }
  properties: {
    managedEnvironmentId: envmt.id
    configuration: { ingress: { external: true, targetPort: 3333 } }
    template: {
      containers: [
        {
          name: 'app'
          image: appImage
          resources: { cpu: json('1.0'), memory: '2Gi' }
          env: [
            { name: 'APP_ENV', value: 'production' }
            { name: 'DB_HOST', value: pgFqdn }
            { name: 'DB_DATABASE', value: pgDatabase }
            { name: 'ANTHROPIC_BASE_URL', value: 'https://${gateway.properties.configuration.ingress.fqdn}' }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 5 }
    }
  }
}
output appFqdn string = app.properties.configuration.ingress.fqdn
