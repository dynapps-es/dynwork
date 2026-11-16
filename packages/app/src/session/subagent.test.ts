import { expect, test } from "bun:test"
import { isSubagentSession } from "./subagent"

test.each([
  ["a root session has the composer", undefined, { metadata: { conversation: true } }, false],
  ["a plain child is a subagent's: the SubagentBar, no composer", "ses_parent", { metadata: { other: 1 } }, true],
  ["a child without metadata is a subagent's", "ses_parent", {}, true],
  [
    "a child whose metadata marks it a conversation has the composer",
    "ses_parent",
    { metadata: { conversation: true } },
    false,
  ],
  ["only `conversation: true` marks it", "ses_parent", { metadata: { conversation: "true" } }, true],
  ["a child whose data has not loaded stays a subagent's", "ses_parent", undefined, true],
])("%s", (_name, parentID, info, subagent) => {
  expect(isSubagentSession(parentID, info)).toBe(subagent)
})
