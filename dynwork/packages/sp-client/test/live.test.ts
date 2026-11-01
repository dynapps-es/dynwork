import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { Effect } from "effect"
import path from "node:path"
import { SpClient } from "../src"
import { Jcs } from "../src/jcs"

// Against the two local instances of `bun dynwork/script/sp-local.ts` (alpha and beta). Runs only when SP_LOCAL_ENV
// points at the harness's generated env file, relative to the package directory; the package verify sets it.
// Nothing here prints a credential: assertions compare shapes, prefixes and booleans, never a token's value.

const envPath = process.env.SP_LOCAL_ENV === undefined ? undefined : path.resolve(process.env.SP_LOCAL_ENV)
const repo = path.resolve(import.meta.dir, "../../../..")
const compose = path.join(repo, "dynwork/test/sp-local/compose.yml")
// The name the PATs minted here get, so afterAll revokes exactly those
const deviceName = "DynWork sp-client test"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const fail = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect))

async function readEnv() {
  if (envPath === undefined) return {}
  const text = await Bun.file(envPath).text()
  return Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  )
}

const env = await readEnv()

describe.skipIf(envPath === undefined)("live local instances", () => {
  for (const name of ["alpha", "beta"] as const) {
    describe(name, () => {
      const base = env[`SP_${name.toUpperCase()}_URL`] ?? ""
      const pat = env[`SP_${name.toUpperCase()}_PAT`] ?? ""
      const state: { session?: SpClient.Session; key?: string } = {}

      beforeAll(async () => {
        state.session = await run(SpClient.mintJwt(base, pat))
        state.key = (await run(SpClient.publicKey(base))).key
      })

      test("discover reports the 0.76 contract, the device-link page and the PAT mode", async () => {
        const instance = await run(SpClient.discover(base))
        console.log(
          `${name} ${base}: contract discovered=${instance.discovered} version ${instance.version} modes ${instance.modes.join(",")}`,
        )
        expect(instance.discovered).toBe(true)
        expect(instance.version).toBe("0.76.0")
        expect(instance.deviceLinkPath).toBe("/bridge-auth/device-link")
        expect(instance.modes).toContain("pat")
        expect(instance.enabledHosts).toContain("opencode")
      })

      test("mints a JWT from the seeded PAT", () => {
        expect(state.session?.token.startsWith("eyJ")).toBe(true)
        expect(state.session?.ttl).toBeGreaterThan(0)
        expect(state.session?.sessionId).toStartWith("sess_")
      })

      test("verifies the signed manifest, whose payload is JCS canonical and carries the seeded content", async () => {
        const result = await run(
          SpClient.manifest(base, state.session?.token ?? "", { key: state.key ?? "", fresh: true }),
        )
        if (result._tag !== "Manifest") throw new Error("expected a manifest")
        console.log(
          `${name}: manifest ${result.etag.slice(0, 13)}… skills ${result.manifest.skills.length}, agents ${result.manifest.agents.length}, mcp ${result.manifest.managed_mcp_servers.length}, rules ${result.manifest.rules.length}`,
        )
        expect(Jcs.canonicalize(JSON.parse(result.payload)) === result.payload).toBe(true)
        expect(result.manifest.skills.map((skill) => skill.id)).toContain(`${name}_review`)
        expect(result.manifest.agents.map((agent) => agent.id)).toContain(`${name}_helper`)
        expect(result.manifest.managed_mcp_servers.map((server) => server.id)).toContain(`${name}-docs`)
        expect(result.manifest.rules.map((rule) => rule.id)).toContain(`${name}_conventions`)
        const again = await run(
          SpClient.manifest(base, state.session?.token ?? "", { key: state.key ?? "", etag: result.etag }),
        )
        expect(again._tag).toBe("NotModified")
      })

      test("reads the profile, the model catalog and the identity", async () => {
        const token = state.session?.token ?? ""
        const profile = await run(SpClient.profile(base, token))
        const models = await run(SpClient.models(base, token))
        const me = await run(SpClient.whoami(base, token))
        console.log(
          `${name}: ${profile.models.length} admitted models, ${models.length} in the catalog, user ${me.email}`,
        )
        expect(profile.models.length).toBeGreaterThan(0)
        expect(models.map((model) => model.id)).toEqual(expect.arrayContaining([...profile.models]))
        expect(me.email).toBe(env[`SP_${name.toUpperCase()}_USER_EMAIL`])
      })

      test("a forged JWT is unauthorized, and withJwt recovers by minting again", async () => {
        const forged = { token: "eyJforged", ttl: 3600, expiresAt: 0 }
        const error = await fail(SpClient.whoami(base, forged.token))
        expect(error).toBeInstanceOf(SpClient.Unauthorized)
        const result = await run(SpClient.withJwt(base, pat, forged, (token) => SpClient.whoami(base, token)))
        expect(result.value.email).toBe(env[`SP_${name.toUpperCase()}_USER_EMAIL`])
      })
    })
  }

  test("alpha's manifest checked against beta's key is a key change", async () => {
    const session = await run(SpClient.mintJwt(env.SP_ALPHA_URL ?? "", env.SP_ALPHA_PAT ?? ""))
    const beta = await run(SpClient.publicKey(env.SP_BETA_URL ?? ""))
    const error = await fail(SpClient.manifest(env.SP_ALPHA_URL ?? "", session.token, { key: beta.key }))
    expect(error).toBeInstanceOf(SpClient.KeyChanged)
  })

  describe("code exchange on alpha", () => {
    afterAll(async () => {
      const revoked = await revokeMinted()
      console.log(`alpha: revoked ${revoked} PAT(s) named "${deviceName}"`)
    })

    test("a fresh one-time code becomes a PAT once; the PAT mints a JWT until it is revoked", async () => {
      await $`bun dynwork/script/sp-local.ts code alpha`.cwd(repo).quiet()
      const fresh = await readEnv()
      const base = fresh.SP_ALPHA_URL ?? ""
      const minted = await run(SpClient.exchangeCode(base, fresh.SP_ALPHA_EXCHANGE_CODE ?? "", deviceName))
      expect(minted.startsWith("sp-live-")).toBe(true)
      expect((await run(SpClient.mintJwt(base, minted))).token.startsWith("eyJ")).toBe(true)
      const reused = await fail(SpClient.exchangeCode(base, fresh.SP_ALPHA_EXCHANGE_CODE ?? "", deviceName))
      expect(reused).toBeInstanceOf(SpClient.Unauthorized)
      expect(await revokeMinted()).toBe(1)
      const revoked = await fail(SpClient.mintJwt(base, minted))
      expect(revoked).toBeInstanceOf(SpClient.Unauthorized)
      expect(JSON.stringify(revoked).includes(minted)).toBe(false)
    }, 60_000)
  })
})

// Revokes every live PAT named `deviceName` with the instance's own CLI, as `sp-local.ts capture` does.
async function revokeMinted() {
  const cli = (...args: string[]) =>
    $`docker compose -p dynwork-sp-local -f ${compose} --env-file ${envPath ?? ""} exec -T alpha /app/bin/systemprompt ${args}`
      .cwd(repo)
      .quiet()
      .text()
  const user = env.SP_ALPHA_USER_ID ?? ""
  const card: { sections: { content: { id: string; name: string; revoked_at: string | null }[] }[] } = JSON.parse(
    await cli("admin", "users", "api-key", "list", "--user", user, "--json"),
  )
  const mine = (card.sections[0]?.content ?? []).filter((key) => key.name === deviceName && key.revoked_at === null)
  for (const key of mine) await cli("admin", "users", "api-key", "revoke", "--user", user, "--id", key.id)
  return mine.length
}
