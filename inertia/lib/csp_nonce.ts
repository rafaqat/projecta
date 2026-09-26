/**
 * Radix overlays lock scrolling through react-remove-scroll, which mounts one
 * <style> element per open layer. Under the nonce-based style-src
 * that element is blocked unless it carries the request nonce. Its style
 * singleton reads the bundler convention `__webpack_nonce__`, so the nonce
 * the Edge layout put on <meta property="csp-nonce"> is handed over here,
 * before any component renders. No other code reads or sets this global.
 */
const LIBRARY_NONCE_GLOBAL = '__webpack_nonce__'
const meta = document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')
if (meta?.nonce) Reflect.set(globalThis, LIBRARY_NONCE_GLOBAL, meta.nonce)

export {}
