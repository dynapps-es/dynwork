export * as Jcs from "./jcs"

// RFC 8785 JSON Canonicalization Scheme. The scheme is defined on top of ECMAScript's own JSON serialization: numbers
// and strings serialize exactly as JSON.stringify writes them, and object keys sort by UTF-16 code units, which is what
// the default Array sort compares. So the whole scheme is the recursion below; no dependency is needed.
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JCS cannot represent NaN or Infinity")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  if (typeof value === "object") {
    // `<` on strings compares UTF-16 code units, the order RFC 8785 section 3.2.3 asks for
    const entries = Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    return `{${entries.map((entry) => `${JSON.stringify(entry[0])}:${canonicalize(entry[1])}`).join(",")}}`
  }
  throw new TypeError(`JCS cannot represent a ${typeof value}`)
}
