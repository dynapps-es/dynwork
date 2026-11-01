import { uptime } from "node:os"
import { Schema } from "effect"
import { DynWorkAccounts } from "../../src/accounts/accounts"
import { startFake } from "../../../sp-client/test/fake"

export type Fake = ReturnType<typeof startFake>

// What main's `ctx.storage.store` does with a value: canonical JSON of the schema, decoded again on read.
export function memoryStore() {
  const encode = Schema.encodeSync(Schema.fromJsonString(DynWorkAccounts.Store))
  const decode = Schema.decodeUnknownSync(Schema.fromJsonString(DynWorkAccounts.Store))
  const disk = { json: encode(DynWorkAccounts.initial) }
  return {
    disk,
    get value() {
      return decode(disk.json)
    },
    set(value: DynWorkAccounts.Store) {
      disk.json = encode(value)
    },
  }
}

// Stands in for Electron's safeStorage: a reversible scramble that never leaves the plaintext readable. `reset`
// models a keychain that no longer opens what it sealed.
export function fakeSecure(available = true) {
  const secure = {
    available,
    reset: false,
    isEncryptionAvailable: () => secure.available,
    encryptString: (plain: string) =>
      Buffer.from(`sealed:${Buffer.from(plain).toString("hex")}`.split("").reverse().join("")),
    decryptString: (cipher: Buffer) => {
      const text = cipher.toString().split("").reverse().join("")
      if (secure.reset || !text.startsWith("sealed:")) throw new Error("Error while decrypting the ciphertext")
      return Buffer.from(text.slice("sealed:".length), "hex").toString()
    },
  }
  return secure
}

export function setup(
  fake: Fake,
  options?: { open?: (url: string) => Promise<void>; secure?: ReturnType<typeof fakeSecure> },
) {
  const store = memoryStore()
  const secure = options?.secure ?? fakeSecure()
  const events = { changed: 0 }
  const accounts = DynWorkAccounts.make({
    store,
    secure,
    open: options?.open ?? (async () => {}),
    deviceName: "DynWork test",
    changed: () => events.changed++,
  })
  return { accounts, store, secure, events }
}

export const mints = (fake: Fake) =>
  fake.state.requests.filter((request) => request.path === "/v1/auth/bridge/pat").length

// Polls a condition while real I/O runs, bounded by a real-time deadline. Bun's fake timers move Date.now,
// performance.now, process.hrtime and Bun.nanoseconds along with the timers, but not `os.uptime`; setImmediate is not
// faked either. So this also works while a test moves a fake clock.
export async function until(condition: () => boolean | Promise<boolean>, seconds = 5) {
  const deadline = uptime() + seconds
  while (!(await condition())) {
    if (uptime() > deadline) throw new Error("condition did not hold in time")
    await new Promise((resolve) => setImmediate(resolve))
  }
}

export { startFake }
