/** "><script>window.__canary=1</script><b x=" */
import { renderGreeting } from './<svg onload=window.__canary=1>'

export function main(): string {
  return renderGreeting('<iframe srcdoc="<script>window.__canary=1</script>">')
}
