export type { Citation, Source } from '../../../app/assistant/answer_layout'
export { sourceKey, sourcesOf } from '../../../app/assistant/answer_layout'

export function splitPath(path: string): { dir: string; file: string } {
  const at = path.lastIndexOf('/')
  return at === -1
    ? { dir: '', file: path }
    : { dir: path.slice(0, at + 1), file: path.slice(at + 1) }
}
