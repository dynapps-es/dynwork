import { describe, expect, test } from "bun:test"
import { DriveArtifacts } from "../../src/drive/artifacts"
import type { Document, Link } from "../../src/drive/contract"

// A conversation's documents (G07): the local index merged with what the instance lists for the conversation.

const chat = "ses_q3"
const link = (document: string, act: Link["act"], at: number, revision?: string): Link => ({
  conversation: chat,
  document,
  act,
  via: "rest",
  at,
  ...(revision === undefined ? {} : { revision }),
})
const doc = (id: string, revision: string, updated: number): Document => ({
  id,
  name: `${id}.md`,
  format: "markdown",
  mime: "text/markdown",
  owner: "user-ana",
  mine: true,
  revision,
  created: 1,
  updated,
})

describe("a conversation's documents", () => {
  test("a document both know is deduplicated by id: the index's acts, at the instance's head and the later time", () => {
    const merged = DriveArtifacts.merge(
      chat,
      [link("doc-1", "created", 10, "rev-1"), link("doc-1", "attached", 5)],
      [doc("doc-1", "rev-3", 30)],
    )
    expect(merged.map((entry) => [entry.document, entry.act, entry.revision, entry.via])).toEqual([
      ["doc-1", "created", "rev-3", "rest"],
      ["doc-1", "attached", "rev-3", "rest"],
    ])
    expect(merged.map((entry) => entry.at)).toEqual([30, 30])
    // The index's time stays when it is the later one.
    expect(
      DriveArtifacts.merge(chat, [link("doc-1", "created", 50, "rev-1")], [doc("doc-1", "rev-1", 30)])[0]?.at,
    ).toBe(50)
  })

  test("what only the instance lists is an edit of the conversation's, at its head; what only the index holds stays", () => {
    const merged = DriveArtifacts.merge(
      chat,
      [link("attached", "attached", 20)],
      [doc("elsewhere", "rev-9", 40), doc("older", "rev-2", 10)],
    )
    expect(merged).toEqual([
      { conversation: chat, document: "elsewhere", act: "edited", revision: "rev-9", via: "server", at: 40 },
      link("attached", "attached", 20),
      { conversation: chat, document: "older", act: "edited", revision: "rev-2", via: "server", at: 10 },
    ])
  })

  test("nothing listed is the index alone, newest first", () => {
    const local = [link("a", "created", 1), link("b", "edited", 3), link("c", "read", 2)]
    expect(DriveArtifacts.merge(chat, local, []).map((entry) => entry.document)).toEqual(["b", "c", "a"])
    expect(DriveArtifacts.merge(chat, [], [])).toEqual([])
  })
})
