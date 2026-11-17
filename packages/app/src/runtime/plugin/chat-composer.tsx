import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { BuiltinContext } from "@opencode/plugin/gui/builtin"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { Menu } from "@opencode/ui/menu"
import { Slash } from "@opencode/ui/slash"
import { ComposerEditor } from "@/composer/editor/editor"
import { createComposerEditor } from "@/composer/editor/interaction"
import type { ComposerPersistedState } from "@/composer/types"
import { useLanguage } from "@/runtime/i18n/language"
import {
  SessionComposerRegion,
  type SessionComposerRegionViewController,
} from "@/session/composer/session-composer-region"

type Props = Parameters<BuiltinContext["ui"]["ChatComposer"]>[0]

const empty = () => [{ type: "text" as const, content: "", start: 0, end: 0 }]

/**
 * `BuiltinUi.ChatComposer`: the session screen's composer region and composer over a conversation a built-in runs, as
 * the session stories build it. It never reads the app's server: no attachments, commands, mentions or shell, and the
 * model chip lists the built-in's own models.
 */
export default function ChatComposer(props: Props) {
  const language = useLanguage()
  const draft = createStore<ComposerPersistedState>({ prompt: empty(), cursor: 0, context: { items: [] } })

  const text = () =>
    draft[0].prompt
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
      .trim()

  const controller = createComposerEditor({
    store: draft,
    commands: () => [],
    context: () => [],
    searchContextFiles: () => [],
    view: {
      placeholder: () =>
        props.placeholder ??
        language.t(props.working ? "ui.promptInput.placeholder.followUp" : "ui.promptInput.placeholder.normal", {
          slash: "/",
          at: "@",
        }),
      submit: {
        available: () => props.available ?? true,
        stopping: () => props.working && text() === "",
        working: () => props.working,
        onSubmit: () => {
          const value = text()

          if (!value) return
          const kept = draft[0].prompt
          draft[1]("prompt", empty())
          draft[1]("cursor", 0)
          void props.onSubmit(value).then((sent) => {
            if (sent || text() !== "") return
            draft[1]("prompt", kept)
            draft[1]("cursor", value.length)
          })
        },
        onStop: () => props.onStop(),
      },
    },
  })

  // Nothing here asks for an answer: the conversation has no permissions, questions or web search choices.
  const region = {
    state: {
      questionRequest: () => undefined,
      elicitationRequest: () => undefined,
      websearch: {
        request: () => undefined,
        options: () => [],
        selected: () => undefined,
        specific: () => false,
        loading: () => false,
        loadFailed: () => false,
        failed: () => false,
        optionUnavailable: () => false,
        sending: () => false,
        connected: () => true,
        select() {},
        retry() {},
        submit: async () => {},
      },
      permissionRequest: () => undefined,
      permissionResponding: () => false,
      decide() {},
      blocked: () => false,
    },
    centered: () => false,
    onResponseSubmit() {},
    setDockRef() {},
    child: () => false,
    showComposer: () => true,
  } satisfies SessionComposerRegionViewController

  const current = createMemo(() =>
    props.models.find((model) => model.providerID === props.model?.providerID && model.id === props.model?.id),
  )

  return (
    <SessionComposerRegion
      controller={region}
      subagent={undefined}
      composer={
        <ComposerEditor
          controller={controller}
          borderUnderlay
          modelControlsVisible={props.models.length > 0}
          modelControl={
            <Menu gutter={4} modal={false} placement="top-start">
              <Menu.Trigger
                as={Button}
                data-action="composer-model"
                variant="ghost-muted"
                size="normal"
                class="min-w-0 max-w-[60cqw] justify-start ![font-weight:440]"
                style={{ height: "28px" }}
                title={language.t("command.model.choose")}
                onMouseDown={(event: MouseEvent) => event.preventDefault()}
              >
                <span class="flex min-w-0 whitespace-nowrap leading-4">
                  <Show when={current()}>
                    {(model) => (
                      <>
                        <bdi class="min-w-0 shrink-[2] truncate text-v2-text-text-faint">{model().provider}</bdi>
                        <Slash />
                        <span class="sr-only">{" / "}</span>
                      </>
                    )}
                  </Show>
                  <bdi class="min-w-0 truncate">{current()?.name ?? language.t("dialog.model.select.title")}</bdi>
                </span>
                <span class="-ml-0.5 -mr-1 flex shrink-0">
                  <Icon name="chevron-down" />
                </span>
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Content>
                  <Menu.RadioGroup
                    value={current() ? `${current()!.providerID}/${current()!.id}` : undefined}
                    onChange={(value: string) => {
                      const model = props.models.find((item) => `${item.providerID}/${item.id}` === value)

                      if (model) props.onModel(model)
                      controller.restoreFocus()
                    }}
                  >
                    <For each={props.models}>
                      {(model) => (
                        <Menu.RadioItem value={`${model.providerID}/${model.id}`}>
                          <span class="min-w-0 truncate">{model.name}</span>
                          <span class="ms-2 shrink-0 text-v2-text-text-faint">{model.provider}</span>
                        </Menu.RadioItem>
                      )}
                    </For>
                  </Menu.RadioGroup>
                </Menu.Content>
              </Menu.Portal>
            </Menu>
          }
        />
      }
    />
  )
}
