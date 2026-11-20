import { usePlugin } from "@opencode/plugin/gui"
import { Popover } from "@opencode/ui/popover"
import { onCleanup, Show } from "solid-js"
import type { Document } from "../../drive/contract"
import { askAgent } from "./chat"
import { CommentForm } from "./comments"
import type { Inline } from "./spot"

// The comment popup: with the marks shown, a selection or a click on a document opens it beside what was picked, to
// write a comment right there, in the Drive and beside a chat (`createInline` keeps its state). The standard Popover,
// anchored to the picked rectangle: below it, or above when there is no room, and inside the window. Loaded on the
// client only, as the Drive's menus are (`menus.tsx`): Kobalte's popover runs browser-only code when it loads.

/**
 * The popup at the spot `inline` shows: what the comment points at, the text with the agent's mention, Comment and
 * Cancel. Sent, it closes and the new thread's mark shows on the document, where the reader is: nothing moves, and
 * nothing opens over a chat (the Drive's Comments tab has the thread, quietly: `drive.comment`). Escape and Cancel close
 * it without a comment; a click outside closes it only while nothing is written (`createInline`). With `ask`, a quote also
 * offers to ask the agent about it, as the selection toolbar does.
 */
export default function CommentPopup(props: { doc: Document; inline: Inline; ask?: boolean }) {
  const ctx = usePlugin()
  return (
    // A new spot is a new popup, anchored there.
    <Show when={props.inline.spot()} keyed>
      {(spot) => (
        <Popover
          open
          onOpenChange={(open) => {
            if (!open) props.inline.outside()
          }}
          placement="bottom-start"
          // Kobalte reads an anchor's rectangle as x and y.
          getAnchorRect={() => ({
            x: spot.rect.left,
            y: spot.rect.top,
            width: spot.rect.width,
            height: spot.rect.height,
          })}
          class="drive-comment-popup"
          triggerAs="span"
          triggerProps={{ class: "drive-popup-anchor", "aria-hidden": "true" }}
        >
          <div
            ref={(element) => {
              // Escape is the popup's own (`data-owns-escape`): it drops what is written, and goes no further, so the
              // chat or the view under it does not take it too.
              const key = (event: KeyboardEvent) => {
                if (event.key !== "Escape") return
                event.preventDefault()
                event.stopPropagation()
                props.inline.close()
              }
              element.addEventListener("keydown", key)
              onCleanup(() => element.removeEventListener("keydown", key))
            }}
            data-slot="drive-popup"
            data-owns-escape=""
            role="group"
            aria-label={ctx.t("drive.comment.new")}
          >
            <CommentForm
              doc={props.doc}
              anchor={spot.anchor}
              onCancel={() => props.inline.close()}
              onInput={props.inline.setDraft}
              onSent={() => props.inline.close()}
              extra={
                <Show when={props.ask && spot.quote}>
                  {(quote) => (
                    <ctx.ui.Tooltip value={ctx.t("drive.ask")}>
                      <ctx.ui.IconButton
                        variant="ghost"
                        size="small"
                        icon="speech-bubble"
                        label={ctx.t("drive.ask")}
                        onClick={() => {
                          props.inline.close()
                          askAgent(ctx, props.doc, ctx.t("drive.ask.quote", { doc: props.doc.name, quote: quote() }))
                        }}
                      />
                    </ctx.ui.Tooltip>
                  )}
                </Show>
              }
            />
          </div>
        </Popover>
      )}
    </Show>
  )
}
