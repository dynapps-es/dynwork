import type { Account, State, SyncStatus } from "../../src/accounts/contract"

const pinned = "sha256:02c4e6a8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6a8b0d2f4"
const offered = "sha256:b51e0d7a3c9f2e84a6b0d2c4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b6c8d0e2f4"

export const fingerprints = { pinned, offered }

export function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "alpha",
    label: "Dynapps",
    url: "https://sp.dynapps.test",
    user: "dev@dynapps.test",
    org: "Dynapps Engineering",
    status: "signedIn",
    active: false,
    fingerprint: pinned,
    pinned,
    trusted: true,
    ...overrides,
  }
}

export const synced = (account: string, at = 1_000_000): SyncStatus => ({
  status: "synced",
  account,
  at,
  counts: { skills: 12, agents: 4, mcp: 3, rules: 2 },
})

export function state(accounts: Account[], sync: SyncStatus = { status: "idle" }): State {
  return { accounts, sync }
}
