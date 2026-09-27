import Anthropic from '@anthropic-ai/sdk'

export const client = new Anthropic({ baseURL: 'http://llm-gateway' })
