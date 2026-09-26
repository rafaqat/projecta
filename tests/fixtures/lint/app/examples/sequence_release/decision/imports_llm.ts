// Lint fixture (INV-20): the decision module must not reach the model.
import { createClient } from '#app/llm/client'

export const forbidden = createClient
