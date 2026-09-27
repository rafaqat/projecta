param name string
param location string
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: name
  location: location
  properties: { retentionInDays: 30, sku: { name: 'PerGB2018' } }
}
output customerId string = logs.properties.customerId
output primarySharedKey string = logs.listKeys().primarySharedKey
