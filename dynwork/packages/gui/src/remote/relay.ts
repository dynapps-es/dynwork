export * as RemoteRelay from "./relay"

import { Socket } from "@dynwork/remote"

// The relay's desktop routes (`/api/dynwork/relay/v1`, phase 05): pairings, the user's devices, and revoking a phone.
// Every call carries the account's JWT in the Authorization header; nothing goes in a URL.

export class RelayError extends Error {
  constructor(
    readonly status: number,
    readonly key: string | undefined,
  ) {
    super(`The relay answered ${status}${key ? ` (${key})` : ""}`)
  }
}

export type Device = {
  id: string
  kind: "desktop" | "phone"
  peer_id: string
  name?: string | null
  online: boolean
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export function make(input: { base: string; jwt: () => Promise<string>; fetch?: Fetch }) {
  const send = input.fetch ?? fetch
  const call = async (method: string, route: string) => {
    const answer = await send(`${input.base.replace(/\/+$/, "")}${Socket.basePath}${route}`, {
      method,
      headers: { authorization: `Bearer ${await input.jwt()}` },
    })
    if (answer.ok) return answer
    const body = (await answer.json().catch(() => ({}))) as { error?: string }
    throw new RelayError(answer.status, body.error)
  }
  return {
    /** A one-time `dwp1_` pairing token and its expiry, epoch milliseconds. */
    pairing: async () => {
      const body = (await (await call("POST", "/pairings")).json()) as { token: string; expires_at: string }
      return { token: body.token, expires: Date.parse(body.expires_at) }
    },
    devices: async () => (await (await call("GET", "/devices")).json()) as Device[],
    /** Revokes a phone. A device the relay no longer has counts as revoked. */
    revoke: async (id: string) => {
      await call("DELETE", `/devices/${encodeURIComponent(id)}`).catch((error) => {
        if (!(error instanceof RelayError && error.status === 404)) throw error
      })
    },
  }
}

export type Relay = ReturnType<typeof make>
