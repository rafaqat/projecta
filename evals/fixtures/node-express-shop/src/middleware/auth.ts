import type { NextFunction, Request, Response } from 'express'

declare module 'express-serve-static-core' {
  interface Request {
    user: { id: string }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.header('authorization')?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'unauthenticated' })
  req.user = { id: token }
  next()
}
