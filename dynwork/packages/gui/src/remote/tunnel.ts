export * as RemoteTunnel from "./tunnel"

import { Effect } from "effect"
import { Closed, Keys, Remote, Socket } from "@dynwork/remote"
import type { ServerEndpoint } from "@opencode/plugin/gui/main"
import type { Failure, Pairing, Phone, State, Status } from "./contract"
import { RemoteProxy } from "./proxy"
import { RemoteRelay } from "./relay"
import { RemoteStore } from "./store"

// The tunnel in main: while the toggle is on and an account is active and signed in, one WebSocket to that instance's
// relay (`/api/dynwork/relay/v1/desktop`, with the account's JWT, which the accounts code renews), and one
// `Remote.Desktop` answering every paired phone through the proxy. Switching the active instance moves the tunnel;
// signing out or turning the toggle off stops it and ends the phones' sessions. Windows only see `State`.

export type Account = {
  readonly id: string
  readonly label: string
  readonly url: string
  readonly status: "signedIn" | "signedOut"
  readonly active: boolean
}

export type Accounts = {
  list: () => readonly Account[]
  session: (id: string, fresh?: boolean) => Promise<{ token: string; expiresAt: number }>
}

export type SecureStorage = {
  isEncryptionAvailable: () => boolean
  encryptString: (plain: string) => Buffer
  decryptString: (cipher: Buffer) => string
}

