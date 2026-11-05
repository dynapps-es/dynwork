import type { ServerWebSocket } from "bun"
import { Effect, Schema } from "effect"
import { Keys, Presence, Remote, Socket } from "@dynwork/remote"
import { RemoteStore } from "../../src/remote/store"
import { RemoteTunnel } from "../../src/remote/tunnel"
import { fakeSecure } from "../accounts/fixture"

// What the remote plugin tests run against: a fake relay per instance (the routes of phase 05, routing by peer id and
// writing presence), a fake OpenCode service (pairing codes, session tokens, and a few API routes), and the tunnel
// with an in-memory store, as main builds it.

type Socket = ServerWebSocket<{ kind: "desktop" | "phone"; peer: string; device?: string }>

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex")

export function fakeRelay(name: string) {
  const state = {
    jwts: new Set<string>(),
    desktops: [] as Socket[],
    phones: new Map<string, Socket>(),
    pairings: new Map<string, { claimed: boolean }>(),
    devices: [] as { id: string; peer_id: string; name: string; credential: string; revoked: boolean }[],
    opened: [] as { authorization: string; peer: string }[],
    deleted: [] as string[],
    // Desktop sockets to refuse next, as a relay that rejects the JWT
    refuse: 0,
  }
  const presence = (phone: string, event: "connected" | "disconnected") =>
    state.desktops.forEach((desktop) =>
      desktop.send(
        Presence.encode({ to: Buffer.from(desktop.data.peer, "hex"), phone: Buffer.from(phone, "hex"), event }),
      ),
    )
  const bearer = (request: Request) => request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""
  const server = Bun.serve<{ kind: "desktop" | "phone"; peer: string; device?: string }>({
    port: 0,
    fetch: async (request, server) => {
      const url = new URL(request.url)
      const route = url.pathname.slice(Socket.basePath.length)
      if (route === "/desktop") {
        if (!state.jwts.has(bearer(request)) || state.refuse-- > 0) return new Response("unauthorized", { status: 401 })
        const peer = request.headers.get("x-dynwork-peer") ?? ""
        state.opened.push({ authorization: request.headers.get("authorization") ?? "", peer })
        return server.upgrade(request, { data: { kind: "desktop", peer } })
          ? undefined
          : new Response("no", { status: 400 })
      }
      if (route === "/device") {
        const device = state.devices.find((entry) => entry.credential === bearer(request) && !entry.revoked)
        if (!device) return new Response("unauthorized", { status: 401 })
        return server.upgrade(request, { data: { kind: "phone", peer: device.peer_id, device: device.id } })
          ? undefined
          : new Response("no", { status: 400 })
      }
      if (route === "/pairings/claim" && request.method === "POST") {
        const body = (await request.json()) as { token: string; peer_id: string; name: string }
        const pairing = state.pairings.get(body.token)
        if (!pairing || pairing.claimed) return Response.json({ error: "pairing_unknown" }, { status: 410 })
        pairing.claimed = true
        const device = {
          id: crypto.randomUUID(),
          peer_id: body.peer_id,
          name: body.name,
          credential: `dwr1_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`,
          revoked: false,
        }
        state.devices.push(device)
        return Response.json(
          { device_id: device.id, peer_id: device.peer_id, credential: device.credential },
          { status: 201 },
        )
      }
      if (!state.jwts.has(bearer(request))) return Response.json({ error: "unauthorized" }, { status: 401 })
      if (route === "/pairings" && request.method === "POST") {
        const token = `dwp1_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`
        state.pairings.set(token, { claimed: false })
        return Response.json(
          { pairing_id: crypto.randomUUID(), token, expires_at: new Date(Date.now() + 300_000).toISOString() },
          { status: 201 },
        )
      }
      if (route === "/devices" && request.method === "GET")
        return Response.json(
          state.devices
            .filter((device) => !device.revoked)
            .map((device) => ({
              id: device.id,
              kind: "phone",
              peer_id: device.peer_id,
              name: device.name,
              online: state.phones.has(device.peer_id),
            })),
        )
      if (route.startsWith("/devices/") && request.method === "DELETE") {
        const device = state.devices.find((entry) => entry.id === route.slice("/devices/".length) && !entry.revoked)
        if (!device) return Response.json({ error: "not_found" }, { status: 404 })
        device.revoked = true
        state.deleted.push(device.id)
        state.phones.get(device.peer_id)?.close(4003, "revoked")
        return new Response(null, { status: 204 })
      }
      return new Response("not found", { status: 404 })
    },
    websocket: {
      open: (socket) => {
        if (socket.data.kind === "desktop") {
          state.desktops.push(socket)
          state.phones.forEach((_, phone) =>
            socket.send(
              Presence.encode({
                to: Buffer.from(socket.data.peer, "hex"),
                phone: Buffer.from(phone, "hex"),
                event: "connected",
              }),
            ),
          )
          return
        }
        state.phones.set(socket.data.peer, socket)
        presence(socket.data.peer, "connected")
      },
      // Routes by `to`, stamping `from` with the authenticated peer, phone to desktop and desktop to phone only
      message: (socket, message) => {
        if (typeof message === "string") return
        const envelope = new Uint8Array(message)
        if (envelope[0] !== 1) return
        envelope.set(Buffer.from(socket.data.peer, "hex"), 17)
        const to = hex(envelope.subarray(1, 17))
        if (socket.data.kind === "phone")
          state.desktops.filter((desktop) => desktop.data.peer === to).forEach((desktop) => desktop.send(envelope))
        if (socket.data.kind === "desktop") state.phones.get(to)?.send(envelope)
      },
      close: (socket) => {
        if (socket.data.kind === "desktop") {
          state.desktops = state.desktops.filter((desktop) => desktop !== socket)
          return
        }
        if (state.phones.get(socket.data.peer) !== socket) return
        state.phones.delete(socket.data.peer)
        presence(socket.data.peer, "disconnected")
      },
    },
  })
  return {
    name,
    url: `http://127.0.0.1:${server.port}`,
    state,
    // Closes every desktop socket with a code, as the relay does on its lifetime close (4000)
    closeDesktops: (code: number) => state.desktops.forEach((desktop) => desktop.close(code, "reconnect")),
    stop: () => server.stop(true),
  }
}

