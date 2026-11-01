import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { TextInput } from "@opencode/ui/text-input"
import { Textarea } from "@opencode/ui/textarea"
import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { dayName, draftErrors, emptyDraft, repeats, type Draft } from "./schedule"

const week = [1, 2, 3, 4, 5, 6, 0]

/** The New routine dialog: it hands a valid draft to `add` and closes. */
export function NewRoutine(props: { add(draft: Draft): void; close(): void }) {
  const ctx = usePlugin()
  const [draft, setDraft] = createStore(emptyDraft())
  const errors = () => draftErrors(draft)

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (errors().length > 0) return
    props.add({ ...draft, days: [...draft.days] })
    props.close()
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup title={ctx.t("routines.new.title")} description={ctx.t("routines.new.description")} />
      </DialogHeader>
      <DialogBody>
        <form data-component="dynwork-new-routine" id="dynwork-new-routine" onSubmit={submit}>
          <div data-slot="new-routine-field">
            <label for="new-routine-name">{ctx.t("routines.new.name")}</label>
            <TextInput
              id="new-routine-name"
              autofocus
              placeholder={ctx.t("routines.new.namePlaceholder")}
              value={draft.name}
              onInput={(event) => setDraft("name", event.currentTarget.value)}
            />
          </div>
          <div data-slot="new-routine-field">
            <label for="new-routine-prompt">{ctx.t("routines.new.prompt")}</label>
            <Textarea
              id="new-routine-prompt"
              rows={3}
              placeholder={ctx.t("routines.new.promptPlaceholder")}
              value={draft.prompt}
              onInput={(event) => setDraft("prompt", event.currentTarget.value)}
            />
          </div>
          <div data-slot="new-routine-field">
            <label for="new-routine-folder">{ctx.t("routines.new.folder")}</label>
            <TextInput
              id="new-routine-folder"
              placeholder={ctx.t("routines.new.folderPlaceholder")}
              value={draft.folder}
              onInput={(event) => setDraft("folder", event.currentTarget.value)}
            />
          </div>
          <div data-slot="new-routine-pair">
            <div data-slot="new-routine-field">
              <label for="new-routine-repeat">{ctx.t("routines.new.repeat")}</label>
              <select
                id="new-routine-repeat"
                data-slot="new-routine-select"
                value={draft.repeat}
                onChange={(event) => setDraft("repeat", event.currentTarget.value as Draft["repeat"])}
              >
                <For each={repeats}>
                  {(repeat) => (
                    <option value={repeat} selected={draft.repeat === repeat}>
                      {ctx.t(`routines.repeat.${repeat}`)}
                    </option>
                  )}
                </For>
              </select>
            </div>
            <div data-slot="new-routine-field">
              <label for="new-routine-time">{ctx.t("routines.new.time")}</label>
              <TextInput
                id="new-routine-time"
                type="time"
                value={draft.time}
                invalid={errors().includes("time")}
                onInput={(event) => setDraft("time", event.currentTarget.value)}
              />
            </div>
          </div>
          <Show when={draft.repeat === "weekly"}>
            <div data-slot="new-routine-field">
              <label for="new-routine-day">{ctx.t("routines.new.day")}</label>
              <select
                id="new-routine-day"
                data-slot="new-routine-select"
                value={String(draft.days[0])}
                onChange={(event) => setDraft("days", [Number(event.currentTarget.value)])}
              >
                <For each={week}>
                  {(day) => (
                    <option value={day} selected={draft.days[0] === day}>
                      {dayName(day)}
                    </option>
                  )}
                </For>
              </select>
            </div>
          </Show>
          <Show when={draft.repeat === "custom"}>
            <div data-slot="new-routine-field" role="group" aria-label={ctx.t("routines.new.days")}>
              <span data-slot="new-routine-label">{ctx.t("routines.new.days")}</span>
              <div data-slot="new-routine-days">
                <For each={week}>
                  {(day) => (
                    <button
                      type="button"
                      data-slot="new-routine-day"
                      aria-pressed={draft.days.includes(day)}
                      onClick={() =>
                        setDraft("days", (days) =>
                          days.includes(day) ? days.filter((item) => item !== day) : [...days, day],
                        )
                      }
                    >
                      {dayName(day)}
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </form>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => props.close()}>
          {ctx.t("routines.new.cancel")}
        </Button>
        <Button type="submit" form="dynwork-new-routine" variant="contrast" disabled={errors().length > 0}>
          {ctx.t("routines.new.add")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
