import { Router } from 'express'
import { z } from 'zod'
import { PaymentService } from '@services/PaymentService'
import { InventoryService } from '@services/InventoryService'

export const ordersRouter = Router()
const payments = new PaymentService()
const inventory = new InventoryService()

const orderSchema = z.object({ sku: z.string(), quantity: z.number().int().positive() })

ordersRouter.post('/', async (req, res) => {
  const order = orderSchema.parse(req.body)
  await inventory.reserve(order.sku, order.quantity)
  const charge = await payments.chargeCard(req.user.id, order.sku, order.quantity)
  res.status(201).json({ orderId: charge.id })
})

ordersRouter.post('/:orderId/refund', async (req, res) => {
  const refund = await payments.refundPayment(req.params.orderId)
  res.json(refund)
})
