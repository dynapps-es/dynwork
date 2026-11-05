// Byte helpers that run the same on Bun, Electron and Hermes: no `Buffer`, no `atob`, no `node:` imports. Hermes has
// TextEncoder and TextDecoder natively.

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
const lookup = new Map([...alphabet].map((char, index) => [char, index]))

export const empty = new Uint8Array(0)

// RFC 4648 section 5, without padding.
export function toBase64Url(bytes: Uint8Array) {
  return Array.from({ length: Math.ceil(bytes.length / 3) }, (_, group) => {
    const at = group * 3
    const word = ((bytes[at] ?? 0) << 16) | ((bytes[at + 1] ?? 0) << 8) | (bytes[at + 2] ?? 0)
    return [18, 12, 6, 0]
      .slice(0, Math.min(3, bytes.length - at) + 1)
      .map((shift) => alphabet[(word >> shift) & 63])
      .join("")
  }).join("")
}

// Strict: only the canonical encoding of some bytes decodes, so one value has exactly one text form.
export function fromBase64Url(text: string) {
  if (text.length % 4 === 1) return undefined
  const values = [...text].map((char) => lookup.get(char))
  if (values.some((value) => value === undefined)) return undefined
  const bytes = new Uint8Array(Math.floor((text.length * 6) / 8))
  Array.from({ length: Math.ceil(values.length / 4) }, (_, group) => {
    const word = [0, 1, 2, 3].reduce((acc, index) => (acc << 6) | (values[group * 4 + index] ?? 0), 0)
    ;[16, 8, 0].forEach((shift, index) => {
      if (group * 3 + index < bytes.length) bytes[group * 3 + index] = (word >> shift) & 0xff
    })
  })
  if (toBase64Url(bytes) !== text) return undefined
  return bytes
}

export function utf8(text: string) {
  return new TextEncoder().encode(text)
}

// undefined when the bytes are not valid UTF-8. TextDecoder reports invalid input only by throwing.
export function fromUtf8(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

export function view(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

export function readU32(bytes: Uint8Array, at: number) {
  return view(bytes).getUint32(at)
}

export function writeU32(bytes: Uint8Array, at: number, value: number) {
  view(bytes).setUint32(at, value)
}
