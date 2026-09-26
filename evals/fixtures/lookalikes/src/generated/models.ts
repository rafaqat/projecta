/* eslint-disable */
// GENERATED FILE — do not edit. Source: schema/models.graphql
export class OrderDto {
  constructor(
    public readonly id: string,
    public readonly total: number,
    public readonly currency: string,
    public readonly createdAt: string
  ) {}
  get key(): string {
    return this.id
  }
  toJSON(): Record<string, unknown> {
    return { id: this.id, total: this.total, currency: this.currency, createdAt: this.createdAt }
  }
}

export class RefundDto {
  constructor(
    public readonly id: string,
    public readonly total: number,
    public readonly currency: string,
    public readonly createdAt: string
  ) {}
  get key(): string {
    return this.id
  }
  toJSON(): Record<string, unknown> {
    return { id: this.id, total: this.total, currency: this.currency, createdAt: this.createdAt }
  }
}

export class InvoiceDto {
  constructor(
    public readonly id: string,
    public readonly total: number,
    public readonly currency: string,
    public readonly createdAt: string
  ) {}
  get key(): string {
    return this.id
  }
  toJSON(): Record<string, unknown> {
    return { id: this.id, total: this.total, currency: this.currency, createdAt: this.createdAt }
  }
}
