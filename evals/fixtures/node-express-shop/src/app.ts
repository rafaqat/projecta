import express from 'express'
import { productsRouter } from './routes/products.js'
import { ordersRouter } from './routes/orders.js'
import { requireAuth } from './middleware/auth.js'

export function createApp() {
  const app = express()
  app.use(express.json())
  app.get('/health', (_req, res) => res.json({ status: 'ok' }))
  app.use('/api/products', productsRouter)
  app.use('/api/orders', requireAuth, ordersRouter)
  return app
}
