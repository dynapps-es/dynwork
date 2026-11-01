import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { DynWorkAccounts } from "../../src/accounts/accounts"
import { fakeSecure, memoryStore, mints, setup, startFake, type Fake } from "./fixture"

let fake: Fake

beforeAll(() => {
  fake = startFake()
})

afterAll(() => fake.stop())

describe("accounts store", () => {
  test("keeps the PAT only as ciphertext and reads it back after a restart", async () => {
    const pat = fake.issuePat()
    const first = setup(fake)
    expect(await first.accounts.signInToken({ url: fake.url, token: pat })).toBe("signed-in")
    first.accounts.dispose()

    expect(first.store.disk.json).not.toContain(pat)
    expect(first.store.disk.json).not.toContain(pat.slice(8))
    const stored = first.store.value.accounts[0]
    expect(stored).toMatchObject({ url: fake.url, label: "Dynapps", user: expect.any(String) })
    expect(stored?.patCipher).toBeString()
    expect(first.store.value.active).toBe(stored?.id)

    // A second main process over the same storage: the PAT decrypts and mints again.
    const before = mints(fake)
    const second = DynWorkAccounts.make({
      store: first.store,
      secure: first.secure,
      open: async () => {},
      deviceName: "DynWork test",
      changed: () => {},
    })
    const token = await second.jwt(stored?.id ?? "")
    expect(token).toStartWith("eyJ")
    expect(mints(fake)).toBe(before + 1)
    expect(fake.state.requests.at(-1)?.headers.authorization).toBe(`Bearer ${pat}`)
    second.dispose()
  })

  test("refuses to sign in when the OS offers no encryption, before any request", async () => {
    const context = setup(fake, { secure: fakeSecure(false) })
    const before = fake.state.requests.length
    await expect(context.accounts.signInToken({ url: fake.url, token: fake.issuePat() })).rejects.toBeInstanceOf(
      DynWorkAccounts.SecureStorageUnavailable,
    )
    await expect(context.accounts.signInBrowser(fake.url)).rejects.toBeInstanceOf(
      DynWorkAccounts.SecureStorageUnavailable,
    )
    expect(fake.state.requests.length).toBe(before)
    expect(context.store.value.accounts).toEqual([])
  })

  test("a refused PAT stores nothing and never appears in the error", async () => {
    const context = setup(fake)
    const error = await context.accounts.signInToken({ url: fake.url, token: "sp-live-not-a-real-token" }).catch(String)
    expect(error).toContain("Unauthorized")
    expect(error).not.toContain("sp-live-not-a-real-token")
    expect(context.store.value.accounts).toEqual([])
  })

  test("a pasted one-time code is exchanged for a PAT named after this machine", async () => {
    const context = setup(fake)
    expect(await context.accounts.signInToken({ url: fake.url, token: ` ${fake.issueCode()} ` })).toBe("signed-in")
    const exchange = fake.state.requests.findLast((request) => request.path === "/v1/auth/bridge/session-pat")
    expect(JSON.parse(exchange?.body ?? "{}").device_name).toBe("DynWork test")
    expect(context.accounts.list()).toMatchObject([{ status: "signedIn", active: true }])
    context.accounts.dispose()
  })

  test("a ciphertext the OS cannot open right now is kept, not signed out", async () => {
    const context = setup(fake)
    await context.accounts.signInToken({ url: fake.url, token: fake.issuePat() })
    const id = context.accounts.list()[0]?.id ?? ""
    context.accounts.dispose()
    context.secure.reset = true
    const restarted = DynWorkAccounts.make({
      store: context.store,
      secure: context.secure,
      open: async () => {},
      deviceName: "DynWork test",
      changed: () => {},
    })
    const cipher = context.store.value.accounts[0]?.patCipher
    await expect(restarted.jwt(id)).rejects.toBeInstanceOf(DynWorkAccounts.SecureStorageUnavailable)
    expect(restarted.list()).toMatchObject([{ id, status: "signedIn", active: true }])
    expect(context.store.value.accounts[0]?.patCipher).toBe(cipher)

    // Once the keyring opens again, the same PAT mints.
    context.secure.reset = false
    expect(await restarted.jwt(id)).toBeString()
    restarted.dispose()
  })

  test("an offered manifest key survives a restart and can still be trusted", async () => {
    const context = setup(fake)
    await context.accounts.signInToken({ url: fake.url, token: fake.issuePat() })
    const account = context.accounts.list()[0]
    context.accounts.dispose()
    const restarted = DynWorkAccounts.make({
      store: context.store,
      secure: context.secure,
      open: async () => {},
      deviceName: "DynWork test",
      changed: () => {},
    })
    expect(restarted.list()[0]).toMatchObject({ fingerprint: account?.fingerprint, trusted: false })
    restarted.trust({ id: account?.id ?? "", fingerprint: account?.fingerprint ?? "" })
    expect(restarted.list()[0]?.trusted).toBe(true)
    restarted.dispose()
  })

  test("windows see no secret", async () => {
    const pat = fake.issuePat()
    const context = setup(fake)
    await context.accounts.signInToken({ url: fake.url, token: pat })
    const token = await context.accounts.jwt(context.accounts.list()[0]?.id ?? "")
    const shown = JSON.stringify(context.accounts.state())
    expect(shown).not.toContain(pat)
    expect(shown).not.toContain(token)
    expect(shown).not.toContain("patCipher")
    expect(Object.keys(context.accounts.list()[0] ?? {}).toSorted()).toEqual(
      ["active", "fingerprint", "id", "label", "org", "pinned", "status", "trusted", "url", "user"].toSorted(),
    )
    context.accounts.dispose()
  })
})
