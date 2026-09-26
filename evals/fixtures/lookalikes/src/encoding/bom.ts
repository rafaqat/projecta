/** A file saved with a UTF-8 byte order mark by an editor. */
export function firstLine(text: string): string {
  return text.split('\n')[0] ?? ''
}

export function lastLine(text: string): string {
  const lines = text.split('\n')
  return lines[lines.length - 1] ?? ''
}
