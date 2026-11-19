// A document's outline: its headings, for the index the Drive view shows at the left of a document, as Governance does.
// - Markdown from its source, the way the timeline's renderer reads headings: ATX and setext, none inside a fence.
// - A page (HTML, or a Word document as the Drive previews it) from its markup, read with the window's `DOMParser`,
//   whose document is inert: nothing in it runs or loads. Each heading without an id gets one there, which is what a
//   jump in the sandboxed frame navigates to (`#id`, a same-document navigation main's frame guard lets through).

/** A heading of the outline. `id` is the element's id in a page; none for Markdown, which is found by its text. */
export interface Heading {
  readonly level: number
  readonly text: string
  readonly id?: string
}

/** The headings of a Markdown source, in reading order. */
export function markdownHeadings(source: string): Heading[] {
  const lines = source.split(/\r?\n/)
  const fence = { open: undefined as string | undefined }
  return lines.flatMap((line, index) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence.open) {
      if (
        marker &&
        marker[0] === fence.open[0] &&
        marker.length >= fence.open.length &&
        !/\S/.test(line.trim().slice(marker.length))
      )
        fence.open = undefined
      return []
    }
    if (marker) {
      fence.open = marker
      return []
    }
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line)
    if (atx) return named(atx[1].length, atx[2] ?? "")
    const next = lines[index + 1]
    const underline = next === undefined ? undefined : /^ {0,3}(=+|-+)[ \t]*$/.exec(next)?.[1]
    if (underline && paragraph(line) && !paragraph(lines[index - 1] ?? ""))
      return named(underline[0] === "=" ? 1 : 2, line)
    return []
  })
}

/**
 * A page's headings, and the page with an id on each heading that had none, unique in the page. The page comes back as
 * a whole document, so the caller can put its own tags first in its head.
 */
export function anchorPage(html: string) {
  const page = new DOMParser().parseFromString(html, "text/html")
  const taken = new Set([...page.querySelectorAll("[id]")].map((element) => element.id))
  const headings = [...page.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")].flatMap((element): Heading[] => {
    const text = clean(textOf(element))
    if (!text) return []
    if (!element.id) {
      element.id = unique(slug(text), taken)
      taken.add(element.id)
    }
    return [{ level: Number(element.tagName[1]), text, id: element.id }]
  })
  return { page, headings }
}

/**
 * The element of a rendered Markdown document that shows `headings[index]`: the same occurrence of its text among the
 * rendered headings, else the heading at that place.
 */
export function renderedHeading<T>(
  elements: readonly { text: string; element: T }[],
  headings: readonly Heading[],
  index: number,
) {
  const wanted = headings[index]
  if (!wanted) return undefined
  const occurrence = headings.slice(0, index).filter((heading) => heading.text === wanted.text).length
  const same = elements.filter((item) => clean(item.text) === wanted.text)
  return (same[occurrence] ?? elements[index])?.element
}

/** A heading's text as it reads: inline Markdown marks dropped, spaces collapsed. */
function named(level: number, text: string): Heading[] {
  const plain = clean(
    text
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/(\*\*|__|\*|_|~~)(?=\S)(.+?)(?<=\S)\1/g, "$2"),
  )
  return plain ? [{ level, text: plain }] : []
}

/** Whether a line can be a setext heading's text: a paragraph's, not a list item, quote, table row or code. */
function paragraph(line: string) {
  return /\S/.test(line) && !/^ {4}|^\s*([-*+]\s|\d+[.)]\s|>|#|\|)|^ {0,3}(=+|-+|\*+|_+)[ \t]*$/.test(line)
}

/** A node's text, with each line break read as a space, as the page shows it. */
function textOf(node: Node): string {
  if (node.nodeName === "BR") return " "
  if (node.nodeType === node.TEXT_NODE) return node.textContent ?? ""
  return [...node.childNodes].map(textOf).join("")
}

const clean = (text: string) => text.replace(/\s+/g, " ").trim()

/** `base`, or the first `base-2`, `base-3`… the page does not use yet: one of as many as it has ids is free. */
function unique(base: string, taken: ReadonlySet<string>) {
  if (!taken.has(base)) return base
  return Array.from({ length: taken.size }, (_, n) => `${base}-${n + 2}`).find((id) => !taken.has(id)) ?? base
}

/** An id from a heading's text: lower case, letters and digits joined by dashes, no accents. */
function slug(text: string) {
  const base = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
  return base || "heading"
}
