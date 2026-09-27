import Stripe from 'stripe'
import { withRetry } from '@utils/retry'

export class PaymentService {
  private readonly stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '')

  async chargeCard(customerId: string, sku: string, quantity: number) {
    const amount = await this.priceFor(sku, quantity)
    return withRetry(() => this.stripe.paymentIntents.create({ amount, currency: 'gbp', customer: customerId }))
  }

  async refundPayment(paymentIntentId: string) {
    const intent = await this.stripe.paymentIntents.retrieve(paymentIntentId)
    if (intent.status !== 'succeeded') {
      throw new Error(`cannot refund a payment in state ${intent.status}`)
    }
    return withRetry(() => this.stripe.refunds.create({ payment_intent: paymentIntentId }))
  }

  private async priceFor(sku: string, quantity: number) {
    const unit = sku.startsWith('PREMIUM') ? 4999 : 1999
    return unit * quantity
  }
}
