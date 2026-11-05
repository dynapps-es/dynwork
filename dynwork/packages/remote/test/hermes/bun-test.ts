// The part of `bun:test` the pure tests use, for the Hermes bundle (script/hermes.ts aliases `bun:test` here). Tests
// run one at a time, in registration order. The host's exit code stays 1 unless every test ran and passed, so a bundle
// that stops early (a hang the event loop gives up on, an uncaught error) can never read as green.

type Body = () => unknown | Promise<unknown>

const tests: { name: string; body: Body }[] = []
const prefix: string[] = []

declare const print: (...values: unknown[]) => void
declare const __finish: () => void
;(globalThis as { __exitCode?: number }).__exitCode = 1

export function describe(name: string, body: () => void) {
  prefix.push(name)
  body()
  prefix.pop()
}

function register(name: string, body: Body) {
  tests.push({ name: [...prefix, name].join(" > "), body })
}

function each<const T extends readonly unknown[]>(rows: readonly T[]) {
  return (name: string, body: (...args: T) => unknown, _timeout?: number) =>
    rows.forEach((row) => {
      const args = (Array.isArray(row) ? row : [row]) as unknown as T
      const title = args.reduce<string>((text, arg) => text.replace(/%[sdpi]/, String(arg)), name)
      register(title, () => body(...args))
    })
}

export const test = Object.assign((name: string, body: Body, _timeout?: number) => register(name, body), { each })

export async function run() {
  const failures: string[] = []
  for (const entry of tests) {
    try {
      await entry.body()
      print(`(pass) ${entry.name}`)
    } catch (error) {
      failures.push(entry.name)
      print(
        `(fail) ${entry.name}\n  ${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`,
      )
    }
  }
  print(`\nhermes: ${tests.length - failures.length} pass, ${failures.length} fail, 0 skip, ${tests.length} total`)
  ;(globalThis as { __exitCode?: number }).__exitCode = failures.length === 0 && tests.length > 0 ? 0 : 1
  __finish()
}

class Mismatch extends Error {}

function show(value: unknown): string {
  if (value instanceof Uint8Array) return `Uint8Array(${value.length})`
  if (typeof value === "string") return JSON.stringify(value.length > 120 ? value.slice(0, 120) + "…" : value)
  try {
    const text = JSON.stringify(value, (_, inner) => (typeof inner === "bigint" ? String(inner) : inner))
    return text === undefined ? String(value) : text.length > 300 ? text.slice(0, 300) + "…" : text
  } catch {
    return String(value)
  }
}

function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.constructor !== b.constructor) return false
    const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
    const right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
    return left.length === right.length && left.every((byte, index) => byte === right[index])
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keys = (value: object) =>
    Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined)
  const left = keys(a)
  const right = keys(b)
  if (left.length !== right.length) return false
  return left.every((key) => equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

function subset(actual: unknown, expected: unknown): boolean {
  if (typeof expected !== "object" || expected === null) return Object.is(actual, expected)
  if (typeof actual !== "object" || actual === null) return false
  return Object.entries(expected).every(([key, value]) => subset((actual as Record<string, unknown>)[key], value))
}

function matchers(actual: unknown, negate: boolean) {
  const check = (pass: boolean, message: string) => {
    if (pass === negate) throw new Mismatch(`expected ${show(actual)} ${negate ? "not " : ""}${message}`)
  }
  return {
    toBe: (expected: unknown) => check(Object.is(actual, expected), `to be ${show(expected)}`),
    toEqual: (expected: unknown) => check(equal(actual, expected), `to equal ${show(expected)}`),
    toMatchObject: (expected: unknown) => check(subset(actual, expected), `to match ${show(expected)}`),
    toMatch: (pattern: RegExp) => check(typeof actual === "string" && pattern.test(actual), `to match ${pattern}`),
    toContain: (item: unknown) =>
      check(Array.isArray(actual) && actual.some((value) => Object.is(value, item)), `to contain ${show(item)}`),
    toHaveLength: (length: number) =>
      check((actual as { length: number }).length === length, `to have length ${length}`),
    toBeNull: () => check(actual === null, "to be null"),
    toBeUndefined: () => check(actual === undefined, "to be undefined"),
    toBeDefined: () => check(actual !== undefined, "to be defined"),
    toBeGreaterThan: (bound: number) => check((actual as number) > bound, `to be > ${bound}`),
    toBeGreaterThanOrEqual: (bound: number) => check((actual as number) >= bound, `to be >= ${bound}`),
    toBeLessThanOrEqual: (bound: number) => check((actual as number) <= bound, `to be <= ${bound}`),
  }
}

export function expect<T>(actual: T) {
  return Object.assign(matchers(actual, false), { not: matchers(actual, true) })
}
