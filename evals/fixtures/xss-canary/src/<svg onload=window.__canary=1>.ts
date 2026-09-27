// <script>window.__canary = 1</script> comment payload
export function renderGreeting(name: string): string {
  const template = '<img src=x onerror="window.__canary=1">'
  return `<b>${name}</b>` + template
}
