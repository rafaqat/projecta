// Lint fixture (AC-WP06-20): only the in-process orchestrator may import the agent loop.
import { runAgent } from '#app/assistant/agent'

export const leak = runAgent
