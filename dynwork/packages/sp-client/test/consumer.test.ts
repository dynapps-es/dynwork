import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { SpClient, SpConsumer, type Publication } from "../src"
import alphaFixture from "./fixtures/alpha.json"
import { startFake } from "./fake"

// The consumer API against the fake instance, which answers with the plans, receipts and refusals observed on the local
// 0.76 harness (`fixtures/consumer.json`).

let fake: ReturnType<typeof startFake>

beforeAll(() => {
  fake = startFake()
})

afterAll(() => fake.stop())

afterEach(() => {
  fake.state.override = undefined
  fake.state.requests.length = 0
})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const failure = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect))

const publications = Object.fromEntries(
  alphaFixture.manifest.payload.skills.map((skill) => [skill.id, skill.publication as Publication]),
)
const notes = publications.alpha_notes as Publication

const jwt = async () => (await run(SpClient.mintJwt(fake.url, fake.issuePat()))).token
const enrolled = async () =>
  run(
    SpConsumer.enrol(fake.url, await jwt(), { fingerprint: SpConsumer.fingerprint("install", "user"), label: "test" }),
  )

describe("fingerprint", () => {
  test("is the bridge's device_fingerprint: one per install and user", () => {
    // sha256("systemprompt-bridge-device/v1\nprobe-install-1\n<alpha's user>"), which the local harness enrolled
    expect(SpConsumer.fingerprint("probe-install-1", "1ecce4e3-bc87-441d-b374-ea29bab88da8")).toBe(
      "16f98b56ac0d77937d7b286b89763e74879ab3ffd6556f76c9d775b93b41efcc",
    )
    expect(SpConsumer.fingerprint("a", "user")).not.toBe(SpConsumer.fingerprint("a", "other"))
  })
})

describe("enrol", () => {
  test("posts the fingerprint and label with the JWT and returns the device credential", async () => {
    const token = await jwt()
    const enrolment = await run(SpConsumer.enrol(fake.url, token, { fingerprint: "f".repeat(64), label: "DynWork" }))
    expect(enrolment.credential).toStartWith("sp_device_")
    const request = fake.state.requests.find((entry) => entry.path === "/v1/bridge/device")
    expect(request?.headers.authorization).toBe(`Bearer ${token}`)
    expect(JSON.parse(request?.body ?? "")).toEqual({ fingerprint: "f".repeat(64), label: "DynWork" })
    // The same fingerprint is the same device
    const again = await run(SpConsumer.enrol(fake.url, token, { fingerprint: "f".repeat(64), label: "DynWork" }))
    expect(again.device_id).toBe(enrolment.device_id)
  })

  test("refuses an answer whose credential is not a device credential, and maps a refused JWT", async () => {
    fake.state.override = {
      path: "/v1/bridge/device",
      status: 200,
      body: { device_id: "d", consumer_id: "u", credential: "eyJnot-a-device" },
    }
    expect(await failure(SpConsumer.enrol(fake.url, await jwt(), { fingerprint: "f", label: "l" }))).toBeInstanceOf(
      SpClient.Protocol,
    )
    fake.state.override = undefined
    expect(await failure(SpConsumer.enrol(fake.url, fake.staleJwt(), { fingerprint: "f", label: "l" }))).toBeInstanceOf(
      SpClient.Unauthorized,
    )
  })
})

describe("plan", () => {
  test("reads the publication's bundle for open-code with the device credential, bytes as bytes", async () => {
    const device = await enrolled()
    const plan = await run(SpConsumer.plan(fake.url, device.credential, notes))
    const request = fake.state.requests.find((entry) => entry.path.endsWith("/bundle"))
    expect(request?.path).toBe(
      `/api/v1/consumer/resources/${notes.resource_id}/publications/${notes.publication_id}/bundle`,
    )
    expect(request?.headers.authorization).toBe(`Bearer ${device.credential}`)
    expect(plan.runtime_files.map((file) => file.path)).toEqual([
      `.systemprompt-source/${notes.revision_id}/SKILL.md`,
      `.systemprompt-source/${notes.revision_id}/config.yaml`,
      "SKILL.md",
      "config.yaml",
    ])
    const config = plan.runtime_files.find((file) => file.path === "config.yaml")
    expect(config?.bytes).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(config?.bytes ?? []).toString()).toStartWith("id: alpha_notes\n")
  })

  test("refuses a plan for another revision than the manifest named, and a refused credential", async () => {
    const device = await enrolled()
    expect(await failure(SpConsumer.plan(fake.url, device.credential, { ...notes, generation: 2 }))).toBeInstanceOf(
      SpClient.Protocol,
    )
    const refused = await failure(SpConsumer.plan(fake.url, "sp_device_revoked", notes))
    expect(refused).toBeInstanceOf(SpClient.Unauthorized)
    expect(String(refused.message)).toBe("Valid enrolled-device authentication is required")
    expect(JSON.stringify(refused)).not.toContain("sp_device_revoked")
  })
})

