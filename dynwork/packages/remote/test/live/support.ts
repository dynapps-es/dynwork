import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { $ } from "bun"
import { Effect, Stream } from "effect"
import path from "node:path"
import { fromUtf8, utf8 } from "../../src/bytes"
import { Keys, Mux, Remote, Socket } from "../../src"

// The live interop suite's harness: the mobile sp-local project (`sp-local.ts up --image local`, the relay image) as
// the relay, raw HTTP for the relay's pairing and device routes, and real WebSockets for both ends. It runs only when
// SP_LOCAL_ENV points at that project's env file, relative to the package directory. Nothing here prints a secret.

export const envPath = process.env.SP_LOCAL_ENV === undefined ? undefined : path.resolve(process.env.SP_LOCAL_ENV)

export const project = process.env.SP_LOCAL_PROJECT ?? "dynwork-sp-mobile"

async function readEnv(): Promise<Record<string, string>> {
  if (envPath === undefined) return {}
  const text = await Bun.file(envPath).text()
  return Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
  )
}

export const env = await readEnv()

export const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

export const hex = (bytes: Uint8Array) => bytesToHex(bytes)

// The same desktop key on every run, so each instance keeps one desktop row (desktops are not revocable, R5-9, and
// count toward the device limit).
export const fixedKey = (name: string) => Keys.fromSecretKey(sha256(utf8(`dynwork-remote-live:${name}`)))

export type Instance = { name: "alpha" | "beta"; base: string; pat: string }

export function instance(name: "alpha" | "beta"): Instance {
  const label = name.toUpperCase()
  return { name, base: `http://127.0.0.1:${env[`SP_${label}_PORT`] ?? ""}`, pat: env[`SP_${label}_PAT`] ?? "" }
}

// Everything secret a run handled, for the log scans.
export const secrets: string[] = []

const keep = (secret: string) => {
  secrets.push(secret)
  return secret
}

export async function jwt(target: Instance) {
  const answer = await fetch(`${target.base}/v1/auth/bridge/pat`, {
    method: "POST",
    headers: { authorization: `Bearer ${target.pat}` },
  })
  if (answer.status !== 200) throw new Error(`minting a JWT on ${target.name} answered ${answer.status}`)
  return keep(((await answer.json()) as { token: string }).token)
}

const relay = (target: Instance, route: string) => `${target.base}${Socket.basePath}${route}`

export async function createPairing(target: Instance, token: string) {
  const answer = await fetch(relay(target, "/pairings"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  })
  if (answer.status !== 201) throw new Error(`POST /pairings on ${target.name} answered ${answer.status}`)
  const body = (await answer.json()) as { token: string; expires_at: string }
  keep(body.token)
  return { token: body.token, expires: Date.parse(body.expires_at) }
}

