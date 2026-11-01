export * as SignInCopy from "./copy"

// Every string the sign-in screen shows, in one place for a later i18n pass.

export const brand = {
  head: "One workspace for your agents.",
  body: "Your skills, agents and tools from systemprompt, ready in every session.",
  version: (version: string) => `DynWork v${version}`,
  docs: "Documentation →",
  docsURL: "https://dynapps.es",
  support: "Support — soporte@dynapps.es",
  supportURL: "mailto:soporte@dynapps.es",
}

export const panel = {
  label: "Sign in to DynWork",
  eyebrow: (version: string, step: number) => `v${version} · Step ${step} of 2`,
  heading: "Welcome to DynWork",
  lede: "Connect this device to your systemprompt instance. Your skills, agents and MCP servers sync automatically.",
}

export const connect = {
  label: "Instance URL",
  placeholder: "https://sp.example.com",
  empty: "Enter your instance URL",
  checking: "Checking…",
  valid: (host: string) => `Reachable · Signing in to ${host}`,
  invalid: {
    format: "Instance URL must start with http:// or https://",
    unreachable: "Can't reach this instance. Check the URL and your connection.",
    incompatible: "This address is not a supported systemprompt instance (0.76 or later).",
  },
  browser: "Sign in with your browser",
  waiting: "Waiting for your browser…",
  cancel: "Cancel",
  disabled: "Check the instance URL above, then try again.",
  keep: "Keep me signed in on this device",
  hint: "Opens your browser to sign in; this device is linked automatically.",
}

export const token = {
  toggle: "Use a personal access token instead",
  label: "Personal access token",
  placeholder: "sp-live-… or a one-time code",
  missing: "Don't have one?",
  login: "Get a one-time code from your instance →",
  connect: "Connect",
  connecting: "Connecting…",
  empty: "Enter a personal access token.",
}

// What a failed sign-in says, by the kind the accounts service answers with.
export const failure = {
  denied: "The sign-in was declined in the browser.",
  expired: "The sign-in link expired. Try again.",
  unreachable: "Can't reach the instance. Check your connection and try again.",
  refused: "The instance refused the sign-in. Check the token or code and try again.",
  "rate-limited": "Too many attempts. Wait a moment and try again.",
  incompatible: "This instance is not supported. DynWork needs systemprompt 0.76 or later.",
  insecure: "This device has no secure storage for credentials, so DynWork can't sign you in.",
  failed: "The sign-in failed. Try again.",
}

export const choose = {
  lede: "Choose the instance this workspace works with. You can add more later in Settings.",
  label: "Instance",
  sync: (counts: { skills: number; agents: number; servers: number }) =>
    [
      count(counts.skills, "skill", "skills"),
      count(counts.agents, "agent", "agents"),
      count(counts.servers, "MCP server", "MCP servers"),
    ].join(" · "),
  finish: "Finish",
  back: "Back",
}

export const finalizing = {
  title: "Finishing setup…",
  progress: (synced: number, total: number) => `Syncing your skills and agents (${synced}/${total})`,
}

function count(value: number, one: string, many: string) {
  return `${value} ${value === 1 ? one : many}`
}
