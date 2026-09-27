/**
 * Anchor storage: chain heads with sequence numbers go to
 * write-once storage outside the database, so truncation between anchors is
 * detected at the next verification. Blob names are unique per anchor and
 * never overwritten; on Azure the container carries an immutability policy.
 */
export interface Anchor {
  workspaceId: string
  seq: number
  headHash: string
  anchoredAt: string
  keyId: string
  signature: string
}

export interface AnchorStore {
  put(anchor: Anchor): Promise<string>
  /** The highest-sequence anchor for a workspace, or null. */
  latest(workspaceId: string): Promise<Anchor | null>
}

export class MemoryAnchorStore implements AnchorStore {
  readonly anchors: Anchor[] = []
  async put(anchor: Anchor): Promise<string> {
    this.anchors.push(anchor)
    return `memory://${anchor.workspaceId}/${anchor.seq}`
  }
  async latest(workspaceId: string): Promise<Anchor | null> {
    const mine = this.anchors.filter((a) => a.workspaceId === workspaceId)
    return mine.length ? mine.reduce((a, b) => (b.seq > a.seq ? b : a)) : null
  }
}

/** Azure Blob (Azurite locally). Loaded lazily so the app boots without the SDK in test targets. */
export class BlobAnchorStore implements AnchorStore {
  constructor(
    private readonly connectionString: string,
    private readonly container = 'audit-anchors'
  ) {}

  private async client() {
    const { BlobServiceClient } = await import('@azure/storage-blob')
    const container = BlobServiceClient.fromConnectionString(
      this.connectionString
    ).getContainerClient(this.container)
    await container.createIfNotExists()
    return container
  }

  async put(anchor: Anchor): Promise<string> {
    const container = await this.client()
    const name = `${anchor.workspaceId}/${String(anchor.seq).padStart(12, '0')}-${anchor.headHash.slice(0, 16)}.json`
    const body = JSON.stringify(anchor)
    // conditions: { ifNoneMatch: '*' } refuses to overwrite an existing blob.
    await container
      .getBlockBlobClient(name)
      .upload(body, Buffer.byteLength(body), { conditions: { ifNoneMatch: '*' } })
    return `${this.container}/${name}`
  }

  async latest(workspaceId: string): Promise<Anchor | null> {
    const container = await this.client()
    let best: Anchor | null = null
    for await (const blob of container.listBlobsFlat({ prefix: `${workspaceId}/` })) {
      const seq = Number(blob.name.split('/')[1]?.split('-')[0])
      if (!best || seq > best.seq) {
        const download = await container.getBlockBlobClient(blob.name).downloadToBuffer()
        best = JSON.parse(download.toString('utf8')) as Anchor
      }
    }
    return best
  }
}
