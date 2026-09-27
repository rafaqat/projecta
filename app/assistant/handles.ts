/**
 * Turn-local handle registry (INV-13). The model only ever sees
 * `r1`/`c7`-style handles minted for this turn; they resolve against this
 * registry alone, so a handle copied from another turn, a database ID or a
 * SHA resolves to nothing.
 */
export interface EvidenceRef {
  chunkId: string
  symbolId: string | null
  path: string
  blobSha: string
  span: { start: number; end: number }
}

export class TurnHandleRegistry {
  private readonly refs = new Map<string, EvidenceRef>()
  private counter = 0

  /** Mints a retrieval handle for a chunk. Handles are dense and per turn. */
  register(ref: EvidenceRef): string {
    const handle = `r${++this.counter}`
    this.refs.set(handle, ref)
    return handle
  }

  resolve(handle: string): EvidenceRef | undefined {
    return this.refs.get(handle)
  }

  has(handle: string): boolean {
    return this.refs.has(handle)
  }

  handles(): string[] {
    return Array.from(this.refs.keys())
  }
}

export const HANDLE_SHAPE = /^r\d{1,4}$/
