import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { For, Show } from "solid-js"
import { MarkdownBody, SourceView } from "./body"
import { canonicalState, type Located } from "./model"
import type { BrainStore, Mode } from "./store"

const modes: readonly Mode[] = ["view", "markdown"]

/** The open document: breadcrumb, title and actions, mode and language, metadata, then the body, source or editor. */
export function DocumentPage(props: { brain: BrainStore; item: Located }) {
  const ctx = usePlugin()
  const doc = () => props.brain.doc()
  const canon = () => canonicalState(doc())
  const origin = () => props.item.space.origin
  const editTitle = () => {
    if (origin() === "mirror") return ctx.t("brain.edit.locked")
    return props.brain.canEdit() ? undefined : ctx.t("brain.edit.noRights")
  }

  return (
    <article data-slot="brain-document" data-mode={props.brain.state.editing ? "edit" : props.brain.state.mode}>
      <div data-slot="brain-crumbs">
        {[props.item.space.name, ...props.item.trail.map((node) => node.title)].join(" / ")}
      </div>
      <div data-slot="brain-title-row">
        <h2 data-slot="brain-doc-title">{props.item.node.title}</h2>
        <div data-slot="brain-doc-actions">
          <Button
            variant="outline"
            icon="lock"
            data-state={props.brain.state.accessOpen ? "pressed" : undefined}
            aria-pressed={props.brain.state.accessOpen}
            onClick={() => props.brain.toggleAccess()}
          >
            {ctx.t("brain.access")}
          </Button>
          <Button
            variant="outline"
            icon="edit"
            disabled={!props.brain.canEdit() || props.brain.state.editing}
            title={editTitle()}
            onClick={() => props.brain.startEdit()}
          >
            {ctx.t("brain.edit")}
          </Button>
        </div>
      </div>
      <div data-slot="brain-toolbar">
        <div data-slot="brain-modes" role="group" aria-label={ctx.t("brain.mode")}>
          <For each={modes}>
            {(mode) => (
              <button
                type="button"
                data-state={props.brain.state.mode === mode ? "pressed" : undefined}
                aria-pressed={props.brain.state.mode === mode}
                disabled={props.brain.state.editing}
                onClick={() => props.brain.setMode(mode)}
              >
                {ctx.t(`brain.mode.${mode}`)}
              </button>
            )}
          </For>
        </div>
        <label data-slot="brain-language">
          <Icon name="globe" size="small" />
          <select
            aria-label={ctx.t("brain.language")}
            value={props.brain.language()}
            onChange={(event) => props.brain.setLanguage(event.currentTarget.value)}
          >
            <For each={doc().langs}>
              {(lang) => (
                <option value={lang} selected={props.brain.language() === lang}>
                  {lang}
                </option>
              )}
            </For>
          </select>
        </label>
        <span data-slot="brain-origin" data-origin={origin()}>
          <Show when={origin() !== "native"}>
            <Icon name={origin() === "mirror" ? "lock" : "branch"} size="small" />
          </Show>
          {ctx.t(`brain.origin.${origin()}`)}
        </span>
      </div>
      <dl data-slot="brain-props">
        <div>
          <dt>{ctx.t("brain.meta.type")}</dt>
          <dd>{doc().type}</dd>
        </div>
        <div>
          <dt>{ctx.t("brain.meta.owner")}</dt>
          <dd>{doc().owner}</dd>
        </div>
        <div>
          <dt>{ctx.t("brain.meta.canon")}</dt>
          <dd>
            <span data-slot="brain-dot" data-tone={canon().tone} />
            {ctx.t(canon().key, { date: canon().date })}
          </dd>
        </div>
        <div>
          <dt>{ctx.t("brain.meta.updated")}</dt>
          <dd>{doc().updated}</dd>
        </div>
      </dl>
      <Show when={origin() === "mirror"}>
        <p data-slot="brain-notice" data-tone="neutral">
          <Icon name="lock" size="small" />
          <span>
            <b>{ctx.t("brain.notice.mirror")}</b>{" "}
            {ctx.t("brain.notice.mirrorText", { repo: props.item.space.repo ?? "" })}
          </span>
        </p>
      </Show>
      <Show when={origin() === "managed"}>
        <p data-slot="brain-notice">
          <Icon name="branch" size="small" />
          <span>
            <b>{ctx.t("brain.notice.saved")}</b>{" "}
            {ctx.t("brain.notice.savedText", { repo: props.item.space.repo ?? "" })}
          </span>
        </p>
      </Show>
      <Show
        when={!props.brain.state.editing}
        fallback={
          <div data-slot="brain-editor">
            <textarea
              aria-label={ctx.t("brain.editor")}
              value={props.brain.state.draft}
              spellcheck={false}
              onInput={(event) => props.brain.setDraft(event.currentTarget.value)}
            />
            <div data-slot="brain-editor-actions">
              <Button variant="ghost" onClick={() => props.brain.cancelEdit()}>
                {ctx.t("brain.cancel")}
              </Button>
              <Button variant="contrast" onClick={() => props.brain.save()}>
                {ctx.t("brain.save")}
              </Button>
            </div>
          </div>
        }
      >
        <Show
          when={props.brain.state.mode === "view"}
          fallback={<SourceView source={doc().markdown} label={ctx.t("brain.source")} />}
        >
          <MarkdownBody source={doc().markdown} />
        </Show>
      </Show>
    </article>
  )
}
