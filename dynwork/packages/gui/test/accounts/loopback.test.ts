import { afterEach, describe, expect, jest, test } from "bun:test"
import { request } from "node:http"
import { networkInterfaces } from "node:os"
import { Loopback } from "../../src/accounts/loopback"

afterEach(() => {
  jest.useRealTimers()
})

const parse = (url: URL) => (url.searchParams.get("state") === "expected" ? url.searchParams.get("code") : undefined)

// A raw request, so the test controls the Host header the way a rebound DNS name would.
function get(url: string, headers?: Record<string, string>) {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const sent = request(url, { headers }, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString(),
          headers: response.headers,
        }),
      )
    })
    sent.on("error", reject)
    sent.end()
  })
}

const external = Object.values(networkInterfaces())
  .flat()
  .find((address) => address?.family === "IPv4" && !address.internal)?.address

describe("device-link loopback listener", () => {
  test("binds 127.0.0.1 on a random port with the /cb path", async () => {
    const first = await Loopback.listen({ parse, timeout: 60_000 })
    const second = await Loopback.listen({ parse, timeout: 60_000 })
    expect(first.redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/cb$/)
    expect(second.redirect).not.toBe(first.redirect)
    first.cancel()
    second.cancel()
    expect(await first.outcome).toEqual({ _tag: "Cancelled" })
  })

  test("ignores a wrong state and keeps waiting for the right one", async () => {
    const listener = await Loopback.listen({ parse, timeout: 60_000 })
    const wrong = await get(`${listener.redirect}?state=other&code=abc`)
    expect(wrong.status).toBe(400)
    expect(wrong.body).not.toContain("abc")
    const missing = await get(listener.redirect)
    expect(missing.status).toBe(400)
    const right = await get(`${listener.redirect}?state=expected&code=abc`)
    expect(right.status).toBe(200)
    expect(right.body).toContain("You can close this tab")
    expect(right.body).not.toContain("abc")
    expect(right.headers["cache-control"]).toBe("no-store")
    expect(right.headers["referrer-policy"]).toBe("no-referrer")
    expect(await listener.outcome).toEqual({ _tag: "Answer", answer: "abc" })
  })

  test("takes one answer: a second hit is refused", async () => {
    const listener = await Loopback.listen({ parse, timeout: 60_000 })
    await get(`${listener.redirect}?state=expected&code=one`)
    expect(await listener.outcome).toEqual({ _tag: "Answer", answer: "one" })
    const second = await get(`${listener.redirect}?state=expected&code=two`).catch(
      (error: NodeJS.ErrnoException) => error.code,
    )
    expect(second === "ECONNREFUSED" || (typeof second === "object" && second.status === 410)).toBe(true)
  })

  test("refuses a request for another host name", async () => {
    const listener = await Loopback.listen({ parse, timeout: 60_000 })
    const port = new URL(listener.redirect).port
    const rebound = await get(`${listener.redirect}?state=expected&code=abc`, { host: `evil.example:${port}` })
    expect(rebound.status).toBe(403)
    const named = await get(`${listener.redirect}?state=expected&code=abc`, { host: `localhost:${port}` })
    expect(named.status).toBe(403)
    const other = await get(`http://127.0.0.1:${port}/other?state=expected&code=abc`)
    expect(other.status).toBe(404)
    listener.cancel()
    expect(await listener.outcome).toEqual({ _tag: "Cancelled" })
  })

  test.skipIf(external === undefined)("is not reachable from another interface", async () => {
    const listener = await Loopback.listen({ parse, timeout: 60_000 })
    const port = new URL(listener.redirect).port
    const answer = await get(`http://${external}:${port}/cb?state=expected&code=abc`).catch(
      (error: NodeJS.ErrnoException) => error.code,
    )
    expect(answer).toBe("ECONNREFUSED")
    listener.cancel()
  })

  test("gives up after its timeout and closes", async () => {
    jest.useFakeTimers()
    const listener = await Loopback.listen({ parse, timeout: 600_000 })
    jest.advanceTimersByTime(599_999)
    const pending = await Promise.race([listener.outcome, Promise.resolve("pending")])
    expect(pending).toBe("pending")
    jest.advanceTimersByTime(1)
    expect(await listener.outcome).toEqual({ _tag: "Expired" })
    const after = await get(`${listener.redirect}?state=expected&code=abc`).catch(
      (error: NodeJS.ErrnoException) => error.code,
    )
    expect(after === "ECONNREFUSED" || (typeof after === "object" && after.status === 410)).toBe(true)
  })
})
