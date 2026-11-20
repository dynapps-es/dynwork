export * as AccountsIpc from "./ipc"

import { SpClient } from "@dynwork/sp-client"
import type { IpcImpl } from "@opencode/plugin/gui/main"
import type { DynWorkSyncEngine } from "../sync/engine"
import { DynWorkAccounts } from "./accounts"
import type { Account, Accounts, SignIn } from "./contract"
import type { DynWorkPerson } from "./person"

// The `dynwork.accounts` Ipc over a main-process accounts service. A sign-in that fails answers with its kind instead
// of rejecting: the Ipc would turn a rejection into plain text, and the window picks its own copy per kind. Each
// account carries how DynWork acts as the person (`person`), as a status: the person's tokens stay in main.
export function implementation(
  accounts: DynWorkAccounts.Accounts,
  engine: Pick<DynWorkSyncEngine.Engine, "status" | "now">,
  person: Pick<DynWorkPerson.Service, "status" | "signIn" | "signOut" | "cancel">,
): IpcImpl<(typeof Accounts)["spec"]> {
  const shown = (account: Account) => ({ ...account, person: person.status(account.id) })
  return {
    state: () => {
      const state = accounts.state()
      return { ...state, accounts: state.accounts.map(shown), sync: engine.status() }
    },
    list: () => accounts.list().map(shown),
    add: (url) => accounts.add(url),
    probe: (url) => accounts.probe(url),
    signInBrowser: (input, caller) => accounts.signInBrowser(input.url, caller.signal, input.keep).catch(failure),
    signInToken: (input) => accounts.signInToken(input).catch(failure),
    summary: (id) => accounts.summary(id),
    cancel: () => accounts.cancel(),
    activate: (id) => accounts.activate(id),
    // The person's session goes first, while the account's JWT can still revoke it at the instance
    signOut: async (id) => {
      await person.signOut(id)
      accounts.signOut(id)
    },
    remove: async (id) => {
      await person.signOut(id)
      accounts.remove(id)
    },
    trust: (input) => accounts.trust(input),
    syncNow: () => engine.now(),
    personSignIn: (id, caller) => person.signIn(id, { signal: caller.signal }),
    personSignOut: (id) => person.signOut(id),
    personCancel: () => person.cancel(),
  }
}

// SAFETY: a rejection's reason is unknown by contract; this is the boundary that maps it, by `instanceof` only.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- see SAFETY above
export function failure(error: unknown): Exclude<SignIn, "signed-in" | "cancelled" | "denied" | "expired"> {
  if (error instanceof SpClient.Unreachable) return "unreachable"
  if (error instanceof SpClient.Unauthorized) return "refused"
  if (error instanceof SpClient.RateLimited) return "rate-limited"
  if (error instanceof SpClient.Incompatible || error instanceof SpClient.Protocol) return "incompatible"
  if (error instanceof DynWorkAccounts.SecureStorageUnavailable) return "insecure"
  return "failed"
}
