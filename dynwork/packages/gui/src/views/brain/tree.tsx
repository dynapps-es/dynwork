import { usePlugin } from "@opencode/plugin/gui"
import { Icon } from "@opencode/ui/icon"
import { For, Show } from "solid-js"
import { spaces, type TreeNode } from "./demo"
import { highlight, searchTerms } from "./model"
import type { BrainStore } from "./store"

/** The brain's left column: the search field, then the spaces tree or the search results, then the Odoo footer. */
export function BrainSidebar(props: { brain: BrainStore; tree: boolean; open: (id: string) => void }) {
  const ctx = usePlugin()
  const searching = () => props.brain.state.query.trim().length > 0

  return (
    <div data-slot="brain-sidebar">
      <label data-slot="brain-search">
        <Icon name="magnifying-glass" />
        <input
          type="search"
          value={props.brain.state.query}
          placeholder={ctx.t("brain.search")}
          aria-label={ctx.t("brain.search")}
          onInput={(event) => props.brain.setQuery(event.currentTarget.value)}
        />
      </label>
      <Show
        when={searching()}
        fallback={
          <Show when={props.tree}>
            <nav data-slot="brain-tree" aria-label={ctx.t("brain.tree")}>
              <For each={spaces}>
                {(space) => (
                  <div data-slot="brain-space">
                    <button
                      type="button"
                      data-slot="brain-row"
                      data-kind="space"
                      aria-expanded={!!props.brain.state.expanded[space.id]}
                      onClick={() => props.brain.toggle(space.id)}
                    >
                      <Icon name="outline-chevron-down" size="small" />
                      <span data-slot="brain-row-label">{space.name}</span>
                      <Show when={space.origin !== "native"}>
                        <Icon name={space.origin === "mirror" ? "lock" : "branch"} size="small" />
                      </Show>
                    </button>
                    <Show when={props.brain.state.expanded[space.id]}>
                      <TreeNodes brain={props.brain} nodes={space.children} depth={1} open={props.open} />
                    </Show>
                  </div>
                )}
              </For>
            </nav>
          </Show>
        }
      >
        <Results brain={props.brain} open={props.open} />
      </Show>
      <div data-slot="brain-footer">
        <span data-slot="brain-footer-title">
          <span data-slot="brain-dot" data-tone="success" />
          {ctx.t("brain.footer.title")}
        </span>
        <span>{ctx.t("brain.footer.text")}</span>
      </div>
    </div>
  )
}

function TreeNodes(props: {
  brain: BrainStore
  nodes: readonly TreeNode[]
  depth: number
  open: (id: string) => void
}) {
  return (
    <div data-slot="brain-children">
      <For each={props.nodes}>
        {(node) => (
          <Show
            when={node.children}
            fallback={
              <button
                type="button"
                data-slot="brain-row"
                data-kind="document"
                data-state={props.brain.state.selected === node.id ? "pressed" : undefined}
                aria-current={props.brain.state.selected === node.id ? "page" : undefined}
                style={{ "padding-inline-start": `${6 + props.depth * 16}px` }}
                onClick={() => props.open(node.id)}
              >
                <Icon name="file-document" size="small" />
                <span data-slot="brain-row-label">{node.title}</span>
              </button>
            }
          >
            {(children) => (
              <>
                <button
                  type="button"
                  data-slot="brain-row"
                  data-kind="folder"
                  aria-expanded={!!props.brain.state.expanded[node.id]}
                  style={{ "padding-inline-start": `${6 + props.depth * 16}px` }}
                  onClick={() => props.brain.toggle(node.id)}
                >
                  <Icon name="outline-chevron-down" size="small" />
                  <span data-slot="brain-row-label">{node.title}</span>
                </button>
                <Show when={props.brain.state.expanded[node.id]}>
                  <TreeNodes brain={props.brain} nodes={children()} depth={props.depth + 1} open={props.open} />
                </Show>
              </>
            )}
          </Show>
        )}
      </For>
    </div>
  )
}

function Results(props: { brain: BrainStore; open: (id: string) => void }) {
  const ctx = usePlugin()
  const terms = () => searchTerms(props.brain.state.query)

  return (
    <Show
      when={terms().length > 0}
      fallback={
        <p data-slot="brain-empty" role="status">
          {ctx.t("brain.search.hint")}
        </p>
      }
    >
      <Show
        when={props.brain.results().length > 0}
        fallback={
          <p data-slot="brain-empty" role="status">
            {ctx.t("brain.search.empty")}
          </p>
        }
      >
        <div data-slot="brain-results" role="list" aria-label={ctx.t("brain.search.results")}>
          <For each={props.brain.results()}>
            {(hit) => (
              <button type="button" data-slot="brain-result" role="listitem" onClick={() => props.open(hit.id)}>
                <span data-slot="brain-result-title">
                  <Marked text={hit.title} terms={terms()} />
                </span>
                <span data-slot="brain-result-space">{hit.space}</span>
                <span data-slot="brain-result-snippet">
                  <For each={hit.snippet}>
                    {(segment) => (segment.match ? <mark>{segment.text}</mark> : <>{segment.text}</>)}
                  </For>
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </Show>
  )
}

function Marked(props: { text: string; terms: readonly string[] }) {
  return (
    <For each={highlight(props.text, props.terms)}>
      {(segment) => (segment.match ? <mark>{segment.text}</mark> : <>{segment.text}</>)}
    </For>
  )
}
