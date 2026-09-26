/**
 * Colour scheme. Dark is the default; `light` is a class on <html>
 * that the Edge layout renders from a plain cookie, so the first paint is
 * already right. The toggle flips the class and writes the same cookie.
 */
export type Scheme = 'dark' | 'light'

export function currentScheme(): Scheme {
  return document.documentElement.classList.contains('light') ? 'light' : 'dark'
}

export function applyScheme(scheme: Scheme): void {
  document.documentElement.classList.toggle('light', scheme === 'light')
  document.cookie = `scheme=${scheme}; path=/; max-age=31536000; SameSite=Lax`
}
