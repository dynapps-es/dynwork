import { describe, expect, test } from "bun:test"
import { DriveCapabilities } from "../../src/drive/capabilities"

// Each capability waits for the instance (`docs/ed/` of the Drive plan). Every decision it changes is tested off, as
// today, and on, as once delivered.

const on = (...keys: DriveCapabilities.Key[]) => ({
  ...DriveCapabilities.none,
  ...Object.fromEntries(keys.map((key) => [key, true])),
})

describe("the Drive capabilities", () => {
  test("are the nine the plan names, and all off today", () => {
    expect(Object.keys(DriveCapabilities.none).toSorted()).toEqual(
      [
        "personActions",
        "conversationLabel",
        "rangeComments",
        "pdfComments",
        "rawHtmlByMcp",
        "mcpFolders",
        "contextByMcp",
        "docsByContext",
        "pushChanges",
      ].toSorted(),
    )
    expect(Object.values(DriveCapabilities.none).every((value) => value === false)).toBe(true)
  })

  test("personActions: a direct write is '<user> by DynWork' while off, and the person's own when on", () => {
    const author = { user: "ana@dynapps.es" }
    expect(DriveCapabilities.attribution(DriveCapabilities.none, author)).toEqual({
      contextId: undefined,
      message: "ana@dynapps.es by DynWork",
    })
    expect(DriveCapabilities.attribution(on("personActions"), author)).toEqual({
      contextId: undefined,
      message: undefined,
    })
  })

  test("conversationLabel: a conversation's write names it in the message while off, and only by context when on", () => {
    const author = { user: "ana@dynapps.es", conversation: { name: "Q3 report", context: "ctx-1" } }
    expect(DriveCapabilities.attribution(DriveCapabilities.none, author)).toEqual({
      contextId: "ctx-1",
      message: "Q3 report by DynWork",
    })
    expect(DriveCapabilities.attribution(on("conversationLabel"), author)).toEqual({
      contextId: "ctx-1",
      message: undefined,
    })
    // Acting as the person does not change how a conversation's write is told apart.
    expect(DriveCapabilities.attribution(on("personActions"), author).message).toBe("Q3 report by DynWork")
  })

  test("rangeComments: a cell range takes a comment only when on; a node always does", () => {
    const range = { kind: "range" as const, sheet: 0, from: "A1", to: "B3" }
    expect(DriveCapabilities.anchorable(DriveCapabilities.none, range)).toBe(false)
    expect(DriveCapabilities.anchorable(on("rangeComments"), range)).toBe(true)
    expect(DriveCapabilities.anchorable(on("pdfComments"), range)).toBe(false)
    expect(DriveCapabilities.anchorable(DriveCapabilities.none, { kind: "node", node: "n1" })).toBe(true)
  })

  test("pdfComments: a point on a PDF takes a comment only when on", () => {
    const page = { kind: "page" as const, page: 2, x: 0.1, y: 0.9 }
    expect(DriveCapabilities.anchorable(DriveCapabilities.none, page)).toBe(false)
    expect(DriveCapabilities.anchorable(on("pdfComments"), page)).toBe(true)
    expect(DriveCapabilities.anchorable(on("rangeComments"), page)).toBe(false)
  })

  test("pushChanges: a watched Drive is polled every 20 s while off, and every 5 min when on", () => {
    expect(DriveCapabilities.pollEvery(DriveCapabilities.none, false)).toBe(5 * 60_000)
    expect(DriveCapabilities.pollEvery(DriveCapabilities.none, true)).toBe(20_000)
    expect(DriveCapabilities.pollEvery(on("pushChanges"), true)).toBe(5 * 60_000)
    expect(DriveCapabilities.pollEvery(on("pushChanges"), false)).toBe(5 * 60_000)
  })

  test("docsByContext: every write of a conversation is indexed here while off; with it on, REST writes are not", () => {
    expect(DriveCapabilities.indexed(DriveCapabilities.none, "rest")).toBe(true)
    expect(DriveCapabilities.indexed(DriveCapabilities.none, "mcp")).toBe(true)
    expect(DriveCapabilities.indexed(on("docsByContext"), "rest")).toBe(false)
  })

  test("contextByMcp: with the Drive listing by conversation, an MCP write is indexed here until the MCP carries it", () => {
    expect(DriveCapabilities.indexed(on("docsByContext"), "mcp")).toBe(true)
    expect(DriveCapabilities.indexed(on("docsByContext", "contextByMcp"), "mcp")).toBe(false)
    // Without listing by conversation, the index is still the only place that knows.
    expect(DriveCapabilities.indexed(on("contextByMcp"), "mcp")).toBe(true)
  })

  test("mcpFolders: the agent's files are filed by DynWork over REST while off, and by the agent when on", () => {
    expect(DriveCapabilities.agentFiling(DriveCapabilities.none, "markdown")).toBe("rest")
    expect(DriveCapabilities.agentFiling(on("mcpFolders"), "markdown")).toBe("mcp")
  })

  test("rawHtmlByMcp: an agent's HTML is imported by DynWork, keeping its scripts, until the MCP writes it raw", () => {
    expect(DriveCapabilities.agentFiling(on("mcpFolders"), "html")).toBe("rest")
    expect(DriveCapabilities.agentFiling(on("mcpFolders", "rawHtmlByMcp"), "html")).toBe("mcp")
    // Raw HTML alone does not file it: the conversation's folder still needs the MCP's folders.
    expect(DriveCapabilities.agentFiling(on("rawHtmlByMcp"), "html")).toBe("rest")
  })
})
