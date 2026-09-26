// Typecheck fixture (AC-WP06-23): a client rendering table that omits a RunState must not compile.
import type { RunState } from '../../../app/assistant/protocol'

export const INCOMPLETE: Record<RunState, string> = {
  running: 'Answering',
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Failed',
  // awaiting_input is missing on purpose
}
