import { usePlugin } from "@opencode/plugin/gui"
import { createMemo, createResource, lazy, Match, Switch } from "solid-js"
import { isServer } from "solid-js/web"
import type { DriveClient } from "../../drive/client"
import { isFailure, type Content, type Document, type Failure, type Page } from "../../drive/contract"
import { DriveFrames } from "../../drive/frames"
import { isPdf } from "./model"
import { failureText } from "./parts"
import { drive } from "./store"

// A document as its format is read, in the Drive view's workspace and in a chat's side panel (D5, D6):
// - HTML as designed (`/rendered`), in a sandboxed frame that mirrors the policy the instance served it with.
// - Markdown from its source (`/content`), with the app's own Markdown renderer, as the timeline draws a message.
// - A PDF from its stored bytes (`/content`), in DynWork's own viewer over pdf.js (`pdf-viewer.tsx`, loaded when a PDF
//   opens): no frame, no `blob:` URL, no PDF JavaScript and no network. The instance keeps an uploaded PDF as a `file`
//   typed `application/pdf`, which it does not render to PDF again (`?format=pdf` is for its own formats).
// - Word, Excel and PowerPoint as the Drive previews them (`/preview`), in the same frame as HTML, which that preview's
//   policy keeps without scripts.
// The account's JWT stays in main: a frame gets only the page, never DynWork's origin, cookies, token or Ipc.
// Nothing that comes out of a frame is trusted (G11): an agent writes these pages, so the viewer listens to no
// `message` event and reads no `postMessage`. A feature that wants one validates its origin and shape as untrusted input.

// pdf.js and the viewer load on the client only, when a PDF opens; the tests render with Solid's server build.
const PdfViewer = lazy(() => import("./pdf-viewer"))

/** What a viewer shows: a page for a frame, a Markdown source, or a PDF's bytes for pdf.js. */
export type Shown =
  | { readonly kind: "page"; readonly page: Page }
  | { readonly kind: "markdown"; readonly text: string; readonly revision?: string }
  | { readonly kind: "pdf"; readonly pdf: Content }

/** Reads a document the way its format is viewed, at `revision` or at its head. */
export async function load(
  client: DriveClient.Client,
  doc: Pick<Document, "id" | "format" | "mime">,
  revision?: string,
): Promise<Shown | Failure> {
  if (isPdf(doc)) {
    const pdf = await client.content({ id: doc.id, revision })
    return isFailure(pdf) ? pdf : { kind: "pdf", pdf }
  }
  if (doc.format === "markdown") {
    const source = await client.content({ id: doc.id, revision })
    if (isFailure(source)) return source
    return { kind: "markdown", text: new TextDecoder("utf-8").decode(source.bytes), revision: source.revision }
  }
  if (doc.format === "html") {
    const page = await client.rendered({ id: doc.id, revision })
    if (!isFailure(page)) return { kind: "page", page }
    // An instance without `/rendered` (before 0.83) still previews the page, without its scripts.
    if (page.code !== "unsupported" && page.code !== "not-found") return page
  }
  const page = await client.preview({ id: doc.id, revision })
  return isFailure(page) ? page : { kind: "page", page }
}

/** A document's viewer. It reads again when the document gets a new head, or when the tab picks another version. */
export function Viewer(props: { doc: Document; revision?: string }) {
  const ctx = usePlugin()
  // A snapshot or a listing hands over a new document object for the same document: only these fields read again.
  const source = createMemo(
    () => {
      const client = drive.client()
      if (!client) return undefined
      return {
        client,
        id: props.doc.id,
        format: props.doc.format,
        mime: props.doc.mime,
        head: props.doc.revision,
        revision: props.revision,
      }
    },
    undefined,
    {
      equals: (a, b) =>
        a?.client === b?.client &&
        a?.id === b?.id &&
        a?.format === b?.format &&
        a?.mime === b?.mime &&
        a?.head === b?.head &&
        a?.revision === b?.revision,
    },
  )
  const [shown] = createResource(source, (input) => load(input.client, input, input.revision))
  const failed = () => {
    const answer = shown()
    return answer && isFailure(answer) ? answer : undefined
  }
  const ready = () => {
    const answer = shown()
    return answer && !isFailure(answer) ? answer : undefined
  }
  const page = () => {
    const answer = ready()
    return answer?.kind === "page" ? answer.page : undefined
  }
  const markdown = () => {
    const answer = ready()
    // The answer, not its text: an empty document is still one to show
    return answer?.kind === "markdown" ? answer : undefined
  }
  const pdf = () => {
    const answer = ready()
    return answer?.kind === "pdf" ? answer.pdf : undefined
  }
  return (
    <Switch fallback={<p data-slot="drive-note">{ctx.t("drive.loading")}</p>}>
      <Match when={failed()}>
        {(failure) => (
          <p data-slot="drive-note">
            {ctx.t("drive.preview.failed")} {failureText(ctx, failure())}
          </p>
        )}
      </Match>
      <Match when={page()}>{(found) => <PageFrame page={found()} title={props.doc.name} />}</Match>
      <Match when={markdown()}>
        {(found) => (
          <div data-slot="drive-markdown">
            <ctx.ui.Markdown text={found().text} />
          </div>
        )}
      </Match>
      <Match when={!isServer && pdf()}>{(found) => <PdfViewer doc={props.doc} bytes={found().bytes} />}</Match>
    </Switch>
  )
}

/** A page in a frame with the sandbox and the policy `frameOf` gives it. */
function PageFrame(props: { page: Page; title: string }) {
  const frame = createMemo(() => frameOf(props.page))
  return (
    <iframe
      data-slot="drive-frame"
      name={frame().name}
      sandbox={frame().sandbox}
      title={props.title}
      srcdoc={frame().srcdoc}
    />
  )
}

// The sandbox flags a page may keep from the instance's `sandbox` directive. Never `allow-same-origin` (DynWork's
// origin, its storage and its Ipc), never the top window's navigation, never a popup that leaves the sandbox.
const flags = ["allow-scripts", "allow-forms", "allow-modals", "allow-popups", "allow-downloads", "allow-pointer-lock"]

/**
 * The frame for a page: the sandbox flags its policy's `sandbox` directive grants, out of `flags` (none without the
 * directive, so no scripts), and the page under that policy as a meta tag, first in its head, less the directives
 * only a response header can carry. Never more than the instance allowed; no policy at all is `default-src 'none'`.
 */
export function frameOf(page: Page) {
  const directives = (page.csp ?? "default-src 'none'")
    .split(";")
    .map((directive) => directive.trim())
    .filter(Boolean)
  const granted =
    directives
      .find((directive) => /^sandbox(\s|$)/i.test(directive))
      ?.split(/\s+/)
      .slice(1)
      .map((flag) => flag.toLowerCase()) ?? []
  const policy = directives
    .filter((directive) => !/^(sandbox|frame-ancestors|report-uri|report-to)(\s|$)/i.test(directive))
    .join("; ")
  const head = [
    `<meta charset="utf-8">`,
    `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, "&quot;")}">`,
    `<meta name="referrer" content="no-referrer">`,
  ].join("")
  return {
    // Main keeps a frame with this name on its srcdoc (`drive/frames.ts`).
    name: DriveFrames.name,
    sandbox: flags.filter((flag) => granted.includes(flag)).join(" "),
    srcdoc: `<!doctype html><html><head>${head}</head><body>${page.html}</body></html>`,
  }
}
