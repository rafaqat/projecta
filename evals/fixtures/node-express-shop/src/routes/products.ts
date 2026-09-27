import { Router } from 'express'
import { InventoryService } from '@services/InventoryService'

export const productsRouter = Router()
const inventory = new InventoryService()

productsRouter.get('/', async (_req, res) => {
  res.json(await inventory.listProducts())
})

productsRouter.get('/:sku', async (req, res) => {
  const product = await inventory.findBySku(req.params.sku)
  if (!product) return res.status(404).json({ error: 'not found' })
  res.json(product)
})
