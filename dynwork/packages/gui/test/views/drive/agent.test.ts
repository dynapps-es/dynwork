import { describe, expect, test } from "bun:test"
import type { Link } from "../../../src/drive/contract"
import { arrivals, landing, latest } from "../../../src/views/drive/model"

// What the window does with the documents the agent made: one card per document, and a tab for each new one.

const link = (document: string, act: Link["act"], at: number, conversation = "ses_q3"): Link => ({
  conversation,
  document,
  act,
  via: "mcp",
  at,
})

describe("the chat's artifacts", () => {
  test("a document edited twenty times is one card, with what the chat did last, newest card first", () => {
    const links = [link("a", "created", 1), link("b", "created", 2), link("a", "edited", 3), link("a", "edited", 4)]
    expect(latest(links).map((item) => [item.document, item.act, item.at])).toEqual([
      ["a", "edited", 4],
      ["b", "created", 2],
    ])
  })
})

describe("the documents that open beside their chat", () => {
  test("what the window has read is brought up to date, so reading it again finds nothing new", () => {
    const seen = new Set<string>()
    expect(arrivals([link("a", "created", 1), link("b", "edited", 2)], seen).map((item) => item.document)).toEqual([
      "a",
      "b",
    ])
    expect(arrivals([link("a", "created", 1), link("b", "edited", 2)], seen)).toEqual([])
  })

  test("a document the chat made or changed arrives once, oldest first, whatever it does to it next", () => {
    const seen = new Set<string>()
    arrivals([], seen)
    expect(arrivals([link("b", "proposed", 3), link("a", "created", 2)], seen).map((item) => item.document)).toEqual([
      "a",
      "b",
    ])
    expect(arrivals([link("a", "edited", 9), link("a", "created", 2), link("b", "proposed", 3)], seen)).toEqual([])
  })

  test("what the user attached, or the agent only read, opens no tab", () => {
    const seen = new Set<string>()
    expect(arrivals([link("a", "attached", 1), link("b", "read", 2)], seen)).toEqual([])
    // The attachment was seen: the agent editing it later does not open it over the user's own tab choice.
    expect(arrivals([link("a", "attached", 1), link("a", "edited", 5)], seen)).toEqual([])
  })

  test("the same document in another chat is that chat's own arrival", () => {
    const seen = new Set<string>()
    arrivals([link("a", "created", 1, "ses_q3")], seen)
    expect(arrivals([link("a", "created", 1, "ses_q3"), link("a", "edited", 2, "ses_other")], seen)).toEqual([
      link("a", "edited", 2, "ses_other"),
    ])
  })
})

describe("how an arrival lands in the strip", () => {
  test("a document the agent created is selected and stays; a change to one without a tab takes the preview tab", () => {
    expect(landing("created")).toBe("select")
    expect(landing("edited")).toBe("preview")
    expect(landing("proposed")).toBe("preview")
  })

  test("several changes in a row each ask for the preview tab, and a creation in between asks for its own", () => {
    const seen = new Set<string>()
    arrivals([], seen)
    const batch = [link("a", "edited", 1), link("b", "edited", 2), link("c", "created", 3), link("d", "proposed", 4)]
    expect(arrivals(batch, seen).map((item) => [item.document, landing(item.act)])).toEqual([
      ["a", "preview"],
      ["b", "preview"],
      ["c", "select"],
      ["d", "preview"],
    ])
  })
})
