/** NFKC normalisation with zero-width and soft-hyphen characters removed; rules run only on this form (ADR-028). */
export function normalise(text: string): string {
  return text.normalize('NFKC').replace(/[\u200B-\u200F\u2060\uFEFF\u00AD]/g, '')
}
