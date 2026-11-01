import { For, Match, Switch } from "solid-js"
import { Dynamic } from "solid-js/web"
import { parseMarkdown, sourceLines, type Inline } from "./model"

const headings = ["h1", "h2", "h3", "h4", "h5", "h6"] as const

/** A document rendered from its Markdown: headings, paragraphs, lists, a table, a quote, bold and code. */
export function MarkdownBody(props: { source: string }) {
  return (
    <div data-slot="brain-body">
      <For each={parseMarkdown(props.source)}>
        {(block) => (
          <Switch>
            <Match when={block.kind === "heading" && block}>
              {(item) => (
                <Dynamic component={headings[item().level - 1]} data-slot="brain-heading">
                  <Spans text={item().text} />
                </Dynamic>
              )}
            </Match>
            <Match when={block.kind === "paragraph" && block}>
              {(item) => (
                <p>
                  <Spans text={item().text} />
                </p>
              )}
            </Match>
            <Match when={block.kind === "quote" && block}>
              {(item) => (
                <blockquote>
                  <Spans text={item().text} />
                </blockquote>
              )}
            </Match>
            <Match when={block.kind === "list" && block}>
              {(item) => (
                <Switch>
                  <Match when={item().ordered}>
                    <ol>
                      <For each={item().items}>
                        {(text) => (
                          <li>
                            <Spans text={text} />
                          </li>
                        )}
                      </For>
                    </ol>
                  </Match>
                  <Match when={!item().ordered}>
                    <ul>
                      <For each={item().items}>
                        {(text) => (
                          <li>
                            <Spans text={text} />
                          </li>
                        )}
                      </For>
                    </ul>
                  </Match>
                </Switch>
              )}
            </Match>
            <Match when={block.kind === "table" && block}>
              {(item) => (
                <table>
                  <thead>
                    <tr>
                      <For each={item().head}>
                        {(cell) => (
                          <th>
                            <Spans text={cell} />
                          </th>
                        )}
                      </For>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={item().rows}>
                      {(row) => (
                        <tr>
                          <For each={row}>
                            {(cell) => (
                              <td>
                                <Spans text={cell} />
                              </td>
                            )}
                          </For>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              )}
            </Match>
          </Switch>
        )}
      </For>
    </div>
  )
}

/** The Markdown source in a code view, line numbered, with the front matter and headings tinted. */
export function SourceView(props: { source: string; label: string }) {
  return (
    <pre data-slot="brain-source" aria-label={props.label}>
      <For each={sourceLines(props.source)}>
        {(line) => <span data-kind={line.kind || undefined}>{line.text || " "}</span>}
      </For>
    </pre>
  )
}

function Spans(props: { text: readonly Inline[] }) {
  return (
    <For each={props.text}>
      {(part) => (
        <Switch fallback={part.text}>
          <Match when={part.kind === "code"}>
            <code>{part.text}</code>
          </Match>
          <Match when={part.kind === "strong"}>
            <strong>{part.text}</strong>
          </Match>
        </Switch>
      )}
    </For>
  )
}
