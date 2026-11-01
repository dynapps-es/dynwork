export * as AccountsText from "./text"

import type { Context } from "@opencode/plugin/gui"
import type { Counts } from "../contract"
import { AccountsModel } from "./model"

type Translate = Pick<Context, "t" | "plural">

/** What an instance's sync line says: when it synced, that it is syncing, or what failed. */
export function sync(ctx: Translate, value: AccountsModel.Sync, now: number) {
  const text = AccountsModel.describe(value, now)

  if (value.kind === "error") return ctx.t("sync.error", { message: ctx.t(text.key), time: text.time ?? "" })

  return ctx.t(text.key, text.time === undefined ? undefined : { time: text.time })
}

/** "12 skills · 4 agents · 3 MCP servers · 2 rules". */
export function counts(ctx: Translate, value: Counts) {
  return [
    ctx.plural("count.skills", value.skills),
    ctx.plural("count.agents", value.agents),
    ctx.plural("count.mcp", value.mcp),
    ctx.plural("count.rules", value.rules),
  ].join(" · ")
}

/** The signed-in line: who the account is, or that the user signed out of it. */
export function user(ctx: Translate, account: { user?: string; status: "signedIn" | "signedOut" }) {
  if (account.status === "signedOut")
    return account.user ? ctx.t("user.lastSignedIn", { user: account.user }) : ctx.t("badge.signedOut")

  return account.user ? ctx.t("user.signedIn", { user: account.user }) : ctx.t("user.signedInAnonymous")
}