export type FakeRelay = ReturnType<typeof fakeRelay>

// DynWork's OpenCode service, as far as the proxy sees it.
export function fakeService(password = "service-password-0123456789") {
  const state = {
    password,
    tokens: new Set<string>(),
    codes: new Set<string>(),
    requests: [] as { method: string; path: string; authorization: string; cookie: string | null }[],
  }
  const basic = (secret: string) => `Basic ${Buffer.from(`opencode:${secret}`).toString("base64")}`
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const authorization = request.headers.get("authorization") ?? ""
      state.requests.push({
        method: request.method,
        path: url.pathname + url.search,
        authorization,
        cookie: request.headers.get("cookie"),
      })
      if (url.pathname === "/api/pair" && request.method === "POST") {
        if (authorization !== basic(password)) return new Response("unauthorized", { status: 401 })
        const code = crypto.randomUUID()
        state.codes.add(code)
        return Response.json({ code, expires_in: 300 })
      }
      if (url.pathname.startsWith("/auth/connect/")) {
        const code = url.pathname.slice("/auth/connect/".length)
        if (!state.codes.delete(code)) return new Response("unauthorized", { status: 401 })
        const token = `${Math.floor(Date.now() / 1000) + 3600}.session-${crypto.randomUUID()}`
        state.tokens.add(token)
        return Response.json({ token })
      }
      if (![...state.tokens].some((token) => authorization === basic(token)) && authorization !== basic(password))
        return new Response("unauthorized", { status: 401 })
      if (url.pathname === "/api/session") return Response.json([{ id: "ses_1", title: "Remote" }])
      if (url.pathname === "/api/session/ses_1/prompt" && request.method === "POST")
        return Response.json({ received: await request.text() })
      if (url.pathname === "/api/event") {
        const encoder = new TextEncoder()
        const stream = new ReadableStream({
          start: (controller) => {
            controller.enqueue(encoder.encode("data: first\n\n"))
            const timer = setInterval(() => controller.enqueue(encoder.encode("data: tick\n\n")), 20)
            request.signal.addEventListener("abort", () => clearInterval(timer))
          },
        })
        return new Response(stream, { headers: { "content-type": "text/event-stream", "set-cookie": "leak=1" } })
      }
      return new Response("not found", { status: 404 })
    },
  })
  return {
    state,
    endpoint: {
      id: "sidecar",
      url: `http://127.0.0.1:${server.port}`,
      headers: { authorization: basic(password) },
      sameMachine: true,
    },
    stop: () => server.stop(true),
  }
}

