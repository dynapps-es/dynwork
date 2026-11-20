import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { TextInput } from "@opencode/ui/text-input"
import { createResource, createSignal, For, Show } from "solid-js"
import { isFailure, type Document, type Person } from "../../drive/contract"
import { Avatar, failureText } from "./parts"
import { drive } from "./store"

// The owner's actions on a document, which only the person may do (G01) and DynWork does as them while their session
// is on: moving it to the trash and giving it to someone else. Each has its own confirmation, and the instance may still
// ask for a recent sign-in in the browser before it does it.

/** Asks before a document goes to the trash. */
export function TrashDialog(props: { doc: Document; close: () => void }) {
  const ctx = usePlugin()
  const [busy, setBusy] = createSignal(false)
  const trash = async () => {
    setBusy(true)
    const done = await drive.trash(props.doc.id)
    setBusy(false)
    if (isFailure(done))
      return ctx.toast.show({ title: ctx.t("drive.trash.failed"), description: failureText(ctx, done), variant: "error" })
    props.close()
    ctx.toast.show({ title: ctx.t("drive.trash.done", { name: props.doc.name }) })
  }
  return (
    <Dialog>
      <DialogHeader>
        <DialogTitleGroup
          title={ctx.t("drive.trash.title", { name: props.doc.name })}
          description={ctx.t("drive.trash.text")}
        />
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" onClick={props.close}>
          {ctx.t("drive.cancel")}
        </Button>
        <Button variant="contrast" disabled={busy()} onClick={() => void trash()}>
          {ctx.t("drive.trash.confirm")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

/** Picks who the document goes to, from the instance's directory, and asks before it does. */
export function TransferDialog(props: { doc: Document; close: () => void }) {
  const ctx = usePlugin()
  const [query, setQuery] = createSignal("")
  const [chosen, setChosen] = createSignal<Person>()
  const [busy, setBusy] = createSignal(false)
  const [found] = createResource(
    () => (query().trim().length >= 2 ? query().trim() : undefined),
    async (text) => {
      await new Promise((resolve) => setTimeout(resolve, 250))
      if (text !== query().trim()) return []
      const answer = await drive.client()?.findPeople({ query: text, limit: 6 })
      return !answer || isFailure(answer) ? [] : answer
    },
  )
  const people = () => (found.state === "ready" ? found() : undefined)
  const transfer = async () => {
    const person = chosen()
    if (!person) return
    setBusy(true)
    const done = await drive.transfer(props.doc.id, person.id)
    setBusy(false)
    if (isFailure(done))
      return ctx.toast.show({
        title: ctx.t("drive.transfer.failed"),
        description: failureText(ctx, done),
        variant: "error",
      })
    props.close()
    ctx.toast.show({ title: ctx.t("drive.transfer.done", { name: person.name }) })
  }
  return (
    <Dialog>
      <DialogHeader>
        <DialogTitleGroup
          title={ctx.t("drive.transfer.title", { name: props.doc.name })}
          description={ctx.t("drive.transfer.text")}
        />
      </DialogHeader>
      <DialogBody>
        <div data-slot="drive-share">
          <TextInput
            appearance="base"
            leadingIcon={<Icon name="magnifying-glass" size="small" />}
            placeholder={ctx.t("drive.share.invite")}
            aria-label={ctx.t("drive.share.invite")}
            value={query()}
            onInput={(event) => {
              setQuery(event.currentTarget.value)
              setChosen(undefined)
            }}
          />
          <Show when={query().trim().length >= 2}>
            <div data-slot="drive-share-found">
              <For
                each={people() ?? []}
                fallback={
                  <p data-slot="drive-note">{ctx.t(found.loading ? "drive.share.searching" : "drive.share.nobody")}</p>
                }
              >
                {(person) => (
                  <button
                    type="button"
                    data-slot="drive-person"
                    aria-pressed={chosen()?.id === person.id}
                    onClick={() => setChosen(person)}
                  >
                    <Avatar name={person.name} size="small" />
                    <span data-slot="drive-person-name">
                      {person.name}
                      <Show when={person.email}>{(email) => <span data-slot="drive-faint">{email()}</span>}</Show>
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={props.close}>
          {ctx.t("drive.cancel")}
        </Button>
        <Button variant="contrast" disabled={busy() || !chosen()} onClick={() => void transfer()}>
          {chosen() ? ctx.t("drive.transfer.to", { name: chosen()?.name ?? "" }) : ctx.t("drive.transfer.confirm")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
