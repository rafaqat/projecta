/**
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * URL-shaped strings that are identifiers, not links to fetch.
 */

/** An XML namespace: an identifier that happens to be a URL. */
export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

/** A JSON Schema identifier; never dereferenced. */
export const SCHEMA_ID = 'https://json-schema.org/draft/2020-12/schema'

/** The development origin. */
export const DEV_ORIGIN = 'http://localhost:3000'

/** A reserved documentation domain (RFC 2606). */
export const RESERVED_EXAMPLE = 'https://example.com/docs'

/** A protocol-relative reference from an older stylesheet. */
export const PROTOCOL_RELATIVE = '//cdn.example.net/lib.js'

/** A four-part version, not an address. */
export const VERSION_QUAD = '10.0.0.1'

/** The documentation IPv6 prefix (RFC 3849). */
export const IPV6_DOC = '2001:db8::1'

/** A scoped package name; the slash does not make it a path or a host. */
export const SCOPED_PACKAGE = '@scope/package'

export function svgElement(name: string): { namespace: string; name: string } {
  return { namespace: SVG_NAMESPACE, name }
}
