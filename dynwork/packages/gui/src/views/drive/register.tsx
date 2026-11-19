import { LinkHandler, MenuItem, Panel, Slot, type PanelTab, type SetupContext } from "@opencode/plugin/gui"
import { createEffect, createMemo, createSignal, lazy, Show, Suspense, untrack } from "solid-js"
import { isServer } from "solid-js/web"
import type definition from "../../accounts/index"
import { connection } from "../../accounts/renderer"
import { DriveClient } from "../../drive/client"
import { Drive } from "../../drive/contract"
import { docKey, listKey, origin, sessionOf } from "./chat"
import { arrivals, landing } from "./model"
import { DocTabLabel, ListTabLabel } from "./tab-label"
import { ArtifactsPanel, DocPanel } from "./panel"
import { registerShares } from "./share"
import { drive, follow } from "./store"
import "./drive.css"

// The chat header's artifacts button, on the client only: Kobalte's tooltip runs browser-only code when it loads, and
// the tests load the views with Solid's server build.
const ArtifactsCount = lazy(() => import("./count"))

// The Drive in the window: the `dynwork.drive` Ipc for the view and the panels, and beside a chat one side panel with a
// tab for the chat's artifacts and a tab per document, several at once (D6); the chat header's count of its artifacts;
// the + menu's "Drive" item; and the link of the Drive's composer chips, which opens the document's tab again.
export function registerDrive(ctx: SetupContext<typeof definition>) {
  DriveClient.attach(ctx.use(Drive))
  // The agent's shares wait for the user on a card in their conversation.
  registerShares(ctx)
  // The active account's Governance address and user name, for Open in Governance and the edition banner, from the
  // accounts Ipc the window entry already holds.
  createEffect(() => {
    const live = connection()
    const active =
      live?.status === "active" ? live.value.state()?.accounts.find((account) => account.active) : undefined
    follow(active && { url: active.url, user: active.user ?? active.label })
  })

  // A document the agent made or changed opens beside its chat, once per document and chat. What the account's index
  // already held when the window first read it (`seeded`) opens nothing.
  const seen = new Set<string>()
  const seeded = { account: undefined as string | undefined }
  createEffect(() => {
    const state = drive.remote()
    if (state?.status !== "ready") return
    const fresh = arrivals(state.links, seen)
    if (seeded.account !== state.account) {
      seeded.account = state.account
      return
    }
    untrack(() =>
      fresh.forEach((link) => {
        const session = sessionOf(ctx, link.conversation)
        if (!session || ctx.layout.state(docKey(link.document), session) !== "closed") return
        ctx.layout.open(docKey(link.document), session, { tab: landing(link.act), background: true })
      }),
    )
  })

  const list = createMemo(
    (): PanelTab => ({
      id: "drive",
      title: ctx.t("drive.panel.title"),
      group: "drive",
      label: (state) => <ListTabLabel title={ctx.t("drive.panel.title")} active={state.active} />,
    }),
  )
  // The same tab object per document while its title and the language stay: a new one would render its label again.
  const docs = new Map<string, PanelTab>()
  // A restored tab can name a document the window has not heard of: it is read once, hidden until then, and shown as
  // missing when the Drive no longer has it, so it can be closed.
  const asked = new Set<string>()
  const [gone, setGone] = createSignal<readonly string[]>([])
  const docTab = (id: string) => {
    const name = drive.doc(id)?.name
    const missing = name === undefined && gone().includes(id)
    const title = name ?? (missing ? ctx.t("drive.tab.missing") : id)
    if (name === undefined && !missing && drive.client() && !asked.has(id)) {
      asked.add(id)
      void drive.learn([id]).then((failed) => {
        const failure = failed.get(id)
        if (!failure) return
        // Only the Drive saying it has no such document, or none by that id, makes the tab missing; anything passing
        // reads it again later.
        if (["not-found", "forbidden", "invalid"].includes(failure.code)) return setGone((list) => [...list, id])
        asked.delete(id)
      })
    }
    const cached = docs.get(id)
    if (cached?.title === title) return cached
    const tab: PanelTab = {
      id: `drive.${id}`,
      title,
      group: "drive",
      hidden: name === undefined && !missing,
      missing,
      label: (state) => <DocTabLabel id={id} title={title} active={state.active} />,
    }
    docs.set(id, tab)
    return tab
  }

  ctx.add(
    Panel,
    (): Panel => ({
      id: "drive",
      region: "side",
      width: 520,
      mobile: { title: ctx.t("drive.panel.title"), order: 40, kind: "drawer", icon: "file-document" },
      list: (input) =>
        input.open.flatMap((id) => {
          if (id === "drive") return [list()]
          const doc = id.startsWith("drive.") ? id.slice("drive.".length) : undefined
          return doc ? [docTab(doc)] : []
        }),
      render: (props) => (
        <Show when={props.tab.id !== "drive"} fallback={<ArtifactsPanel session={props.session} />}>
          <DocPanel session={props.session} id={props.tab.id.slice("drive.".length)} />
        </Show>
      ),
    }),
  )

  ctx.add(
    MenuItem,
    (): MenuItem => ({
      menu: "session.panel",
      id: "drive",
      title: ctx.t("drive.title"),
      icon: "file-document",
      order: 40,
      run() {
        const session = ctx.sessions.current()
        if (session) ctx.layout.open(listKey, session, { tab: "open" })
      },
    }),
  )

  // In every chat's header while an account has a Drive, before the context ring (order 10).
  ctx.add(Slot, {
    at: "session.header",
    order: 5,
    render: (input) => (
      <Show when={!isServer && drive.status() !== "none"}>
        <Suspense>
          <ArtifactsCount session={input.session} />
        </Suspense>
      </Show>
    ),
  })

  ctx.add(LinkHandler, {
    match: (link) => link.origin === origin && link.href.startsWith(`${listKey}.`),
    open(link) {
      const session = link.session ?? ctx.sessions.current()
      if (session) ctx.layout.open(link.href, session, { tab: "select", background: link.background })
    },
  })
}
