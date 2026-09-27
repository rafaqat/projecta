import type { Request, Response } from 'express'

/** Framework handlers with an identical shape; each reads a different table. */
export async function getOrders(req: Request, res: Response): Promise<void> {
  const page = Number(req.query.page ?? 1)
  const rows = await req.app.locals.db.from('orders').where('user_id', req.params.userId).page(page)
  res.status(200).json({ page, rows })
}

export async function getRefunds(req: Request, res: Response): Promise<void> {
  const page = Number(req.query.page ?? 1)
  const rows = await req.app.locals.db.from('refunds').where('user_id', req.params.userId).page(page)
  res.status(200).json({ page, rows })
}

export async function getInvoices(req: Request, res: Response): Promise<void> {
  const page = Number(req.query.page ?? 1)
  const rows = await req.app.locals.db.from('invoices').where('user_id', req.params.userId).page(page)
  res.status(200).json({ page, rows })
}
