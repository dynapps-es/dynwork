export * as SignInAccounts from "./accounts"

export type Instance = {
  id: string
  name: string
  host: string
  role: string
  skills: number
  agents: number
  servers: number
}

export type Probe = { reachable: true; host: string } | { reachable: false }

export type SignIn = "signed-in" | "cancelled"

// The remote side of the sign-in screen. The mock below stands in for systemprompt until real auth lands behind the
// same calls.
export interface Interface {
  probe(url: string): Promise<Probe>
  signInBrowser(url: string): Promise<SignIn>
  signInToken(url: string, token: string): Promise<SignIn>
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

// An instance URL is any http(s) URL with a host.
export function parseURL(value: string) {
  const text = value.trim()

  if (!URL.canParse(text)) return undefined
  const url = new URL(text)

  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined

  if (!url.hostname) return undefined

  return url
}

// Every remote step answers after a short delay, without network.
export function mock(): Interface {
  const browser = { cancel: () => {} }

  return {
    probe: async (url) => {
      await wait(600)
      const parsed = parseURL(url)

      return parsed ? { reachable: true, host: parsed.host } : { reachable: false }
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
