/** Tabs and spaces inside one symbol, as a merge left them. */
export function parseAmount(raw: string): number {
	const trimmed = raw.trim()
    const value = Number(trimmed)
	if (Number.isNaN(value)) {
        throw new Error('not a number')
	}
    return value
}
