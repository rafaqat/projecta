export async function withRetry<T>(operation: () => Promise<T>, retries = 3): Promise<T> {
  let attempt = 0
  while (true) {
    try {
      return await operation()
    } catch (error) {
      attempt += 1
      if (attempt >= retries) throw error
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
    }
  }
}
