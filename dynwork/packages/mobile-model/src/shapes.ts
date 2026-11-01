export * as Shapes from "./shapes"

// What `bun dynwork/script/record-session.ts --check` compares: the structure, never the values, of every event and
// message type in a set of fixture lines. Keys are unioned over every sample of a type, so a field that one run happens
// not to carry does not look like a change; a new field, a missing one or another type does.

type Node = { kinds: Set<string>; props: Map<string, Node>; items?: Node }

export type Shapes = Record<string, string>

/** The lines of a fixture file, as the recorder wrote them. */
export type Line =
  | { kind: "meta" }
  | { kind: "event"; event: { type: string } }
  | {
      kind: "snapshot"
      snapshot: {
        sessions: ReadonlyArray<unknown>
        messages: Readonly<Record<string, ReadonlyArray<unknown>>>
        permissions: ReadonlyArray<unknown>
        forms: ReadonlyArray<unknown>
      }
    }

export function of(lines: ReadonlyArray<Line>): Shapes {
  const nodes = new Map<string, Node>()
  const add = (key: string, value: unknown) => nodes.set(key, merge(nodes.get(key), infer(value)))
  lines.forEach((line) => {
    if (line.kind === "event") return add(`event ${line.event.type}`, line.event)
    if (line.kind !== "snapshot") return
    line.snapshot.sessions.forEach((session) => add("session", session))
    Object.values(line.snapshot.messages)
      .flat()
      .forEach((message) => add(`message ${(message as { type?: string }).type ?? "?"}`, message))
    line.snapshot.permissions.forEach((permission) => add("permission", permission))
    line.snapshot.forms.forEach((form) => add("form", form))
  })
  return Object.fromEntries([...nodes].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, node]) => [key, print(node)]))
}

/** One line per difference, empty when the shapes agree. */
export function compare(expected: Shapes, actual: Shapes): string[] {
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort().flatMap((key) => {
    if (expected[key] === actual[key]) return []
    if (expected[key] === undefined) return [`${key}: not in the fixtures, now recorded as ${actual[key]}`]
    if (actual[key] === undefined) return [`${key}: in the fixtures, no longer recorded`]
    return [`${key}: was ${expected[key]}, now ${actual[key]}`]
  })
}

function infer(value: unknown): Node {
  if (value === null) return { kinds: new Set(["null"]), props: new Map() }
  if (Array.isArray(value))
    return {
      kinds: new Set(["array"]),
      props: new Map(),
      items: value.map(infer).reduce<Node | undefined>((all, item) => merge(all, item), undefined),
    }
  if (typeof value === "object")
    return {
      kinds: new Set(["object"]),
      props: new Map(Object.entries(value).map(([key, item]) => [key, infer(item)])),
    }
  return { kinds: new Set([typeof value]), props: new Map() }
}

function merge(left: Node | undefined, right: Node): Node
function merge(left: Node | undefined, right: Node | undefined): Node | undefined
function merge(left: Node | undefined, right: Node | undefined) {
  if (!left) return right
  if (!right) return left
  const props = new Map(left.props)
  right.props.forEach((node, key) => props.set(key, merge(props.get(key), node)!))
  return { kinds: new Set([...left.kinds, ...right.kinds]), props, items: merge(left.items, right.items) }
}

function print(node: Node): string {
  const parts = [...node.kinds].sort().map((kind) => {
    if (kind === "object")
      return `{${[...node.props]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, child]) => `${key}: ${print(child)}`)
        .join(", ")}}`
    if (kind === "array") return `${node.items ? print(node.items) : "never"}[]`
    return kind
  })
  return parts.length > 1 ? `(${parts.join(" | ")})` : (parts[0] ?? "never")
}