export type Log = (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void

export type Options = {
  store: RemoteStore.Persisted
  accounts: Accounts
  secure: SecureStorage
  endpoint: () => ServerEndpoint | undefined
  // The runtime's WebSocket with request headers (Node's and Bun's take `{ headers }`)
  socket: (url: string, headers: Record<string, string>) => WebSocket
  fetch?: RemoteRelay.Fetch
  log: Log
  changed: () => void
  now?: () => number
  // Reconnect backoff, milliseconds
  retry?: { min: number; max: number }
}

/** Reconnect at once after these closes: the relay's lifetime close and its shutdown. */
const reconnectNow = [4000, 1012]

type Tunnel = {
  account: Account
  key: Keys.KeyPair
  desktop: Remote.Desktop
  relay: RemoteRelay.Relay
  link?: Socket.SocketLink
  stopped: boolean
  // Phones the relay reports attached, by peer id (hex)
  online: Set<string>
  // The pairing shown, with its secrets; cleared when used or expired
  shown?: Keys.Pairing
  expiry?: ReturnType<typeof setTimeout>
  wake?: () => void
}

export function make(options: Options) {
  const now = options.now ?? Date.now
  const retry = options.retry ?? { min: 1000, max: 30_000 }
  const store = options.store
  const log = options.log
  const proxy = RemoteProxy.make({ endpoint: options.endpoint, fetch: options.fetch, log })
  const live: { tunnel?: Tunnel; status: Status; failure?: Failure; disposed: boolean } = {
    status: "off",
    disposed: false,
  }

  const set = (status: Status, failure?: Failure) => {
    live.status = status
    live.failure = failure
    options.changed()
  }

  const target = () => {
    if (!store.value.enabled || live.disposed) return undefined
    return options.accounts.list().find((account) => account.active && account.status === "signedIn")
  }

  // Follows the toggle and the accounts: called on every change of either.
  const update = () => {
    const next = target()
    const current = live.tunnel
    if (current && next && current.account.id === next.id && current.account.url === next.url) return
    if (current) stop(current)
    if (!next) return set(store.value.enabled ? "idle" : "off")
    const key = staticKey()
    if (!key) return set("error", "insecure")
    start(next, key)
  }

  const staticKey = () => {
    if (!options.secure.isEncryptionAvailable()) return undefined
    const sealed = store.value.keyCipher
    const opened = sealed === undefined ? undefined : open(sealed)
    if (opened) return Keys.fromSecretKey(Buffer.from(opened, "base64"))
    const key = Keys.generate()
    store.set({
      ...store.value,
      keyCipher: options.secure.encryptString(Buffer.from(key.secretKey).toString("base64")).toString("base64"),
    })
    return key
  }

  const open = (sealed: string) => {
    try {
      return options.secure.decryptString(Buffer.from(sealed, "base64"))
    } catch {
      return undefined
    }
  }

  const phonesOf = (account: string) => store.value.phones.filter((phone) => phone.account === account)

  const start = (account: Account, key: Keys.KeyPair) => {
    const relay = RemoteRelay.make({
      base: account.url,
      jwt: async () => (await options.accounts.session(account.id)).token,
      fetch: options.fetch,
    })
    const tunnel: Tunnel = {
      account,
      key,
      relay,
      stopped: false,
      online: new Set(),
      desktop: new Remote.Desktop({
        staticKey: key,
        pairing: () => (tunnel.shown && tunnel.shown.expires > now() ? tunnel.shown : undefined),
        device: (phoneKey) => phonesOf(account.id).some((phone) => phone.key === encode(phoneKey)),
        tokens: RemoteStore.tokens(store, now),
        events: {
          paired: (phoneKey) => {
            store.set({
              ...store.value,
              phones: [...store.value.phones, { account: account.id, key: encode(phoneKey), pairedAt: now() }],
            })
            hide(tunnel)
            RemoteStore.audit(store, { at: now(), phone: Keys.fingerprint(phoneKey), event: "paired" })
            void names(tunnel)
            options.changed()
          },
          connected: (peer, resumed) => {
            peer.mux.serve(proxy.handler)
            if (!resumed) record(tunnel, peer.session.remoteStatic, "connected")
          },
          refused: () => log("info", "remote: a phone's channel was refused"),
          presence: (phone, online) => {
            const id = hex(phone)
            if (online) tunnel.online.add(id)
            if (!online) tunnel.online.delete(id)
            const known = phonesOf(account.id).find((stored) => hex(Keys.peerId(decode(stored.key))) === id)
            if (known && !online) record(tunnel, decode(known.key), "disconnected")
            options.changed()
          },
        },
      }),
    }
    live.tunnel = tunnel
    set("connecting")
    void connect(tunnel)
  }

  // Holds the relay socket open until the tunnel stops: reconnects with backoff, with a fresh JWT after a refusal.
  const connect = async (tunnel: Tunnel) => {
    const attempt = { failures: 0, fresh: false }
    while (!tunnel.stopped) {
      const outcome = await once(tunnel, attempt.fresh).then(
        (ending) => ({ ending, failure: undefined }),
        // A socket that never opened is a relay that did not answer or refused the JWT; anything else failed before
        // it, minting the JWT
        (error: Error) => {
          log("warn", "remote: the relay socket did not open", { error: error.message })
          return { ending: undefined, failure: error instanceof Closed ? ("offline" as const) : ("refused" as const) }
        },
      )
      if (tunnel.stopped) return
      if (outcome.ending && reconnectNow.includes(outcome.ending.code)) {
        attempt.failures = 0
        continue
      }
      attempt.failures = outcome.ending ? 1 : attempt.failures + 1
      // A refused socket may be an expired JWT: the next try mints a fresh one
      attempt.fresh = outcome.ending === undefined
      if (outcome.failure && attempt.failures >= 3) set("error", outcome.failure)
      if (!outcome.failure || attempt.failures < 3) set("connecting")
      await sleep(tunnel, Math.min(retry.max, retry.min * 2 ** Math.min(attempt.failures - 1, 5)))
    }
  }

  const once = async (tunnel: Tunnel, fresh: boolean) => {
    const session = await options.accounts.session(tunnel.account.id, fresh)
    const link = await Effect.runPromise(
      Socket.link(
        options.socket(Socket.url(tunnel.account.url, "desktop"), {
          authorization: `Bearer ${session.token}`,
          "x-dynwork-peer": hex(tunnel.desktop.id),
        }),
      ),
    )
    if (tunnel.stopped) {
      link.close(1000)
      return undefined
    }
    tunnel.link = link
    log("info", "remote: tunnel connected", { instance: new URL(tunnel.account.url).host })
    set("connected")
    void names(tunnel)
    Effect.runFork(tunnel.desktop.listen(link))
    const ending = await Effect.runPromise(link.ended)
    tunnel.link = undefined
    tunnel.online.clear()
    log("info", "remote: tunnel closed", { code: ending.code })
    return ending
  }

  const sleep = (tunnel: Tunnel, ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      tunnel.wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })

  const stop = (tunnel: Tunnel) => {
    tunnel.stopped = true
    live.tunnel = undefined
    hide(tunnel)
    tunnel.wake?.()
    const link = tunnel.link
    // The phones hear why first: their sessions close over the socket, which closes after
    Effect.runFork(
      tunnel.desktop.closeAll("stopped").pipe(Effect.ensuring(Effect.sync(() => link?.close(1000, "stopped")))),
    )
    proxy.forget()
  }

  const hide = (tunnel: Tunnel) => {
    tunnel.shown = undefined
    clearTimeout(tunnel.expiry)
  }

  const record = (tunnel: Tunnel, phoneKey: Uint8Array, event: "connected" | "disconnected" | "revoked") => {
    const stored = phonesOf(tunnel.account.id).find((phone) => phone.key === encode(phoneKey))
    RemoteStore.audit(store, { at: now(), phone: stored?.name ?? Keys.fingerprint(phoneKey), event })
    options.changed()
  }

  // The names phones claimed with, from the relay's device list.
  const names = async (tunnel: Tunnel) => {
    const listed = await tunnel.relay.devices().catch(() => [])
    const byPeer = new Map(listed.map((device) => [device.peer_id, device]))
    store.set({
      ...store.value,
      phones: store.value.phones.map((phone) => {
        const device = phone.account === tunnel.account.id ? byPeer.get(hex(Keys.peerId(decode(phone.key)))) : undefined
        return device?.name ? { ...phone, name: device.name } : phone
      }),
    })
    listed
      .filter((device) => device.kind === "phone" && device.online)
      .forEach((device) => tunnel.online.add(device.peer_id))
    options.changed()
  }

  const view = (): State => {
    const tunnel = live.tunnel
    const active = tunnel?.account ?? options.accounts.list().find((account) => account.active)
    const phones: Phone[] = active
      ? phonesOf(active.id).map((phone) => {
          const key = decode(phone.key)
          const id = hex(Keys.peerId(key))
          return {
            id,
            name: phone.name ?? Keys.fingerprint(key),
            fingerprint: Keys.fingerprint(key),
            pairedAt: phone.pairedAt,
            online: tunnel?.online.has(id) ?? false,
          }
        })
      : []
    const shown = tunnel?.shown
    return {
      enabled: store.value.enabled,
      confirmed: store.value.confirmed,
      status: live.status,
      ...(live.failure && live.status === "error" ? { failure: live.failure } : {}),
      ...(active ? { instance: active.label } : {}),
      ...(tunnel ? { fingerprint: Keys.fingerprint(tunnel.key.publicKey) } : {}),
      ...(shown ? { pairing: { qr: Keys.encodePairing(shown), expires: shown.expires } } : {}),
      phones,
      audit: store.value.audit,
    }
  }

  return {
    state: view,
    update,
    setEnabled: (enabled: boolean) => {
      store.set({ ...store.value, enabled, confirmed: store.value.confirmed || enabled })
      update()
      options.changed()
    },
    pair: async (): Promise<Pairing> => {
      const tunnel = live.tunnel
      if (!tunnel) throw new Error("Remote control is off")
      const minted = await tunnel.relay.pairing()
      const at = now()
      if (tunnel.stopped) throw new Error("Remote control is off")
      hide(tunnel)
      tunnel.shown = Keys.createPairing({
        instance: tunnel.account.url,
        desktopKey: tunnel.key.publicKey,
        now: at,
        ttlMs: Math.max(0, minted.expires - at),
        relay: minted.token,
      })
      tunnel.expiry = setTimeout(
        () => {
          hide(tunnel)
          options.changed()
        },
        Math.max(0, minted.expires - at),
      )
      options.changed()
      return { qr: Keys.encodePairing(tunnel.shown), expires: tunnel.shown.expires }
    },
    cancelPairing: () => {
      if (live.tunnel) hide(live.tunnel)
      options.changed()
    },
    revoke: async (id: string) => {
      const owner = live.tunnel?.account ?? options.accounts.list().find((account) => account.active)
      const phone = owner && phonesOf(owner.id).find((stored) => hex(Keys.peerId(decode(stored.key))) === id)
      if (!owner || !phone) return
      const key = decode(phone.key)
      store.set({
        ...store.value,
        phones: store.value.phones.filter((stored) => stored.key !== phone.key || stored.account !== owner.id),
      })
      const tunnel = live.tunnel
      if (tunnel) {
        await Effect.runPromise(tunnel.desktop.revoke(key))
        tunnel.online.delete(id)
        record(tunnel, key, "revoked")
      }
      if (!tunnel) RemoteStore.audit(store, { at: now(), phone: phone.name ?? Keys.fingerprint(key), event: "revoked" })
      const relay =
        tunnel?.relay ??
        RemoteRelay.make({
          base: owner.url,
          jwt: async () => (await options.accounts.session(owner.id)).token,
          fetch: options.fetch,
        })
      const device = (await relay.devices()).find((listed) => listed.peer_id === id && listed.kind === "phone")
      if (device) await relay.revoke(device.id)
      options.changed()
    },
    dispose: () => {
      live.disposed = true
      if (live.tunnel) stop(live.tunnel)
    },
  }
}

export type RemoteTunnel = ReturnType<typeof make>

function hex(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("hex")
}

function encode(key: Uint8Array) {
  return Buffer.from(key).toString("base64url")
}

function decode(key: string) {
  return new Uint8Array(Buffer.from(key, "base64url"))
}
