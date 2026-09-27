/**
 * A shared, dependency-free fan-out for the in-process gateway's security events.
 *
 * The gateway takes an `onEvent` callback per instance (services/llm-gateway/src/server.ts) and the
 * test harness records those into a per-test local array (harness.ts `Started.events`). There is no
 * ambient gateway emitter to tap the way the app has `securityEvents` — deliberate: the gateway is its
 * own process with no global state. This module is the one opt-in seam that lets the red-team CI
 * reporter observe gateway-side events (policy.enforced, injection.suspected, honeytoken.foreign)
 * across every harness instance and correlate them to the test in flight, without altering what a test
 * asserts on its own `gw.events`. With no listeners registered, `emit` is a no-op, so it adds nothing
 * to an ordinary test run. It is intentionally not imported by production code — a test-only seam.
 */
export interface GatewayEvent {
  event: string
  fields: Record<string, unknown>
}

type Listener = (event: GatewayEvent) => void

const listeners = new Set<Listener>()

export const gatewayEventTap = {
  /** Observe every gateway event fanned out by the harness. Returns an unsubscribe function. */
  tap(listener: Listener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  /** The harness calls this for each gateway `onEvent`; a throwing listener never breaks the others. */
  emit(event: GatewayEvent): void {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        // A reporter/collector fault must never fail the gateway path under test.
      }
    }
  },
}
