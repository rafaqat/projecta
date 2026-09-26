param name string
param location string
resource id 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: name
  location: location
}
output id string = id.id
output principalId string = id.properties.principalId
