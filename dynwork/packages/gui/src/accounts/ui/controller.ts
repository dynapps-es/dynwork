export * as AccountsController from "./controller"

import { createStore } from "solid-js/store"
import type { Account, PersonSignIn, SignIn } from "../contract"
import type { Client } from "../renderer"
import type { AccountsModel } from "./model"

// The part of the Ipc client the page's actions call.
export type Actions = Pick<Client, "activate" | "signOut" | "remove" | "trust" | "syncNow">

/** The actions that end something ask first. */
export type Question = "sign-out" | "remove"

/**
 * Runs the page's actions over the live Ipc client: one at a time, asking before an account is signed out or removed,
 * and recording which account's action failed so the page can say so. An action while the client is gone fails the same
 * way, since main's accounts may be restarting.
 */
export function create(input: {
  client: () => Actions | undefined
  confirm: (question: Question, account: Account) => Promise<boolean>
}) {
  const [state, setState] = createStore({
    pending: undefined as { id: string; action: AccountsModel.Action } | undefined,
    failed: undefined as { id: string; action: AccountsModel.Action } | undefined,
  })

  const call = async (action: AccountsModel.Action, row: AccountsModel.Row, client: Actions) => {
    if (action === "make-active") return client.activate(row.account.id)

    if (action === "sync-now") return client.syncNow()

    // The fingerprint the user compared: a key the instance offers in between pins nothing.
    if (action === "trust" && row.key) return client.trust({ id: row.account.id, fingerprint: row.key.offered })

    if (action === "sign-out") {
      if (await input.confirm("sign-out", row.account)) return client.signOut(row.account.id)
      return
    }

    if (action === "remove") {
      if (await input.confirm("remove", row.account)) return client.remove(row.account.id)
      return
    }
  }

  return {
    state,
    /** `sign-in` is the page's: it opens the Add instance dialog. */
    async run(action: AccountsModel.Action, row: AccountsModel.Row) {
      if (state.pending) return
      setState({ pending: { id: row.account.id, action }, failed: undefined })
      const client = input.client()
      const failed = client
        ? await call(action, row, client).then(
            () => false,
            () => true,
          )
        : true

      setState({ pending: undefined, failed: failed ? { id: row.account.id, action } : undefined })
    },
  }
}

/**
 * What the titlebar pill's menu does, each action closing the menu first: switch the active instance, sync now, and
 * open the Accounts page. A failed call tells the user and nothing else.
 */
export function menu(input: {
  client: () => Pick<Client, "activate" | "syncNow"> | undefined
  settings: (page: string) => void
  failed: () => void
  close: () => void
}) {
  return {
    switchTo(id: string) {
      input.close()
      void input.client()?.activate(id).catch(input.failed)
    },
    syncNow() {
      input.close()
      void input.client()?.syncNow().catch(input.failed)
    },
    manage() {
      input.close()
      input.settings("accounts")
    },
  }
}

/**
 * Signing in again to an account whose sign-in the instance refused for good: the same browser sign-in as the first
 * one, for the account's instance. `outcome` is how the last try ended, for the window to say why it did not sign in;
 * a try while the client is gone ends as `failed`. A second `run` while one is going does nothing; `cancel` ends it.
 */
export function reconnect(input: { client: () => Pick<Client, "signInBrowser" | "cancel"> | undefined }) {
  const [state, setState] = createStore({ running: false, outcome: undefined as SignIn | undefined })

  return {
    state,
    async run(account: Pick<Account, "url">) {
      if (state.running) return
      const client = input.client()
      setState({ running: true, outcome: undefined })
      const outcome = client
        ? await client.signInBrowser({ url: account.url }).catch(() => "failed" as const)
        : ("failed" as const)

      setState({ running: false, outcome })
    },
    cancel() {
      void input
        .client()
        ?.cancel()
        .catch(() => undefined)
    },
  }
}

/**
 * DynWork acting as the person in the Drive: the person's sign-in in the browser, its cancel, and the sign-out.
 * `outcome` is how the last sign-in ended, `failed` that the last sign-out did not go through; a call while the client
 * is gone ends as `failed`. One sign-in at a time: a second `signIn` while one is going does nothing.
 */
export function person(input: {
  client: () => Pick<Client, "personSignIn" | "personSignOut" | "personCancel"> | undefined
}) {
  const [state, setState] = createStore({
    running: false,
    outcome: undefined as PersonSignIn | undefined,
    failed: false,
  })

  return {
    state,
    async signIn(id: string) {
      if (state.running) return
      const client = input.client()
      setState({ running: true, outcome: undefined, failed: false })
      const outcome = client ? await client.personSignIn(id).catch(() => "failed" as const) : ("failed" as const)

      setState({ running: false, outcome })
    },
    async signOut(id: string) {
      const client = input.client()
      setState({ outcome: undefined, failed: false })
      const failed = client
        ? await client.personSignOut(id).then(
            () => false,
            () => true,
          )
        : true

      setState({ failed })
    },
    cancel() {
      void input
        .client()
        ?.personCancel()
        .catch(() => undefined)
    },
  }
}
