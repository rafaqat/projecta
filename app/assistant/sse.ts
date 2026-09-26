import { encodeFrame, isAnswerEvent, type AnswerEvent } from '#app/assistant/protocol'

/**
 * The single SSE encoder (INV-14). Every byte that reaches the
 * client's event stream passes through `write`, which accepts only members
 * of the closed AnswerEvent union; anything else is a programming error and
 * throws before a byte is written.
 */
export interface SseSink {
  write(chunk: string): void
}

export class AnswerEventEncoder {
  private count = 0

  constructor(private readonly sink: SseSink) {}

  write(event: AnswerEvent): void {
    if (!isAnswerEvent(event)) throw new TypeError('not an AnswerEvent')
    this.sink.write(encodeFrame(event))
    this.count++
  }

  get written(): number {
    return this.count
  }
}
