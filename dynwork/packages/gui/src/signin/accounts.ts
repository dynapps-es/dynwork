export * as SignInAccounts from "./accounts"

export type Instance = {
  id: string
  name: string
  host: string
  // The user's role on the instance, when its manifest names one
  role?: string
  skills: number
  agents: number
  servers: number
}

export type Probe =
  // `login` is the instance's page that shows a one-time code to paste into the token field
  { reachable: true; host: string; login?: string } | { reachable: false; reason: Problem }

// Why an instance URL does not work: not an http(s) URL, no answer, or an answer that is not a supported systemprompt.
export type Problem = "format" | "unreachable" | "incompatible"

// Why a sign-in failed, as the Ipc names it.
export type Failure =
  | "denied"
  | "expired"
  | "unreachable"
  | "refused"
  | "rate-limited"
  | "incompatible"
  | "insecure"
  | "failed"

export type SignIn = "signed-in" | "cancelled" | Failure

// The remote side of the sign-in screen. `SignInReal.create` implements it over the `dynwork.accounts` Ipc; the mock
// below stands in for it in tests and stories. No call rejects: a failure is an answer.
export interface Interface {
  probe(url: string): Promise<Probe>
  // `keep` false keeps the personal access token out of the store: the account is signed out on the next launch.
  signInBrowser(url: string, keep: boolean): Promise<SignIn>
  signInToken(url: string, token: string, keep: boolean): Promise<SignIn>
  // Ends a pending browser sign-in, which then resolves as cancelled.
  cancel(): void
  instances(): Promise<Instance[]>
  finish(instance: Instance, progress: (synced: number) => void): Promise<void>
}

export const instances: Instance[] = [
  { id: "dynapps", name: "Dynapps", host: "sp.dynapps.es", role: "Admin", skills: 12, agents: 4, servers: 3 },
  { id: "demo", name: "Demo", host: "demo.sp.dynapps.es", role: "Member", skills: 6, agents: 2, servers: 1 },
  { id: "sandbox", name: "Sandbox", host: "sandbox.sp.dynapps.es", role: "Member", skills: 3, agents: 1, servers: 2 },
]

const scheme = /^[a-z][a-z0-9+.-]*:\/\//i

// The only hosts that may use plain http, as in the Sp client.
const loopback = ["localhost", "127.0.0.1", "[::1]"]

// An instance URL is any http(s) URL with a host. Without a scheme it is https, or http for a loopback host: people
// type `governance.ai.dyncloud.es` and `127.0.0.1:18101`. (`localhost:4096` is not read as a `localhost:` scheme.)
export function parseURL(value: string) {
  const text = value.trim()
  const explicit = scheme.test(text)
  const url = parse(explicit ? text : `https://${text}`)

  if (!url) return undefined

  if (!explicit && loopback.includes(url.hostname)) return parse(`http://${text}`)

  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined

  if (!url.hostname) return undefined

  return url
}

// The URL the whole sign-in works with: the probe, the sign-in and the stored account all get this one.
export function normalizeURL(value: string) {
  return parseURL(value)?.href.replace(/\/+$/, "")
}

function parse(text: string) {
  return URL.canParse(text) ? new URL(text) : undefined
}

// Every remote step answers after a short delay, without network.
export function mock(): Interface {
  const browser = { cancel: () => {} }

  return {
    probe: async (url) => {
      await wait(600)
      const parsed = parseURL(url)

      return parsed ? { reachable: true, host: parsed.host } : { reachable: false, reason: "format" }
    },
    signInBrowser: () =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve("signed-in"), 2000)

        browser.cancel = () => {
          clearTimeout(timer)
          resolve("cancelled")
        }
      }),
    signInToken: () => wait(1000).then(() => "signed-in" as const),
    cancel: () => browser.cancel(),
    instances: async () => instances,
    finish: async (instance, progress) => {
      // About 1.5 s in all, one step per skill.
      for (const synced of Array.from({ length: instance.skills }, (_, index) => index + 1)) {
        await wait(1500 / instance.skills)
        progress(synced)
      }
    },
  }
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}
