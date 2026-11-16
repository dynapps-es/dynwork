import { describe, expect, test } from "bun:test"
import { DynWorkIdentity } from "@dynwork/branding/identity"
import { channelPill } from "../../src/views/channel"
import en from "../../src/views/en"

const t = (key: string) => (en as Record<string, string>)[key] ?? key

describe("the channel pill", () => {
  test("internal shows none", () => {
    expect(channelPill("internal", t)).toBeUndefined()
  })

  test.each([
    ["canary", "Canary"],
    ["dev", "Dev"],
  ] as const)("%s shows %s", (channel, label) => {
    expect(channelPill(channel, t)).toBe(label)
  })

  // A new channel without a string would show its key on the screen.
  test("every channel but internal has a string", () => {
    const missing = Object.keys(DynWorkIdentity.table).filter(
      (channel) => channel !== "internal" && !(`views.channel.${channel}` in en),
    )

    expect(missing).toEqual([])
  })
})