const readback = (plan: SpConsumer.Plan): SpConsumer.Readback[] =>
  plan.runtime_files.map((file) => ({
    path: file.path,
    digest: createHash("sha256").update(file.bytes).digest("hex"),
    bytes: file.bytes.length,
    executable: file.executable,
    content: "verified",
    mode: "verified",
  }))

describe("receipt", () => {
  test("builds the receipt from the readback, with the canonical files checked against their copies", async () => {
    const device = await enrolled()
    const plan = await run(SpConsumer.plan(fake.url, device.credential, notes))
    const built = SpConsumer.receipt(plan, readback(plan), "installation", "2026-11-01T10:00:00Z")
    if (!("receipt" in built)) throw new Error(`mismatch at ${built.mismatch}`)
    expect(built.receipt.files.map((file) => [file.path, file.content_check, file.mode_check])).toEqual([
      ["SKILL.md", "verified", "verified"],
      ["config.yaml", "verified", "verified"],
    ])
    expect(built.receipt.runtime_files).toHaveLength(4)
    expect(built.receipt.host).toBe("open-code")
    expect(SpConsumer.fullyVerified(built.receipt)).toBe(true)
  })

  test("names the file that was not read back as planned", async () => {
    const device = await enrolled()
    const plan = await run(SpConsumer.plan(fake.url, device.credential, notes))
    const changed = readback(plan).map((entry) =>
      entry.path === "config.yaml" ? { ...entry, digest: "0".repeat(64) } : entry,
    )
    expect(SpConsumer.receipt(plan, changed, "i", "2026-11-01T10:00:00Z")).toEqual({ mismatch: "config.yaml" })
    const missing = readback(plan).filter((entry) => !entry.path.startsWith(".systemprompt-source/"))
    expect(SpConsumer.receipt(plan, missing, "i", "2026-11-01T10:00:00Z")).toEqual({
      mismatch: `.systemprompt-source/${notes.revision_id}/SKILL.md`,
    })
  })

  test("posts it with the device credential: accepted once, then acknowledged as an identical retry", async () => {
    const device = await enrolled()
    const plan = await run(SpConsumer.plan(fake.url, device.credential, notes))
    const built = SpConsumer.receipt(plan, readback(plan), crypto.randomUUID(), "2026-11-01T10:00:00Z")
    if (!("receipt" in built)) throw new Error("mismatch")
    const first = await run(SpConsumer.post(fake.url, device.credential, built.receipt))
    const second = await run(SpConsumer.post(fake.url, device.credential, built.receipt))
    expect(first.acknowledgement).toBe("accepted")
    expect(second).toEqual({ ...first, acknowledgement: "identical_retry" })
    fake.state.override = { path: "/api/v1/consumer/receipts", status: 503 }
    expect(await failure(SpConsumer.post(fake.url, device.credential, built.receipt))).toBeInstanceOf(
      SpClient.Unreachable,
    )
  })
})

describe("bind", () => {
  // `SessionBindingRequest`: one native session against an acknowledged receipt, host `open-code`, as the bridge posts
  // it from its outbox (`feedback/sync.rs`).
  test("binds a session to an acknowledged receipt with the device credential; the same again is the same binding", async () => {
    const device = await enrolled()
    const plan = await run(SpConsumer.plan(fake.url, device.credential, notes))
    const built = SpConsumer.receipt(plan, readback(plan), crypto.randomUUID(), "2026-11-01T10:00:00Z")
    if (!("receipt" in built)) throw new Error("mismatch")
    const acknowledged = await run(SpConsumer.post(fake.url, device.credential, built.receipt))
    const session = "5de1b7f7-3c8e-5c6a-9885-2317b386feb1"
    const first = await run(SpConsumer.bind(fake.url, device.credential, { receipt_id: acknowledged.receipt_id, session_id: session }))
    const again = await run(SpConsumer.bind(fake.url, device.credential, { receipt_id: acknowledged.receipt_id, session_id: session }))
    expect(again).toEqual(first)
    const sent = fake.state.requests.findLast((request) => request.path === "/api/v1/consumer/session-bindings")
    expect(JSON.parse(sent?.body ?? "")).toEqual({ receipt_id: acknowledged.receipt_id, host: "open-code", session_id: session })
    expect(sent?.headers.authorization).toBe(`Bearer ${device.credential}`)
    // A receipt the instance does not hold for this device: refused for good (403 on 0.76)
    const unknown = await failure(SpConsumer.bind(fake.url, device.credential, { receipt_id: crypto.randomUUID(), session_id: session }))
    expect(unknown).toBeInstanceOf(SpClient.Protocol)
    expect(unknown instanceof SpClient.Protocol && unknown.status).toBe(403)
    // An unknown device credential is 403 there too, unlike the other consumer routes; a JWT is 401
    const stranger = await failure(SpConsumer.bind(fake.url, "sp_device_unknown", { receipt_id: acknowledged.receipt_id, session_id: session }))
    expect(stranger instanceof SpClient.Protocol && stranger.status).toBe(403)
    expect(await failure(SpConsumer.bind(fake.url, "eyJ.jwt", { receipt_id: acknowledged.receipt_id, session_id: session }))).toBeInstanceOf(SpClient.Unauthorized)
  })
})
