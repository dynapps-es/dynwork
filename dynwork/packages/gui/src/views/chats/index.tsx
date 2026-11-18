import { usePlugin } from "@opencode/plugin/gui"
import { builtinContext } from "@opencode/plugin/gui/builtin"
import { DataProvider } from "@opencode/session-ui/context"
import { SessionTimeline } from "@opencode/session-ui/timeline"
import { Button } from "@opencode/ui/button"
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import { ChatsBackend } from "../../chats/backend"
import { ChatsChat } from "../../chats/chat"
import { isFailure, type Model, type Thread } from "../../chats/contract"
import { ViewShell } from "../shell"
import { navGroups, NEW } from "./model"
import "./chats.css"

// The Chats view: the user's cloud chats, read and written through the `dynwork.chats` Ipc (`../../chats`). The list is
// the shell's sub-navigation; the conversation is the session UI's own timeline over the chat's document, and the
// composer is the app's chat composer (`BuiltinUi.ChatComposer`). Nothing here reaches OpenCode's service: it renders
// with the service stopped.
export default function ChatsView() {
  const ctx = usePlugin()
  const t = (key: string) => ctx.t(key)
  const state = () => ChatsBackend.client()?.state()
  const threads = () => state()?.threads ?? []
  const [models, setModels] = createSignal<readonly Model[]>([])
  // `key` names the conversation on screen; a new chat keeps its key when its first prompt makes it a thread.
  const [open, setOpen] = createSignal<{ key: string; thread?: string }>({ key: NEW })

  createEffect(
    on(ChatsBackend.client, (client) => {
      if (!client) return
      void client.refresh()
      void client.models().then((answer) => setModels(isFailure(answer) ? [] : answer))
    }),
  )

  const select = (id: string) => setOpen(id === NEW ? { key: `${NEW}:${Date.now()}` } : { key: id, thread: id })
  const status = () => {
    const current = state()?.status
    return current && current !== "ready" ? t(`chats.status.${current}`) : undefined
  }

  return (
    <ViewShell
      view="chats"
      title={t("chats.title")}
      description={t("chats.description")}
      demo={false}
      status={status()}
      actions={
        <Button variant="contrast" icon="plus" onClick={() => select(NEW)}>
          {t("chats.new")}
        </Button>
      }
      nav={{ groups: navGroups(threads(), t), selected: open().thread ?? NEW, select }}
    >
      <Show when={open().key} keyed>
        {(key) => (
          <Conversation
            thread={open().thread}
            threads={threads()}
            models={models()}
            created={(thread) => setOpen({ key, thread: thread.id })}
          />
        )}
      </Show>
    </ViewShell>
  )
}

function Conversation(props: {
  thread?: string
  threads: readonly Thread[]
  models: readonly Model[]
  created: (thread: Thread) => void
}) {
  const ctx = usePlugin()
  const Composer = builtinContext(ctx).ui.ChatComposer
  const thread = createMemo(() => props.threads.find((item) => item.id === props.thread))
  const chat = ChatsChat.make({
    client: ChatsBackend.client,
    thread,
    models: () => props.models,
    created: (made) => props.created(made),
  })

  // History, then the live events, while the chat is on screen. A new chat starts following once its prompt made it.
  createEffect(
    on(chat.made, (made) => {
      if (!made) return
      const following = new AbortController()
      onCleanup(() => following.abort())
      void chat.load().then(() => chat.follow(following.signal))
    }),
  )

  const data = createMemo(() => ({
    session: [
      {
        id: chat.id,
        title: thread()?.title ?? "",
        time: { created: thread()?.created ?? 0, updated: thread()?.updated ?? 0 },
      },
    ],
    session_status: { [chat.id]: chat.chat().status },
    session_diff: { [chat.id]: [] },
    provider: {
      all: new Map(
        [...new Set(props.models.map((model) => model.provider))].map((provider) => [
          provider,
          {
            models: Object.fromEntries(
              props.models
                .filter((model) => model.provider === provider)
                .map((model) => [model.id, { name: model.name }]),
            ),
          },
        ]),
      ),
      connected: [...new Set(props.models.map((model) => model.provider))],
      default: {},
    },
  }))

  return (
    <div data-slot="chats-conversation">
      {/* Reversed, so the newest message stays in view while a reply streams in. */}
      <div data-slot="chats-timeline">
        <Show
          when={chat.chat().messages.length > 0}
          fallback={
            <div data-slot="chats-empty">
              <h2>{ctx.t("chats.empty.title")}</h2>
              <p>{ctx.t("chats.empty.text")}</p>
            </div>
          }
        >
          <DataProvider data={data()} directory="" sessionID={chat.id} agents={false}>
            <SessionTimeline document={chat.document()} class="mx-auto w-full max-w-[840px]" />
          </DataProvider>
        </Show>
      </div>
      <Show when={chat.failure()}>{(failure) => <p data-slot="chats-failure">{failure().message}</p>}</Show>
      <div data-slot="chats-composer">
        <Composer
          working={chat.composer.working}
          available={chat.composer.available}
          placeholder={ctx.t(chat.working() ? "chats.placeholder.followUp" : "chats.placeholder")}
          models={chat.composer.models}
          model={chat.composer.model}
          onModel={chat.composer.onModel}
          onSubmit={chat.composer.onSubmit}
          onStop={chat.composer.onStop}
        />
      </div>
    </div>
  )
}
