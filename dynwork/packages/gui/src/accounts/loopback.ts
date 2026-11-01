export * as Loopback from "./loopback"

import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

export type Outcome<T> = { _tag: "Answer"; answer: T } | { _tag: "Cancelled" } | { _tag: "Expired" }

// The device link's way back (PROTOCOL.md section 8): one listener on 127.0.0.1, on a port the OS picks, for one
// browser answer. `parse` reads a callback URL and returns undefined for anything that is not the expected answer (a
// wrong or missing state, a malformed code), which leaves the listener waiting. The first answer closes it.
export function listen<T>(options: { parse: (url: URL) => T | undefined; timeout: number }) {
  const server = createServer()
  const outcome = Promise.withResolvers<Outcome<T>>()
  const settled = { done: false }

  const settle = (value: Outcome<T>) => {
    if (settled.done) return
    settled.done = true
    clearTimeout(timer)
    server.close()
    server.closeIdleConnections()
    outcome.resolve(value)
  }

  const timer = setTimeout(() => settle({ _tag: "Expired" }), options.timeout)

  server.on("request", (request, response) => {
    const port = (server.address() as AddressInfo | null)?.port
    const reply = (status: number, title: string) => {
      response.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        connection: "close",
      })
      response.end(page(title))
    }

    // Bound to 127.0.0.1, so only this machine connects. The Host check also turns away a page that reached the port
    // through a DNS name rebound to 127.0.0.1.
    if (settled.done) return reply(410, "This sign-in has already finished.")
    if (!loopback(request.socket.remoteAddress) || request.headers.host !== `127.0.0.1:${port}`)
      return reply(403, "This sign-in link is not for this DynWork window.")
    if (request.method !== "GET" || request.url === undefined) return reply(404, "Not found.")
    const url = new URL(request.url, `http://127.0.0.1:${port}`)
    if (url.pathname !== "/cb") return reply(404, "Not found.")
    const answer = options.parse(url)
    if (answer === undefined) return reply(400, "This sign-in link is not for this DynWork window.")
    reply(200, "You can close this tab and return to DynWork.")
    settle({ _tag: "Answer", answer })
  })

  return new Promise<{ redirect: string; outcome: Promise<Outcome<T>>; cancel: () => void }>((resolve, reject) => {
    server.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    server.listen(0, "127.0.0.1", () =>
      resolve({
        redirect: `http://127.0.0.1:${(server.address() as AddressInfo).port}/cb`,
        outcome: outcome.promise,
        cancel: () => settle({ _tag: "Cancelled" }),
      }),
    )
  })
}

function loopback(address: string | undefined) {
  return address === "127.0.0.1" || address === "::ffff:127.0.0.1"
}

function page(title: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>DynWork</title></head><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0"><p>${title}</p></body></html>`
}
