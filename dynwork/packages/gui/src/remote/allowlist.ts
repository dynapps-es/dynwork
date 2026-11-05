export * as RemoteAllowlist from "./allowlist"

// What a paired phone may ask DynWork's OpenCode service, as data: one rule per row, with the requests that prove it
// (`test/remote/allowlist.test.ts` runs every example). Anything not listed is refused with 403 before it leaves main.
// Never listed: terminals (`/api/pty*`, the experimental persistent terminals), shells and shell commands
// (`/api/shell*`, `session/:id/shell`), filesystem writes (`/api/experimental/fs/*`), credentials, config, MCP and
// plugin management, and every other experimental route.

const id = "[A-Za-z0-9_-]{1,128}"

export type Rule = {
  readonly name: string
  readonly methods: readonly string[]
  readonly path: RegExp
  // Requests (`METHOD /path`) the rule lets through
  readonly examples: readonly string[]
}

/** The plugin RPC methods the mobile app calls through `POST /api/rpc/:rpcID/:method`. None yet. */
export const rpc: readonly { readonly id: string; readonly method: string }[] = []

export const rules: readonly Rule[] = [
  {
    name: "list and create sessions",
    methods: ["GET", "POST"],
    path: /^\/api\/session$/,
    examples: ["GET /api/session", "POST /api/session"],
  },
  {
    name: "the active sessions",
    methods: ["GET"],
    path: /^\/api\/session\/active$/,
    examples: ["GET /api/session/active"],
  },
  {
    name: "read, rename and delete a session",
    methods: ["GET", "PATCH", "DELETE"],
    path: new RegExp(`^/api/session/${id}$`),
    examples: ["GET /api/session/ses_1", "PATCH /api/session/ses_1", "DELETE /api/session/ses_1"],
  },
  {
    name: "read a session's messages, context, diff, permissions, forms and inbox",
    methods: ["GET"],
    path: new RegExp(`^/api/session/${id}/(message(/${id})?|context|diff|permission(/${id})?|form(/${id})?|inbox)$`),
    examples: [
      "GET /api/session/ses_1/message",
      "GET /api/session/ses_1/message/msg_1",
      "GET /api/session/ses_1/context",
      "GET /api/session/ses_1/diff",
      "GET /api/session/ses_1/permission",
      "GET /api/session/ses_1/permission/per_1",
      "GET /api/session/ses_1/form",
      "GET /api/session/ses_1/form/frm_1",
      "GET /api/session/ses_1/inbox",
    ],
  },
  {
    name: "drive a session: prompt, interrupt, commands, compact, fork, agent, model, view and revert",
    methods: ["POST"],
    path: new RegExp(
      `^/api/session/${id}/(prompt|interrupt|command|compact|fork|agent|model|view|revert/stage|revert/commit)$`,
    ),
    examples: [
      "POST /api/session/ses_1/prompt",
      "POST /api/session/ses_1/interrupt",
      "POST /api/session/ses_1/command",
      "POST /api/session/ses_1/compact",
      "POST /api/session/ses_1/fork",
      "POST /api/session/ses_1/agent",
      "POST /api/session/ses_1/model",
      "POST /api/session/ses_1/view",
      "POST /api/session/ses_1/revert/stage",
      "POST /api/session/ses_1/revert/commit",
    ],
  },
  {
    name: "clear a staged revert",
    methods: ["DELETE"],
    path: new RegExp(`^/api/session/${id}/revert$`),
    examples: ["DELETE /api/session/ses_1/revert"],
  },
  {
    name: "answer a permission request",
    methods: ["POST"],
    path: new RegExp(`^/api/session/${id}/permission/${id}/reply$`),
    examples: ["POST /api/session/ses_1/permission/per_1/reply"],
  },
  {
    name: "answer a question",
    methods: ["POST"],
    path: new RegExp(`^/api/session/${id}/form/${id}/reply$`),
    examples: ["POST /api/session/ses_1/form/frm_1/reply"],
  },
  {
    name: "cancel a question",
    methods: ["DELETE"],
    path: new RegExp(`^/api/session/${id}/form/${id}$`),
    examples: ["DELETE /api/session/ses_1/form/frm_1"],
  },
  {
    name: "change or cancel a queued prompt",
    methods: ["PATCH", "DELETE"],
    path: new RegExp(`^/api/session/${id}/inbox/${id}$`),
    examples: ["PATCH /api/session/ses_1/inbox/inb_1", "DELETE /api/session/ses_1/inbox/inb_1"],
  },
  { name: "the event stream", methods: ["GET"], path: /^\/api\/event$/, examples: ["GET /api/event"] },
  {
    name: "pending permission requests and saved permissions",
    methods: ["GET"],
    path: /^\/api\/permission\/(request|saved)$/,
    examples: ["GET /api/permission/request", "GET /api/permission/saved"],
  },
  {
    name: "change or remove a saved permission",
    methods: ["PATCH", "DELETE"],
    path: new RegExp(`^/api/permission/saved/${id}$`),
    examples: ["PATCH /api/permission/saved/1", "DELETE /api/permission/saved/1"],
  },
  { name: "pending questions", methods: ["GET"], path: /^\/api\/form$/, examples: ["GET /api/form"] },
  { name: "the agents", methods: ["GET"], path: /^\/api\/agent$/, examples: ["GET /api/agent"] },
  {
    name: "the models and the default model",
    methods: ["GET"],
    path: /^\/api\/model(\/default)?$/,
    examples: ["GET /api/model", "GET /api/model/default"],
  },
  {
    name: "list and rename projects",
    methods: ["GET", "PATCH"],
    path: new RegExp(`^/api/project(/${id})?$`),
    examples: ["GET /api/project", "PATCH /api/project/prj_1"],
  },
  { name: "the server's identity", methods: ["GET"], path: /^\/api\/info$/, examples: ["GET /api/info"] },
  {
    name: "the plugin RPC methods the app needs",
    methods: ["POST"],
    path: new RegExp(`^/api/rpc/(${rpc.map((entry) => `${entry.id}/${entry.method}`).join("|") || "(?!)"})$`),
    examples: rpc.map((entry) => `POST /api/rpc/${entry.id}/${entry.method}`),
  },
]

// A path the proxy forwards: plain characters only, so nothing percent-encoded, no backslash, no `.` or empty
// segment can make the service read a path the rules did not.
const plain = /^(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)+$/

/** The rule a request matches, or undefined. `target` is the path with its query, as the phone sent it. */
export function match(method: string, target: string) {
  const at = target.indexOf("?")
  const path = at < 0 ? target : target.slice(0, at)
  if (!plain.test(path) || path.split("/").some((segment) => segment === "." || segment === "..")) return undefined
  if (at >= 0 && /[#\s]/.test(target.slice(at))) return undefined
  return rules.find((rule) => rule.methods.includes(method) && rule.path.test(path))
}

/** Request headers the proxy passes on. Credentials, cookies and hop-by-hop headers never are. */
export const requestHeaders = ["accept", "content-type", "last-event-id", "x-opencode-directory"]

/** Response headers the proxy passes back. */
export const responseHeaders = ["content-type", "cache-control", "etag", "last-modified"]
