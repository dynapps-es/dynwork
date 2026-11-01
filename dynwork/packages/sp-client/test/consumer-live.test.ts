import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { Effect } from "effect"
import { SpClient, SpConsumer } from "../src"

// The consumer API against alpha of `bun dynwork/script/sp-local.ts`: enrolment with the user's JWT, each skill
// publication's plan for OpenCode and its receipt with the device credential. Runs only when SP_LOCAL_ENV points at the
// harness's env file. Nothing here prints a credential.

const envPath = process.env.SP_LOCAL_ENV === undefined ? undefined : path.resolve(process.env.SP_LOCAL_ENV)
const env: Record<string, string> =
  envPath === undefined
    ? {}
    : Object.fromEntries(
        (await Bun.file(envPath).text())
          .split("\n")
          .filter((line) => line.includes("="))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      )

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe.skipIf(envPath === undefined)("live consumer API on alpha", () => {
  const base = env.SP_ALPHA_URL ?? ""
  const user = env.SP_ALPHA_USER_ID ?? ""

  test("enrols, reads every publication's plan for open-code and gets its receipt acknowledged", async () => {
    const session = await run(SpClient.mintJwt(base, env.SP_ALPHA_PAT ?? ""))
    const key = (await run(SpClient.publicKey(base))).key
    const served = await run(SpClient.manifest(base, session.token, { key }))
    if (served._tag !== "Manifest") throw new Error("no manifest")
    // One install per run: the instance keeps a device per fingerprint
    const device = await run(
      SpConsumer.enrol(base, session.token, {
        fingerprint: SpConsumer.fingerprint(crypto.randomUUID(), user),
        label: "DynWork sp-client test",
      }),
    )
    expect(device.consumer_id).toBe(user)
    expect(device.credential).toStartWith("sp_device_")
    const published = served.manifest.skills.flatMap((skill) => (skill.publication ? [skill.publication] : []))
    expect(published.length).toBeGreaterThan(0)
    const installation = crypto.randomUUID()
    for (const publication of published) {
      const plan = await run(SpConsumer.plan(base, device.credential, publication))
      expect(plan.runtime_files.map((file) => file.path)).toContain("SKILL.md")
      expect(plan.runtime_files.map((file) => file.path)).toContain("config.yaml")
      // Files written exactly as planned, as the plugin's readback reports them
      const readback = plan.runtime_files.map((file) => ({
        path: file.path,
        digest: createHash("sha256").update(file.bytes).digest("hex"),
        bytes: file.bytes.length,
        executable: file.executable,
        content: "verified" as const,
        mode: "verified" as const,
      }))
      const built = SpConsumer.receipt(plan, readback, installation, new Date().toISOString())
      if (!("receipt" in built)) throw new Error(`mismatch at ${built.mismatch}`)
      const first = await run(SpConsumer.post(base, device.credential, built.receipt))
      const again = await run(SpConsumer.post(base, device.credential, built.receipt))
      expect(first.fully_verified).toBe(true)
      expect(first.acknowledgement).toBe("accepted")
      expect(again.acknowledgement).toBe("identical_retry")
      expect(again.receipt_id).toBe(first.receipt_id)
      // A Session the governance events reported, bound to the receipt as the bridge's outbox binds it
      const session = crypto.randomUUID()
      const bound = await run(SpConsumer.bind(base, device.credential, { receipt_id: first.receipt_id, session_id: session }))
      expect(await run(SpConsumer.bind(base, device.credential, { receipt_id: first.receipt_id, session_id: session }))).toEqual(bound)
    }
  })
})