export async function claim(target: Instance, body: { token: string; peer_id: string; name: string }) {
  const answer = await fetch(relay(target, "/pairings/claim"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const json = (await answer.json()) as { device_id?: string; credential?: string; error?: string }
  if (json.credential) keep(json.credential)
  return { status: answer.status, ...json }
}

export type Device = { id: string; kind: string; peer_id: string; name: string; online: boolean }

export async function devices(target: Instance, token: string) {
  const answer = await fetch(relay(target, "/devices"), { headers: { authorization: `Bearer ${token}` } })
  return (await answer.json()) as Device[]
}

export async function revoke(target: Instance, token: string, id: string) {
  const answer = await fetch(relay(target, `/devices/${id}`), {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  })
  return answer.status
}

// Revokes every phone the user has on the instance: what earlier runs left behind would count toward the limit.
export async function revokePhones(target: Instance, token: string) {
  for (const device of await devices(target, token)) if (device.kind === "phone") await revoke(target, token, device.id)
}

export function desktopSocket(target: Instance, token: string, key: Keys.KeyPair) {
  return Socket.link(
    new WebSocket(Socket.url(target.base, "desktop"), {
      headers: { authorization: `Bearer ${token}`, "x-dynwork-peer": hex(Keys.peerId(key.publicKey)) },
    }),
  )
}

export function phoneSocket(target: Instance, credential: string) {
  return Socket.link(
    new WebSocket(Socket.url(target.base, "device"), { headers: { authorization: `Bearer ${credential}` } }),
  )
}

// What the desktop answers in these tests: the shapes the OpenCode API has (a request, an SSE stream, a socket).
export function handler(seen: string[]): Mux.Handler {
  return (incoming) => {
    if (incoming.type === "ws")
      return Effect.gen(function* () {
        const socket = yield* incoming.accept(incoming.protocols[0])
        yield* socket.messages.pipe(Stream.runForEach((message) => socket.send(message)))
        yield* socket.close
      })
    const [route, query] = incoming.path.split("?")
    if (route === "/hello") return incoming.respond({ status: 200 }, utf8(`hello ${incoming.method}`))
    if (route === "/echo")
      return Effect.gen(function* () {
        const chunks = yield* Stream.runCollect(incoming.body)
        const text = chunks.map((chunk) => fromUtf8(chunk)).join("")
        seen.push(text, incoming.headers["x-canary"] ?? "")
        yield* incoming.respond({ status: 200, headers: { "x-echo": incoming.headers["x-canary"] ?? "" } }, utf8(text))
      })
    if (route === "/events")
      return incoming.respond(
        { status: 200, headers: { "content-type": "text/event-stream" } },
        Stream.range(1, Number(query?.split("=")[1] ?? 10), 1).pipe(
          Stream.map((index) => utf8(`data: ${String(index).padStart(6, "0")}\n\n`)),
        ),
      )
    return incoming.respond({ status: 404 })
  }
}

// A desktop on the relay: one registry, listening on its current socket.
export async function startDesktop(target: Instance, token: string, key: Keys.KeyPair) {
  const shown: { pairing?: Keys.Pairing } = {}
  const paired = new Set<string>()
  const presence: { phone: string; online: boolean }[] = []
  const peers: Remote.Peer[] = []
  const seen: string[] = []
  const desktop = new Remote.Desktop({
    staticKey: key,
    pairing: () => shown.pairing,
    device: (phoneKey) => paired.has(hex(phoneKey)),
    events: {
      paired: (phoneKey) => {
        paired.add(hex(phoneKey))
        shown.pairing = undefined
      },
      connected: (peer) => {
        peer.mux.serve(handler(seen))
        if (!peers.includes(peer)) peers.push(peer)
      },
      presence: (phone, online) => presence.push({ phone: hex(phone), online }),
    },
  })
  const link = { current: await run(desktopSocket(target, token, key)) }
  const listen = () => Effect.runFork(desktop.listen(link.current))
  listen()
  return {
    desktop,
    shown,
    paired,
    presence,
    peers,
    seen,
    link,
    // A new socket after the old one dropped, as after a relay restart
    reconnect: async () => {
      link.current = await run(desktopSocket(target, token, key))
      listen()
    },
    stop: () => link.current.close(),
  }
}

// Mints a relay pairing, shows the QR, and pairs a new phone through it the way the app will: parse the QR, claim
// with the relay token, open the device socket, run the handshake.
export async function pairNewPhone(
  target: Instance,
  token: string,
  desktop: Awaited<ReturnType<typeof startDesktop>>,
  key: Keys.KeyPair,
  name: string,
) {
  const minted = await createPairing(target, token)
  const now = Date.now()
  const pairing = Keys.createPairing({
    instance: target.base,
    desktopKey: key.publicKey,
    now,
    ttlMs: minted.expires - now,
    relay: minted.token,
  })
  desktop.shown.pairing = pairing
  const scanned = await run(Keys.parsePairing(Keys.encodePairing(pairing), Date.now()))
  const phoneKey = Keys.generate()
  const peerId = hex(Keys.peerId(phoneKey.publicKey))
  const claimed = await claim(target, { token: scanned.relay ?? "", peer_id: peerId, name })
  if (claimed.status !== 201 || !claimed.credential || !claimed.device_id)
    throw new Error(`the claim answered ${claimed.status} ${claimed.error ?? ""}`)
  const link = { current: await run(phoneSocket(target, claimed.credential)) }
  const peer = await run(Remote.pairPhone({ link: link.current, staticKey: phoneKey, pairing: scanned }))
  return {
    pairing: scanned,
    relayToken: minted.token,
    phoneKey,
    peerId,
    credential: claimed.credential,
    deviceId: claimed.device_id,
    link,
    peer,
    reconnect: async () => {
      link.current = await run(phoneSocket(target, claimed.credential ?? ""))
      return run(Remote.reconnectPhone({ link: link.current, staticKey: phoneKey, desktopKey: key.publicKey, peer }))
    },
  }
}

export const text = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(
    Stream.runCollect,
    Effect.map((chunks) => chunks.map((chunk) => fromUtf8(chunk)).join("")),
  )

export async function until(check: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`condition not reached within ${ms} ms`)
    await Bun.sleep(20)
  }
}

// The relay's whole database and the instance's container logs, as text, for the plaintext scan.
export async function relayTraces(name: "alpha" | "beta") {
  const dump = await $`docker exec ${project}-postgres-1 pg_dump -U sp ${name}`.quiet().text()
  const logs = await $`docker logs ${project}-${name}-1`.quiet().nothrow()
  return `${dump}\n${logs.stdout.toString()}\n${logs.stderr.toString()}`
}
