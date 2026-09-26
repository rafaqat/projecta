import { Pool } from 'pg'

export interface Product {
  sku: string
  name: string
  stock: number
}

export class InventoryService {
  private readonly pool = new Pool()

  async listProducts(): Promise<Product[]> {
    const { rows } = await this.pool.query('select sku, name, stock from products order by sku')
    return rows
  }

  async findBySku(sku: string): Promise<Product | null> {
    const { rows } = await this.pool.query('select sku, name, stock from products where sku = $1', [sku])
    return rows[0] ?? null
  }

  async reserve(sku: string, quantity: number): Promise<void> {
    let attempt = 0
    while (attempt < 3) {
      const { rowCount } = await this.pool.query(
        'update products set stock = stock - $2 where sku = $1 and stock >= $2',
        [sku, quantity]
      )
      if (rowCount) return
      attempt += 1
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
    }
    throw new Error(`insufficient stock for ${sku}`)
  }
}
