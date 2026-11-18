import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { createEffect, For, onCleanup, Show } from "solid-js"
import type { Document } from "../../drive/contract"
import { anchorCell, cellsIn, rangeOf, stem } from "./model"
import { drive } from "./store"

// How each format draws, in the view's workspace and in a chat's side panel (`compact`). The demo draws sample content;
// the real view gets Word and Markdown as the store's rendered HTML, so paper documents are HTML here too.

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** A commented quote in paper HTML: the comments layer finds it by `data-t`. */
const mark = (id: string, text: string) => `<span data-mark data-t="${id}">${text}</span>`

function report() {
  const fix = "We propose to round per tax on the total, which is what the rules require for the invoice total."
  return `<h1 id="o-1">Report: VAT rounding on credit notes</h1>
<p data-lead>Acme Retail · odoo-modules · prepared by the Dynwork agent for David Gómez</p>
<h2 id="o-2">Summary</h2>
<p>Credit notes show one-cent differences in the VAT amount against the original invoice. The cause is that ${mark("t1", "rounding is computed line by line")} instead of on the total per tax.</p>
<h2 id="o-3">Cause</h2>
<p>The company has <code>tax_calculation_rounding_method = round_per_line</code>. With many small lines, the cents add up and the credit note does not match the invoice it reverses.</p>
<table><tr><th>Invoice</th><th>Lines</th><th>Invoice VAT</th><th>Credit note VAT</th><th>Difference</th></tr>
<tr><td>INV/2026/01482</td><td>37</td><td>412.37 €</td><td>412.38 €</td><td>+0.01 €</td></tr>
<tr><td>INV/2026/01519</td><td>12</td><td>98.10 €</td><td>98.09 €</td><td>−0.01 €</td></tr>
<tr><td>INV/2026/01603</td><td>54</td><td>1,204.55 €</td><td>1,204.57 €</td><td>+0.02 €</td></tr></table>
<h2 id="o-4">Proposed fix</h2>
<p>${fix}</p>
<h2 id="o-5">Impact</h2>
<p>It affects customer invoices and vendor bills. Last quarter there were ${mark("t2", "about 140 credit notes a month")}; the change does not rewrite posted entries.</p>
<h2 id="o-6">${mark("t3", "Next steps")}</h2>
<ul><li>Change the rounding method on a staging copy.</li><li>Repeat the 3 invoices in the table and compare.</li><li>Acme's head of accounting signs it off.</li></ul>`
}

const notes = `<h1 id="o-1">Kickoff meeting notes — Acme Retail</h1>
<p data-lead><b>Date:</b> 12-11-2026 · <b>Attendees:</b> Ana Ruiz, David Gómez, the Acme team</p>
<h2 id="o-2">Agreements</h2><ul><li>Start with sales, inventory and POS.</li><li>${mark("t10", "Accounting in a second phase")}.</li></ul>
<h2 id="o-3">Tasks</h2><ul><li>☐ Acme: send the product master data (20-11)</li><li>☐ Dynapps: staging environment (22-11)</li><li>☑ Proposal revised with a training phase</li></ul>`

/** The Markdown source of the kickoff notes, for the Source view. */
export const notesSource = `# Kickoff meeting notes — Acme Retail

**Date:** 12-11-2026 · **Attendees:** Ana Ruiz, David Gómez, the Acme team

## Agreements
- Start with sales, inventory and POS.
- Accounting in a second phase.

## Tasks
- [ ] Acme: send the product master data (20-11)
- [ ] Dynapps: staging environment (22-11)
- [x] Proposal revised with a training phase`

function generic(doc: Document, path: string) {
  const title = escape(stem(doc.name))
  return `<h1 id="o-1">${title}</h1><p data-lead>${escape(path)}</p>
<h2 id="o-2">Purpose</h2><p>Sample document with the content of <b>${title}</b>. The real view draws the document with its format's viewer.</p>
<h2 id="o-3">Content</h2><p>Office lorem ipsum: agreements, owners and dates. The sections show in the outline on the left, as on the governance web.</p>
<ul><li>First agreed point.</li><li>Second point with an owner.</li><li>Third point with a date.</li></ul>
<h2 id="o-4">Appendices</h2><p>No appendices.</p>`
}

/** A paper document's HTML: what a comment marked, else its sample content. */
export function paperHtml(doc: Document, path: string) {
  return drive.state.paper[doc.id] ?? (doc.id === "d1" ? report() : doc.id === "d6" ? notes : generic(doc, path))
}

