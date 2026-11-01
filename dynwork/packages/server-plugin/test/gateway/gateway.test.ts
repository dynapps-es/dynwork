import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { DynWorkSync } from "../../src/contract"
import { DynWorkGateway } from "../../src/gateway"
import { alpha, apply } from "../fixture"

// The provider an apply builds and the JWT decisions of each model call, without a service: the live test runs the
// same code inside OpenCode's model.request and retry hooks.

const gateway = {
  label: "Dynapps (Alpha)",
  // A repeated id keeps the last entry, like the manifest's skills and agents.
  models: [
    { id: "claude-sonnet-5-5", name: "replaced", api: "chat" },
    { id: "deepseek-flash", api: "chat" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", api: "messages", context: 1_000_000, output: 128_000 },
  ],
  default: "claude-sonnet-5-5",
} satisfies DynWorkSync.Gateway

describe("provider", () => {
  test("the gateway's models become the systemprompt provider on the instance's /v1", () => {
    const provided = DynWorkGateway.provider(apply(alpha, { gateway }))
    expect(provided?.info).toEqual({
      id: DynWorkGateway.providerID,
      name: "Dynapps (Alpha)",
      activation: "enabled",
      package: "@opencode/ai/providers/anthropic-compatible",
      settings: { baseURL: "http://127.0.0.1:18101/v1" },
    })
    expect(provided?.baseURL).toBe("http://127.0.0.1:18101/v1")
    expect(provided?.default).toBe("claude-sonnet-5-5")
    expect(
      provided?.models.map((model) => ({
        id: String(model.id),
        providerID: String(model.providerID),
        name: model.name,
        package: model.package,
        limit: model.limit,
      })),
    ).toEqual([
      {
        id: "claude-sonnet-5-5",
        providerID: "systemprompt",
        name: "Claude Sonnet 5.5",
        package: "@opencode/ai/providers/anthropic-compatible",
        limit: { context: 1_000_000, output: 128_000 },
      },
      {
        id: "deepseek-flash",
        providerID: "systemprompt",
        name: "deepseek-flash",
        package: "@opencode/ai/providers/openai-compatible",
        limit: { context: 200_000, output: 32_000 },
      },
    ])
  })

  test("nothing in the provider carries the JWT", () => {
    expect(JSON.stringify(DynWorkGateway.provider(apply(alpha, { gateway })))).not.toContain(apply().jwt)
  })

  test.each([
    ["https://sp.example.com", "https://sp.example.com/v1"],
    ["https://sp.example.com/", "https://sp.example.com/v1"],
    ["https://sp.example.com/tenant//", "https://sp.example.com/tenant/v1"],
    ["http://localhost:18102", "http://localhost:18102/v1"],
  ])("the instance %p calls the gateway at %p", (url, baseURL) => {
    expect(DynWorkGateway.provider(apply(alpha, { gateway, instance: { key: "a", url } }))?.baseURL).toBe(baseURL)
  })

  test("no provider without a gateway, without models, or on plain HTTP to a remote host", () => {
    expect(DynWorkGateway.provider(apply())).toBeUndefined()
    expect(DynWorkGateway.provider(apply(alpha, { gateway: { ...gateway, models: [] } }))).toBeUndefined()
    expect(
      DynWorkGateway.provider(apply(alpha, { gateway, instance: { key: "a", url: "http://sp.example.com" } })),
    ).toBeUndefined()
  })

  test("a default the gateway does not serve is dropped", () => {
    expect(
      DynWorkGateway.provider(apply(alpha, { gateway: { ...gateway, default: "gpt-9" } }))?.default,
    ).toBeUndefined()
  })

  test("the contract refuses model ids that are not plain ids", () => {
    const decode = Schema.decodeUnknownOption(DynWorkSync.Gateway)
    expect(decode({ label: "A", models: [{ id: "claude-sonnet-5-5[1m]", api: "messages" }] })._tag).toBe("None")
    expect(decode({ label: "A", models: [{ id: "../x", api: "messages" }] })._tag).toBe("None")
    expect(decode({ label: "A", models: [{ id: "m", api: "responses" }] })._tag).toBe("None")
    expect(decode({ label: "", models: [] })._tag).toBe("None")
    expect(decode({ label: "A", models: [{ id: "go-glm-5.3", api: "chat" }] })._tag).toBe("Some")
  })
})

// A stand-in for the plugin's events: `refresh` runs `answer`, as main would by pushing a token.
function harness(answer: (tokens: DynWorkGateway.Tokens) => void = () => {}) {
  const tokens = DynWorkGateway.tokens(50)
  const heard: string[] = []
  const events: DynWorkGateway.Events = {
    refresh: (reason) =>
      Effect.sync(() => {
        heard.push(`refresh:${reason}`)
        queueMicrotask(() => answer(tokens))
      }),
    rejected: () => Effect.sync(() => void heard.push("rejected")),
  }
  return { tokens, heard, events }
}

const run = Effect.runPromise
const later = (ms = 3_600_000) => Date.now() + ms

describe("authorize", () => {
  test("a fresh JWT goes out as is, without asking main", async () => {
    const h = harness()
    DynWorkGateway.push(h.tokens, { jwt: "one", expiresAt: later() })
    expect(await run(DynWorkGateway.authorize(h.tokens, h.events, "ses_a"))).toBe("one")
    expect(h.heard).toEqual([])
    expect(h.tokens.sent.get("ses_a")).toBe("one")
  })

  test("after a renewal only the new JWT goes out", async () => {
    const h = harness()
    DynWorkGateway.push(h.tokens, { jwt: "one", expiresAt: later() })
    DynWorkGateway.push(h.tokens, { jwt: "two", expiresAt: later() })
    expect(await run(DynWorkGateway.authorize(h.tokens, h.events, "ses_a"))).toBe("two")
  })

  test("an expired JWT is renewed first, and concurrent calls share one request", async () => {
    const h = harness((tokens) => DynWorkGateway.push(tokens, { jwt: "two", expiresAt: later() }))
    DynWorkGateway.push(h.tokens, { jwt: "one", expiresAt: Date.now() - 1 })
    expect(
      await run(
        Effect.all(
          [
            DynWorkGateway.authorize(h.tokens, h.events, "ses_a"),
            DynWorkGateway.authorize(h.tokens, h.events, "ses_b"),
          ],
          { concurrency: "unbounded" },
        ),
      ),
    ).toEqual(["two", "two"])
    expect(h.heard).toEqual(["refresh:expired"])
    expect(h.tokens.waiters.size).toBe(0)
  })

  test("an expired JWT is never sent, even when main does not answer", async () => {
    const h = harness()
    DynWorkGateway.push(h.tokens, { jwt: "one", expiresAt: Date.now() - 1 })
    expect(await run(DynWorkGateway.authorize(h.tokens, h.events, "ses_a"))).toBeUndefined()
    expect(h.heard).toEqual(["refresh:expired"])
    expect(h.tokens.sent.has("ses_a")).toBe(false)
    expect(h.tokens.waiters.size).toBe(0)
  })

  test("a JWT close to expiry is still sent while main does not answer", async () => {
    const h = harness()
    DynWorkGateway.push(h.tokens, { jwt: "one", expiresAt: later(DynWorkGateway.skew / 2) })
    expect(await run(DynWorkGateway.authorize(h.tokens, h.events, "ses_a"))).toBe("one")
    expect(h.heard).toEqual(["refresh:expired"])
  })

  test("a sign-out while a JWT close to expiry waits sends no JWT", async () => {
    const h = harness((tokens) => DynWorkGateway.push(tokens, undefined))
    DynWorkGateway.push(h.tokens, { jwt: "one", expiresAt: later(DynWorkGateway.skew / 2) })
    expect(await run(DynWorkGateway.authorize(h.tokens, h.events, "ses_a"))).toBeUndefined()
  })

  test("main pushing the same JWT again does not end the wait", async () => {
    const h = harness((tokens) => DynWorkGateway.push(tokens, { jwt: "one", expiresAt: Date.now() - 1 }))
    DynWorkGateway.push(h.tokens, { jwt: "one", expiresAt: Date.now() - 1 })
    expect(await run(DynWorkGateway.authorize(h.tokens, h.events, "ses_a"))).toBeUndefined()
  })

  test("signed out, a call carries no JWT", async () => {
    const h = harness()
    expect(await run(DynWorkGateway.authorize(h.tokens, h.events, "ses_a"))).toBeUndefined()
    expect(h.heard).toEqual([])
  })
})

describe("refused", () => {
  const sent = async (h: ReturnType<typeof harness>, jwt: string) => {
    DynWorkGateway.push(h.tokens, { jwt, expiresAt: later() })
    expect(await run(DynWorkGateway.authorize(h.tokens, h.events, "ses_a"))).toBe(jwt)
  }

  test("a first refusal gets a new JWT from main and the call runs again with it", async () => {
    const h = harness((tokens) => DynWorkGateway.push(tokens, { jwt: "two", expiresAt: later() }))
    await sent(h, "one")
    expect(await run(DynWorkGateway.refused(h.tokens, h.events, "ses_a", true))).toBe(true)
    expect(h.heard).toEqual(["refresh:rejected"])
    expect(await run(DynWorkGateway.authorize(h.tokens, h.events, "ses_a"))).toBe("two")
  })

  test("a refusal of the JWT main minted for it signs the instance out", async () => {
    const h = harness((tokens) => DynWorkGateway.push(tokens, { jwt: "two", expiresAt: later() }))
    await sent(h, "one")
    expect(await run(DynWorkGateway.refused(h.tokens, h.events, "ses_a", true))).toBe(true)
    expect(await run(DynWorkGateway.authorize(h.tokens, h.events, "ses_a"))).toBe("two")
    expect(await run(DynWorkGateway.refused(h.tokens, h.events, "ses_a", false))).toBe(false)
    expect(h.heard).toEqual(["refresh:rejected", "rejected"])
    expect(h.tokens.current).toBeUndefined()
    expect(await run(DynWorkGateway.authorize(h.tokens, h.events, "ses_a"))).toBeUndefined()
  })

  test("a later step's first refusal asks again instead of signing out", async () => {
    const mints = ["two", "three"]
    const h = harness((tokens) => DynWorkGateway.push(tokens, { jwt: mints.shift() ?? "", expiresAt: later() }))
    await sent(h, "one")
    expect(await run(DynWorkGateway.refused(h.tokens, h.events, "ses_a", true))).toBe(true)
    expect(await run(DynWorkGateway.authorize(h.tokens, h.events, "ses_a"))).toBe("two")
    // The retried call succeeded; a new step's call is refused later.
    expect(await run(DynWorkGateway.authorize(h.tokens, h.events, "ses_a"))).toBe("two")
    expect(await run(DynWorkGateway.refused(h.tokens, h.events, "ses_a", true))).toBe(true)
    expect(h.heard).toEqual(["refresh:rejected", "refresh:rejected"])
    expect(h.tokens.current?.jwt).toBe("three")
  })

  test("a refusal of a JWT older than the held one runs again without asking main", async () => {
    const h = harness()
    await sent(h, "one")
    DynWorkGateway.push(h.tokens, { jwt: "two", expiresAt: later() })
    expect(await run(DynWorkGateway.refused(h.tokens, h.events, "ses_a", true))).toBe(true)
    expect(h.heard).toEqual([])
  })

  test("without an answer from main the error surfaces and the instance stays signed in", async () => {
    const h = harness()
    await sent(h, "one")
    expect(await run(DynWorkGateway.refused(h.tokens, h.events, "ses_a", true))).toBe(false)
    expect(h.heard).toEqual(["refresh:rejected"])
    expect(h.tokens.current?.jwt).toBe("one")
  })

  test("a sign-out while the call waits ends it without a retry", async () => {
    const h = harness((tokens) => DynWorkGateway.push(tokens, undefined))
    await sent(h, "one")
    expect(await run(DynWorkGateway.refused(h.tokens, h.events, "ses_a", true))).toBe(false)
    expect(h.tokens.sent.size).toBe(0)
  })

  test("signed out, a refusal is final", async () => {
    const h = harness()
    expect(await run(DynWorkGateway.refused(h.tokens, h.events, "ses_a", true))).toBe(false)
    expect(h.heard).toEqual([])
  })
})

test("only the most recent Sessions are remembered", async () => {
  const h = harness()
  DynWorkGateway.push(h.tokens, { jwt: "one", expiresAt: later() })
  await run(
    Effect.forEach(
      Array.from({ length: 300 }, (_, index) => `ses_${index}`),
      (id) => DynWorkGateway.authorize(h.tokens, h.events, id),
    ),
  )
  expect(h.tokens.sent.size).toBe(256)
  expect(h.tokens.sent.has("ses_299")).toBe(true)
  expect(h.tokens.sent.has("ses_0")).toBe(false)
})