export type FakeService = ReturnType<typeof fakeService>

// What main's `ctx.storage.store` does: canonical JSON of the schema, decoded again on read.
export function memoryStore(
  disk = { json: Schema.encodeSync(Schema.fromJsonString(RemoteStore.Store))(RemoteStore.initial) },
) {
  const encode = Schema.encodeSync(Schema.fromJsonString(RemoteStore.Store))
  const decode = Schema.decodeUnknownSync(Schema.fromJsonString(RemoteStore.Store))
  return {
    disk,
    get value() {
      return decode(disk.json)
    },
    set(value: RemoteStore.Store) {
      disk.json = encode(value)
    },
  }
}

export type TestAccount = RemoteTunnel.Account

// Accounts as the tunnel sees them: a list and a JWT per account, minted by the account's fake relay.
export function accounts(relays: Record<string, FakeRelay>) {
  const list: TestAccount[] = Object.values(relays).map((relay, index) => ({
    id: relay.name,
    label: relay.name,
    url: relay.url,
    status: "signedIn",
    active: index === 0,
  }))
  const minted: string[] = []
  return {
    list,
    minted,
    accounts: {
      list: () => list,
      session: async (id: string) => {
        const relay = relays[id]
        const account = list.find((entry) => entry.id === id)
        if (!relay || account?.status !== "signedIn") throw new Error("not signed in")
        const token = `eyJ.${id}.${crypto.randomUUID()}`
        relay.state.jwts.add(token)
        minted.push(token)
        return { token, expiresAt: Date.now() + 3_600_000 }
      },
    },
    activate: (id: string) => list.forEach((entry, index) => (list[index] = { ...entry, active: entry.id === id })),
    signOut: (id: string) =>
      list.forEach(
        (entry, index) => (list[index] = entry.id === id ? { ...entry, status: "signedOut", active: false } : entry),
      ),
  }
}

export function tunnel(input: {
  relays: Record<string, FakeRelay>
  service: FakeService
  store?: ReturnType<typeof memoryStore>
  secure?: ReturnType<typeof fakeSecure>
  now?: () => number
}) {
  const store = input.store ?? memoryStore()
  const logs: string[] = []
  const pushed: string[] = []
  const users = accounts(input.relays)
  const remote = RemoteTunnel.make({
    store,
    accounts: users.accounts,
    secure: input.secure ?? fakeSecure(),
    endpoint: () => input.service.endpoint,
    socket: (url, headers) => new WebSocket(url, { headers }),
    log: (level, message, data) => logs.push(`${level} ${message} ${JSON.stringify(data ?? {})}`),
    changed: () => pushed.push(JSON.stringify(remote.state())),
    now: input.now,
    retry: { min: 20, max: 100 },
  })
  return { remote, store, logs, pushed, users }
}

// A phone pairing from the QR the tunnel shows: claim on the relay, open the device socket, run the handshake.
export async function pairPhone(relay: FakeRelay, qr: string, name = "Pixel") {
  const pairing = await Effect.runPromise(Keys.parsePairing(qr, Date.now()))
  const phoneKey = Keys.generate()
  const answer = await fetch(`${relay.url}${Socket.basePath}/pairings/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: pairing.relay, peer_id: hex(Keys.peerId(phoneKey.publicKey)), name }),
  })
  const claimed = (await answer.json()) as { credential: string; device_id: string }
  const connect = () =>
    Effect.runPromise(
      Socket.link(
        new WebSocket(Socket.url(relay.url, "device"), { headers: { authorization: `Bearer ${claimed.credential}` } }),
      ),
    )
  const link = await connect()
  const peer = await Effect.runPromise(Remote.pairPhone({ link, staticKey: phoneKey, pairing }))
  return {
    pairing,
    phoneKey,
    peerId: hex(Keys.peerId(phoneKey.publicKey)),
    credential: claimed.credential,
    link,
    peer,
    connect,
  }
}

export async function until(check: () => boolean | Promise<boolean>, ms = 5_000) {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`condition not reached within ${ms} ms`)
    await Bun.sleep(10)
  }
}