/** The outline of a paper document: its headings, as the rail lists them. */
export function outline(doc: Document) {
  if (doc.id === "d1") return ["Report: VAT rounding", "Summary", "Cause", "Proposed fix", "Impact", "Next steps"]
  if (doc.id === "d6") return ["Kickoff meeting notes", "Agreements", "Tasks"]
  return [stem(doc.name), "Purpose", "Content", "Appendices"]
}

const clause =
  "The parties agree the terms of service described in this framework contract, which governs later orders. "
const order = "Each order states its scope, dates and price, and is invoiced as set out in appendix II. "

/** The pages of an uploaded PDF, which the store keeps whole: no nodes, so comments hang on a page. */
export function pdfHtml(doc: Document) {
  return (
    drive.state.paper[doc.id] ??
    [stem(doc.name), "Clause 4 · Confidentiality"]
      .map(
        (title, page) =>
          `<div data-page="${page}"><h4>${escape(title)}</h4><p>${clause.repeat(4)}</p><p>${order.repeat(3)}</p></div>`,
      )
      .join("")
  )
}

// ── Spreadsheet ──

const analysis = [
  ["Invoice", "Customer", "Base", "Computed VAT", "Correct VAT", "Difference"],
  ["INV/2026/01482", "Acme Retail", "1,963.67", "412.38", "412.37", "0.01"],
  ["INV/2026/01519", "Acme Retail", "467.14", "98.09", "98.10", "−0.01"],
  ["INV/2026/01603", "Southern Hardware", "5,736.05", "1,204.57", "1,204.55", "0.02"],
  ["INV/2026/01650", "Acme Retail", "214.90", "45.13", "45.13", "0.00"],
  ["INV/2026/01701", "Northern Wines", "3,120.00", "655.21", "655.20", "0.01"],
  ["INV/2026/01733", "Acme Retail", "88.40", "18.56", "18.57", "−0.01"],
  ["INV/2026/01790", "Southern Hardware", "9,410.33", "1,976.17", "1,976.17", "0.00"],
  ["INV/2026/01812", "Acme Retail", "640.00", "134.41", "134.40", "0.01"],
  ["Total", "", "21,640.49", "4,544.52", "4,544.49", "0.03"],
]
const summary = [
  ["Journal", "Credit notes", "With a difference", "% affected", "Total difference"],
  ["Sales", "312", "41", "13.1 %", "0.57 €"],
  ["Purchases", "108", "9", "8.3 %", "−0.12 €"],
  ["Store POS", "1,204", "0", "0.0 %", "0.00 €"],
  ["Total", "1,624", "50", "3.1 %", "0.45 €"],
]
const plan = [
  ["Module", "Risk", "Owner", "Date"],
  ["account_custom", "High", "Ana", "02-12"],
  ["stock_extra", "Medium", "Pablo", "09-12"],
  ["pos_dynapps", "Low", "David", "16-12"],
  ["website_acme", "Medium", "Marta", "23-12"],
]
const formulas: Record<string, string> = {
  F7: "=D7-E7",
  F10: "=SUM(F2:F9)",
  D2: "=ROUND(C2*0.21;2)",
  C10: "=SUM(C2:C9)",
}

/** The sheet names of a spreadsheet. */
export const sheetsOf = (doc: Document) => (doc.id === "d2" ? ["drive.sheet.0", "drive.sheet.1"] : [stem(doc.name)])

/**
 * A spreadsheet: the formula bar, the grid and the sheet tabs. A click selects a cell, a drag or Shift+click a range;
 * `onPick` hears the selection when the button is released (or on a right click), for the comments layer.
 */
