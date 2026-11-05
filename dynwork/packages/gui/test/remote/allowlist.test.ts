import { describe, expect, test } from "bun:test"
import { RemoteAllowlist } from "../../src/remote/allowlist"

const request = (line: string) => {
  const at = line.indexOf(" ")
  return RemoteAllowlist.match(line.slice(0, at), line.slice(at + 1))
}

describe("the remote allowlist", () => {
  // One test per rule: every example it lists gets through, and only through that rule
  for (const rule of RemoteAllowlist.rules.filter((entry) => entry.examples.length > 0))
    test(`lets through: ${rule.name}`, () => {
      for (const example of rule.examples) expect(request(example)?.name).toBe(rule.name)
      for (const example of rule.examples)
        expect(request(`${example}?directory=%2Fwork&limit=20`)?.name).toBe(rule.name)
      const other = ["GET", "POST", "PUT", "PATCH", "DELETE"].find((method) => !rule.methods.includes(method))
      if (other)
        for (const example of rule.examples)
          expect(request(`${other} ${example.split(" ")[1]}`)?.name).not.toBe(rule.name)
    })

  test("lists no plugin RPC method yet, so every RPC call is refused", () => {
    expect(RemoteAllowlist.rpc).toEqual([])
    expect(request("POST /api/rpc/anything/run")).toBeUndefined()
  })

  test("refuses terminals, shells and filesystem writes", () => {
    for (const line of [
      "GET /api/pty",
      "POST /api/pty",
      "POST /api/pty/pty_1/connect-token",
      "POST /api/experimental/session/ses_1/terminal",
      "GET /api/experimental/session/ses_1/terminal/read",
      "POST /api/experimental/persistent-pty/handoff",
      "POST /api/shell",
      "POST /api/session/ses_1/shell",
      "PUT /api/session/ses_1/environment",
      "POST /api/experimental/fs/write",
      "POST /api/experimental/fs/watch",
    ])
      expect(request(line)).toBeUndefined()
  })

  test("refuses everything else: config, credentials, MCP, plugins, files, the pairing endpoint", () => {
    for (const line of [
      "GET /api/config",
      "PATCH /api/experimental/config",
      "POST /api/credential",
      "PUT /api/experimental/mcp/x",
      "POST /api/plugin/update",
      "GET /api/fs/read/etc/passwd",
      "POST /api/pair",
      "GET /auth/connect/code",
      "GET /api/agent/build",
      "GET /",
      "GET /api",
    ])
      expect(request(line)).toBeUndefined()
  })

  test("refuses paths that could reach another route once decoded or normalized", () => {
    for (const line of [
      "GET /api/session/../pty",
      "GET /api/session/./active",
      "GET /api/session/ses_1/%2E%2E/shell",
      "GET /api/session%2Fses_1",
      "GET /api//session",
      "GET /api/session/",
      "GET /api/session\\..\\pty",
      "GET api/session",
      "GET /api/event?x=1#frag",
      "GET /api/event?x=a b",
    ])
      expect(request(line)).toBeUndefined()
  })

  test("passes no credential, cookie or host header either way", () => {
    for (const header of ["authorization", "cookie", "host", "set-cookie", "proxy-authorization"]) {
      expect(RemoteAllowlist.requestHeaders).not.toContain(header)
      expect(RemoteAllowlist.responseHeaders).not.toContain(header)
    }
  })
})