export function Sheet(props: {
  doc: Document
  compact?: boolean
  onPick?: (input: { range: string | undefined; rect: DOMRect; context: boolean }) => void
  onHover?: (cell: string | undefined, rect: DOMRect | undefined) => void
  onComment?: () => void
}) {
  const ctx = usePlugin()
  const rows = () => (props.doc.id === "d2" ? (drive.state.doc.sheet === 0 ? analysis : summary) : plan)
  const columns = () => "ABCDEF".slice(0, rows()[0].length).split("")
  const open = () =>
    drive.threadsOf(props.doc.id).filter((thread) => {
      const anchor = thread.anchor
      return (
        thread.open && (anchor.kind === "cell" || anchor.kind === "range") && anchor.sheet === drive.state.doc.sheet
      )
    })
  const marked = () => open().map((thread) => anchorCell(thread.anchor))
  const selected = () => (props.compact ? [] : cellsIn(drive.state.doc.range))
  // The range a selected thread covers, shaded.
  const covered = () => {
    const thread = open().find((item) => item.id === drive.state.doc.thread)
    return thread?.anchor.kind === "range" ? cellsIn(`${thread.anchor.from}:${thread.anchor.to}`) : []
  }
  const agentCells = () =>
    drive.state.doc.agentCells && props.doc.id === "d2" && drive.state.doc.sheet === 0
      ? ["F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9"]
      : []
  let start: string | undefined
  let grid: HTMLTableElement | undefined
  const rect = (range: string | undefined, cell: string, table: HTMLElement) => {
    const [a, b] = range ? range.split(":") : [cell, cell]
    const first = table.querySelector(`[data-cell="${a}"]`)?.getBoundingClientRect()
    const last = table.querySelector(`[data-cell="${b}"]`)?.getBoundingClientRect()
    return first && last
      ? new DOMRect(first.left, first.top, last.right - first.left, last.bottom - first.top)
      : undefined
  }
  const up = () => {
    if (!start) return
    start = undefined
    const box = grid && rect(drive.state.doc.range, drive.state.doc.cell, grid)
    if (box) props.onPick?.({ range: drive.state.doc.range, rect: box, context: false })
  }
  document.addEventListener("mouseup", up)
  onCleanup(() => document.removeEventListener("mouseup", up))

  return (
    <div data-slot="drive-sheet">
      <div data-slot="drive-formula">
        <span data-slot="drive-cell-ref">{drive.state.doc.range ?? drive.state.doc.cell}</span>
        <span data-slot="drive-fx">fx</span>
        <span data-slot="drive-formula-text">
          {props.doc.id === "d2" ? (formulas[drive.state.doc.cell] ?? "") : ""}
        </span>
        <Show when={!props.compact && props.onComment}>
          <Button variant="ghost" size="small" icon="comment" onClick={() => props.onComment?.()}>
            {ctx.t("drive.comment")}
          </Button>
        </Show>
        <Show when={!props.compact && props.doc.id === "d2"}>
          <Button variant="ghost" size="small" icon="eye" onClick={() => drive.toggleAgentCells()}>
            {ctx.t(drive.state.doc.agentCells ? "drive.sheet.hideAgent" : "drive.sheet.showAgent")}
          </Button>
        </Show>
      </div>
      <div data-slot="drive-sheet-scroll">
        <table
          ref={grid}
          data-slot="drive-sheet-grid"
          onMouseDown={(event) => {
            const cell = (event.target as HTMLElement).closest<HTMLElement>("td[data-cell]")?.dataset.cell
            if (!cell || event.button !== 0 || props.compact) return
            event.preventDefault()
            start = event.shiftKey ? drive.state.doc.cell : cell
            drive.setCells(start, rangeOf(start, cell))
          }}
          onMouseOver={(event) => {
            const td = (event.target as HTMLElement).closest<HTMLElement>("td[data-cell]")
            if (start && td?.dataset.cell) return drive.setCells(start, rangeOf(start, td.dataset.cell))
            props.onHover?.(td?.dataset.cell, td?.getBoundingClientRect())
          }}
          onMouseLeave={() => props.onHover?.(undefined, undefined)}
          onContextMenu={(event) => {
            const td = (event.target as HTMLElement).closest<HTMLElement>("td[data-cell]")
            const cell = td?.dataset.cell
            if (!cell || !props.onPick) return
            event.preventDefault()
            if (!(drive.state.doc.range ? cellsIn(drive.state.doc.range) : [drive.state.doc.cell]).includes(cell))
              drive.setCells(cell, undefined)
            const table = event.currentTarget
            const box = rect(drive.state.doc.range, drive.state.doc.cell, table)
            if (box) props.onPick({ range: drive.state.doc.range, rect: box, context: true })
          }}
        >
          <thead>
            <tr>
              <th />
              <For each={columns()}>{(column) => <th>{column}</th>}</For>
            </tr>
          </thead>
          <tbody>
            <For each={rows()}>
              {(row, r) => (
                <tr>
                  <th>{r() + 1}</th>
                  <For each={row}>
                    {(value, c) => {
                      const ref = () => columns()[c()] + (r() + 1)
                      return (
                        <td
                          data-cell={ref()}
                          data-head={r() === 0 ? "" : undefined}
                          data-total={r() === rows().length - 1 ? "" : undefined}
                          data-number={c() >= 2 && r() > 0 ? "" : undefined}
                          data-negative={value.startsWith("−") ? "" : undefined}
                          data-selected={!props.compact && ref() === drive.state.doc.cell ? "" : undefined}
                          data-in-range={selected().includes(ref()) ? "" : undefined}
                          data-covered={covered().includes(ref()) ? "" : undefined}
                          data-commented={marked().includes(ref()) ? "" : undefined}
                          data-agent={agentCells().includes(ref()) ? "" : undefined}
                        >
                          {value}
                        </td>
                      )
                    }}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <div data-slot="drive-sheet-tabs">
        <For each={sheetsOf(props.doc)}>
          {(name, index) => (
            <button
              type="button"
              data-state={drive.state.doc.sheet === index() ? "pressed" : undefined}
              onClick={() => drive.setSheet(index())}
            >
              {name.startsWith("drive.") ? ctx.t(name) : name}
            </button>
          )}
        </For>
        <span data-slot="drive-grow" />
        <span data-slot="drive-faint">{ctx.t("drive.sheet.engine")}</span>
      </div>
    </div>
  )
}

// ── Presentation ──

interface Slide {
  readonly dark?: boolean
  readonly title: string
  readonly text?: string
  readonly items?: readonly string[]
  readonly kpis?: readonly (readonly [string, string])[]
}

const proposalSlides: readonly Slide[] = [
  { dark: true, title: "Acme Retail proposal 2027", text: "Odoo 19 for 42 stores, a central warehouse and e-commerce" },
  {
    title: "Where Acme is today",
    items: [
      "Three systems, not integrated",
      "Inventory reconciled by hand every week",
      "POS not connected to accounting",
    ],
  },
  {
    title: "Proposal",
    items: [
      "Phase 1 · Sales, inventory and POS",
      "Phase 2 · Accounting and SII",
      "Phase 3 · E-commerce",
      "Phase 4 · Training (2 weeks)",
    ],
  },
  {
    title: "What we gain",
    kpis: [
      ["−70 %", "manual reconciliation"],
      ["1 day", "month-end close"],
      ["42", "stores in real time"],
    ],
  },
  { dark: true, title: "Next steps", text: "Kickoff 12-11 · staging 22-11 · pilot in 3 stores in January" },
]

/** A presentation's slides: the proposal deck, or three generic slides titled after the document. */
export const slidesOf = (doc: Document) =>
  doc.id === "d4"
    ? proposalSlides
    : proposalSlides.slice(0, 3).map((slide, index) => (index === 0 ? { ...slide, title: stem(doc.name) } : slide))

/** One slide. Each title, point and figure has `data-node`, the node a comment anchors to. */
export function SlideView(props: { slide: Slide; index: number }) {
  const node = (name: string) => `s${props.index}.${name}`
  return (
    <div data-slot="drive-slide" data-dark={props.slide.dark ? "" : undefined}>
      <div data-slot="drive-slide-in">
        <h3 data-node={node("title")}>{props.slide.title}</h3>
        <div data-slot="drive-slide-bar" />
        <Show when={props.slide.text}>
          <p data-node={node("p")}>{props.slide.text}</p>
        </Show>
        <Show when={props.slide.items}>
          <ul>
            <For each={props.slide.items}>
              {(item, index) => (
                <li data-node={node(`li${index()}`)} data-new={props.index === 2 && index() === 3 ? "" : undefined}>
                  {item}
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={props.slide.kpis}>
          <div data-slot="drive-kpis">
            <For each={props.slide.kpis}>
              {(kpi, index) => (
                <div data-node={node(`kpi${index()}`)}>
                  <b>{kpi[0]}</b>
                  {kpi[1]}
                </div>
              )}
            </For>
          </div>
        </Show>
        <div data-slot="drive-slide-foot">Dynapps · Acme Retail</div>
      </div>
    </div>
  )
}

/** A presentation: the filmstrip with each slide's comment count, and the selected slide on the stage. */
export function Deck(props: { doc: Document; compact?: boolean }) {
  const slides = () => slidesOf(props.doc)
  const count = (index: number) =>
    drive
      .threadsOf(props.doc.id)
      .filter((thread) => thread.open && thread.anchor.kind === "shape" && thread.anchor.slide === index).length
  return (
    <div data-slot="drive-deck" data-compact={props.compact ? "" : undefined}>
      <div data-slot="drive-film">
        <For each={slides()}>
          {(slide, index) => (
            <button
              type="button"
              data-state={drive.state.doc.slide === index() ? "pressed" : undefined}
              onClick={() => drive.setSlide(index())}
            >
              <span>{index() + 1}</span>
              <div data-slot="drive-film-mini">
                <SlideView slide={slide} index={index()} />
                <Show when={count(index()) > 0}>
                  <span data-slot="drive-film-count">{count(index())}</span>
                </Show>
              </div>
            </button>
          )}
        </For>
      </div>
      <div data-slot="drive-stage">
        <Show when={slides()[drive.state.doc.slide] ?? slides()[0]}>
          {(slide) => <SlideView slide={slide()} index={Math.min(drive.state.doc.slide, slides().length - 1)} />}
        </Show>
      </div>
    </div>
  )
}

// ── HTML page ──

// The page runs in an iframe with an opaque origin (`sandbox="allow-scripts"`) and a CSP that allows no network: its
// own scripts work, it reaches nothing. The script below is the Drive's only way in: it finds the elements comments
// quote and reports their boxes, and in comment mode outlines the element under the cursor and reports the one clicked.
const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">`

const dashboard = `<!doctype html><html><head><meta charset="utf-8">${csp}<style>
body{margin:0;font:14px system-ui,sans-serif;color:#151433;background:#f6f6fb}header{padding:18px 22px;background:#050543;color:#fff}
header h1{margin:0;font-size:18px}header p{margin:4px 0 0;opacity:.7;font-size:12px}main{padding:18px 22px;display:grid;gap:14px}
.k{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.k div{background:#fff;border-radius:10px;padding:12px;box-shadow:0 1px 2px #0001}
.k b{display:block;font-size:22px;color:#7b00dc}.card{background:#fff;border-radius:10px;padding:14px;box-shadow:0 1px 2px #0001}
.tabs{display:flex;gap:6px;margin-bottom:10px}.tabs button{border:0;border-radius:999px;padding:4px 10px;background:#ececf5;cursor:pointer;font:inherit;font-size:12px}
.tabs button.on{background:#050543;color:#fff}.bars{display:flex;align-items:flex-end;gap:14px;height:150px;padding:0 6px;border-bottom:1px solid #ddd}
.bars div{flex:1;background:linear-gradient(#7b00dc,#f13c42);border-radius:6px 6px 0 0;position:relative;transition:height .3s}
.bars span{position:absolute;top:-18px;left:0;right:0;text-align:center;font-size:11px}.lbl{display:flex;gap:14px;padding:6px 6px 0;font-size:11px;color:#666}.lbl div{flex:1;text-align:center}
</style></head><body><header><h1>Credit note VAT by journal</h1><p>Made by the agent · data from the spreadsheet “Credit note analysis” · rev 5</p></header>
<main><div class="k"><div><b>1,624</b>credit notes</div><div><b>50</b> with a difference</div><div><b>3 %</b>affected</div></div>
<div class="card"><div class="tabs"><button class="on" data-q="t3">Q3 2026</button><button data-q="t4">Q4 2026</button></div>
<div class="bars" id="b"></div><div class="lbl"><div>Sales</div><div>Purchases</div><div>POS</div></div></div>
<div class="card" style="font-size:12px;color:#555">Click the quarters: this page runs its own script inside the isolated frame, with no network access.</div></main>
<script>const D={t3:[41,9,0],t4:[27,6,1]};const b=document.getElementById('b');function draw(q){b.innerHTML=D[q].map(v=>'<div style="height:'+(v*3+4)+'px"><span>'+v+'</span></div>').join('')}
document.querySelectorAll('[data-q]').forEach(x=>x.onclick=()=>{document.querySelectorAll('[data-q]').forEach(y=>y.classList.remove('on'));x.classList.add('on');draw(x.dataset.q)});draw('t3')</script></body></html>`

const landing = `<!doctype html><html><head><meta charset="utf-8">${csp}<style>body{margin:0;font:15px system-ui;background:linear-gradient(135deg,#050543,#4a1690);color:#fff;min-height:100vh;display:grid;place-items:center;text-align:center}h1{font-size:30px;margin:0 0 8px}a{display:inline-block;margin-top:14px;background:#ff911f;color:#050543;padding:8px 16px;border-radius:999px;text-decoration:none;font-weight:600}</style></head>
<body><div><h1>Odoo Experience 2026</h1><p>Visit the Dynapps booth</p><a href="#">Sign up</a></div></body></html>`

function frameScript(commenting: boolean) {
  return `<script>(function(){var CM=${commenting};var n=function(s){return (s||'').replace(/\\s+/g,' ').trim()};
var st=document.createElement('style');st.textContent='.__a{box-shadow:0 0 0 2px rgba(240,180,0,.9)!important;border-radius:6px}.__on{background:rgba(255,196,0,.22)!important}'+(CM?'*{cursor:crosshair!important}.__h{outline:2px dashed #f0b400!important;outline-offset:3px}':'');document.head.appendChild(st);
var A=[];function send(){parent.postMessage({dw:'rects',list:A.map(function(a){var r=a.el.getBoundingClientRect();return{id:a.id,x:r.left,y:r.top,w:r.width,h:r.height}})},'*')}
function find(f){var all=[].slice.call(document.body.querySelectorAll('*')).filter(function(e){return n(e.innerText).indexOf(f)>=0});return all.filter(function(e){return ![].slice.call(e.children).some(function(c){return n(c.innerText).indexOf(f)>=0})})[0]}
window.addEventListener('message',function(e){if(!e.data||e.data.dw!=='anchors')return;[].slice.call(document.querySelectorAll('.__a')).forEach(function(x){x.classList.remove('__a','__on')});A=e.data.list.map(function(a){var el=find(a.find);if(el){el.classList.add('__a');if(a.on)el.classList.add('__on')}return{id:a.id,el:el}}).filter(function(a){return a.el});send()});
addEventListener('scroll',send);addEventListener('resize',send);
function pick(t){while(t&&/^(B|STRONG|I|EM|SPAN|SMALL)$/.test(t.tagName)&&t.parentElement)t=t.parentElement;return t===document.body||t===document.documentElement?null:t}
if(CM){var last;document.addEventListener('mouseover',function(e){if(last)last.classList.remove('__h');last=pick(e.target);if(last)last.classList.add('__h')});
document.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();var t=pick(e.target);if(!t)return;var r=t.getBoundingClientRect();parent.postMessage({dw:'pick',text:n(t.innerText).slice(0,60),x:r.left,y:r.top,w:r.width,h:r.height},'*')},true)}
parent.postMessage({dw:'ready'},'*')})()</script>`
}

/** A message from the page's script. */
export type FrameMessage =
  | { readonly dw: "ready" }
  | { readonly dw: "rects"; readonly list: readonly { id: string; x: number; y: number; w: number; h: number }[] }
  | {
      readonly dw: "pick"
      readonly text: string
      readonly x: number
      readonly y: number
      readonly w: number
      readonly h: number
    }

/**
 * An HTML artifact in a sandboxed iframe. `anchors` are the quotes its open comments point at; the page answers with
 * their boxes, and in comment mode with the element clicked.
 */
export function HtmlFrame(props: {
  doc: Document
  commenting?: boolean
  anchors?: () => readonly { id: string; find: string; on: boolean }[]
  onMessage?: (message: FrameMessage, frame: HTMLIFrameElement) => void
}) {
  const ctx = usePlugin()
  let frame: HTMLIFrameElement | undefined
  const page = () =>
    (props.doc.id === "d3" ? dashboard : landing).replace("</body>", `${frameScript(!!props.commenting)}</body>`)
  const send = () => frame?.contentWindow?.postMessage({ dw: "anchors", list: props.anchors?.() ?? [] }, "*")
  const listen = (event: MessageEvent) => {
    if (!frame || event.source !== frame.contentWindow || !event.data?.dw) return
    if (event.data.dw === "ready") send()
    props.onMessage?.(event.data as FrameMessage, frame)
  }
  window.addEventListener("message", listen)
  onCleanup(() => window.removeEventListener("message", listen))
  // A comment added or selected marks the page again.
  createEffect(() => {
    props.anchors?.()
    send()
  })
  return (
    <div data-slot="drive-frame">
      <div data-slot="drive-frame-note">
        <Icon name="lock" size="small" />
        <span>{ctx.t("drive.html.isolated")}</span>
        <span data-slot="drive-decision">D5</span>
      </div>
      <div data-slot="drive-frame-stage">
        <iframe ref={frame} title={props.doc.name} sandbox="allow-scripts" srcdoc={page()} />
      </div>
    </div>
  )
}
