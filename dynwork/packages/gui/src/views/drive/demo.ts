// The Drive view's built-in sample data. Everything is fictional except the shapes, which follow the governance
// document store: formats, folders with an owner and a class, access levels, revisions, comments anchored to a node and
// a quote, proposals, and the conversations an artifact came from. Ages are minutes before now.

export type Format = "docx" | "xlsx" | "pptx" | "html" | "markdown" | "pdf"
export type Level = "own" | "share" | "edit" | "comment" | "view"
export type DocClass = "agent-workspace" | "internal" | "confidential" | "restricted"
/** What a conversation did to a document. */
export type Act = "created" | "edited" | "proposed" | "attached" | "read"

export interface Person {
  readonly id: string
  readonly name: string
  readonly initials: string
  readonly color: string
  readonly email: string
  readonly me?: boolean
  readonly agent?: boolean
}

export interface Folder {
  readonly id: string
  readonly name: string
  readonly parent?: string
  readonly cls: DocClass
  readonly owner: string
  readonly shared?: boolean
  readonly age: number
}

export interface Chat {
  readonly id: string
  readonly name: string
  readonly project: string
  readonly color: string
  readonly letter: string
}

export interface ChatLink {
  readonly chat: string
  readonly act: Act
  readonly rev: number
}

export interface Doc {
  readonly id: string
  readonly name: string
  readonly format: Format
  readonly folder?: string
  readonly owner: string
  readonly cls: DocClass
  readonly age: number
  readonly rev: number
  readonly size: string
  /** Who has it open right now; "AI" is an agent. */
  readonly editing: readonly string[]
  /** An agent created it. */
  readonly agent: boolean
  /** The user's own access. */
  readonly access: Level
  readonly chats: readonly ChatLink[]
  /** Words of its content, for the search. */
  readonly text: string
}

/**
 * What a comment points at. The governance store anchors to a node (a paragraph, a cell, a shape's paragraph) and an
 * optional quote inside it; `range` and `page` have no node yet and need a change in the store.
 */
export type Anchor =
  | { readonly kind: "text" }
  | { readonly kind: "block" }
  | { readonly kind: "cell"; readonly sheet: number; readonly cell: string }
  | { readonly kind: "range"; readonly sheet: number; readonly from: string; readonly to: string }
  | { readonly kind: "shape"; readonly slide: number; readonly node: string }
  | { readonly kind: "element"; readonly find: string }
  | { readonly kind: "page"; readonly page: number; readonly x: number; readonly y: number }

export interface Message {
  readonly by: string
  readonly text: string
  readonly age: number
  /** The conversation the agent answered from. */
  readonly via?: string
  /** Written from Dynwork, which the store counts as an agent until people sign in as themselves. */
  readonly dynwork?: boolean
}

export interface Thread {
  readonly id: string
  readonly quote: string
  readonly anchor: Anchor
  readonly open: boolean
  readonly messages: readonly Message[]
}

export interface Proposal {
  readonly id: string
  readonly by: string
  readonly via: string
  readonly age: number
  readonly title: string
  readonly before: string
  readonly after: string
  readonly state: "open" | "accepted" | "rejected"
}

export interface Version {
  readonly rev: number
  readonly by: string
  /** A conversation id, or where a person saved it. */
  readonly via: string
  readonly what: string
  readonly age: number
  readonly proposal?: boolean
}

export interface Share {
  readonly person: string
  readonly level: Level
}

export const me = "D"

export const people: Record<string, Person> = {
  D: { id: "D", name: "David Gómez", initials: "DG", color: "#01007c", email: "david@dynapps.es", me: true },
  A: { id: "A", name: "Ana Ruiz", initials: "AR", color: "#d4561e", email: "ana.ruiz@dynapps.es" },
  M: { id: "M", name: "Marta López", initials: "ML", color: "#2b5fd9", email: "marta.lopez@dynapps.es" },
  S: { id: "S", name: "Pablo Serrano", initials: "PS", color: "#1e8a4c", email: "pablo.serrano@dynapps.es" },
  AI: { id: "AI", name: "Agent", initials: "AI", color: "", email: "", agent: true },
}

export const classes: readonly DocClass[] = ["agent-workspace", "internal", "confidential", "restricted"]
export const levels: readonly Level[] = ["own", "share", "edit", "comment", "view"]

export const formats: Record<Format, { readonly glyph: string; readonly ext: string }> = {
  docx: { glyph: "W", ext: "docx" },
  xlsx: { glyph: "X", ext: "xlsx" },
  pptx: { glyph: "P", ext: "pptx" },
  html: { glyph: "</>", ext: "html" },
  markdown: { glyph: "M↓", ext: "md" },
  pdf: { glyph: "PDF", ext: "pdf" },
}

export const folders: readonly Folder[] = [
  { id: "art", name: "Artifacts", cls: "agent-workspace", owner: "D", age: 4 },
  { id: "art-odoo", name: "odoo-modules", parent: "art", cls: "agent-workspace", owner: "D", age: 4 },
  { id: "art-acme", name: "acme-retail", parent: "art", cls: "agent-workspace", owner: "D", age: 1400 },
  { id: "art-mig", name: "dyncloud-manager", parent: "art", cls: "agent-workspace", owner: "D", age: 4000 },
  { id: "cli", name: "Customers", cls: "internal", owner: "A", shared: true, age: 120 },
  { id: "acme", name: "Acme Retail", parent: "cli", cls: "internal", owner: "A", shared: true, age: 120 },
  { id: "int", name: "Internal", cls: "internal", owner: "D", age: 1500 },
  { id: "dir", name: "Management", cls: "confidential", owner: "M", shared: true, age: 4400 },
]

export const chats: Record<string, Chat> = {
  c1: { id: "c1", name: "Fix VAT rounding", project: "odoo-modules", color: "#d4561e", letter: "O" },
  c2: { id: "c2", name: "Acme sales proposal", project: "acme-retail", color: "#2b5fd9", letter: "A" },
  c3: { id: "c3", name: "Migration plan to 18.0", project: "dyncloud-manager", color: "#0f8a8a", letter: "D" },
}

export const docs: readonly Doc[] = [
  {
    id: "d3",
    name: "VAT dashboard by journal.html",
    format: "html",
    folder: "art-odoo",
    owner: "D",
    cls: "agent-workspace",
    age: 4,
    rev: 5,
    size: "38 KB",
    editing: [],
    agent: true,
    access: "own",
    chats: [
      { chat: "c1", act: "created", rev: 1 },
      { chat: "c1", act: "edited", rev: 5 },
    ],
    text: "dashboard vat journal sales purchases credit notes difference rounding chart",
  },
  {
    id: "d1",
    name: "VAT rounding report.docx",
    format: "docx",
    folder: "art-odoo",
    owner: "D",
    cls: "agent-workspace",
    age: 8,
    rev: 4,
    size: "64 KB",
    editing: ["A", "AI"],
    agent: true,
    access: "own",
    chats: [
      { chat: "c1", act: "created", rev: 1 },
      { chat: "c1", act: "proposed", rev: 4 },
    ],
    text: "report vat rounding credit notes cause per line total round_globally tax_calculation_rounding_method proposal impact",
  },
  {
    id: "d2",
    name: "Credit note analysis.xlsx",
    format: "xlsx",
    folder: "art-odoo",
    owner: "D",
    cls: "agent-workspace",
    age: 12,
    rev: 3,
    size: "22 KB",
    editing: [],
    agent: true,
    access: "own",
    chats: [
      { chat: "c1", act: "created", rev: 1 },
      { chat: "c1", act: "edited", rev: 3 },
    ],
    text: "analysis credit notes base computed vat correct vat difference customer invoice",
  },
  {
    id: "d4",
    name: "Acme proposal 2027.pptx",
    format: "pptx",
    folder: "acme",
    owner: "A",
    cls: "internal",
    age: 120,
    rev: 7,
    size: "2.1 MB",
    editing: ["A"],
    agent: false,
    access: "edit",
    chats: [
      { chat: "c2", act: "attached", rev: 6 },
      { chat: "c2", act: "edited", rev: 7 },
    ],
    text: "proposal acme retail 2027 odoo 19 stores warehouse pos kpis next steps investment",
  },
  {
    id: "d5",
    name: "Acme project scope.docx",
    format: "docx",
    folder: "acme",
    owner: "D",
    cls: "internal",
    age: 125,
    rev: 2,
    size: "41 KB",
    editing: [],
    agent: true,
    access: "own",
    chats: [{ chat: "c2", act: "created", rev: 1 }],
    text: "scope project acme modules sales inventory pos accounting out of scope assumptions",
  },
  {
    id: "d6",
    name: "Kickoff meeting notes.md",
    format: "markdown",
    folder: "art-acme",
    owner: "D",
    cls: "agent-workspace",
    age: 1400,
    rev: 1,
    size: "3 KB",
    editing: [],
    agent: true,
    access: "own",
    chats: [{ chat: "c2", act: "created", rev: 1 }],
    text: "notes kickoff meeting acme attendees agreements tasks dates",
  },
  {
    id: "d7",
    name: "Migration plan 18.0.xlsx",
    format: "xlsx",
    folder: "art-mig",
    owner: "D",
    cls: "agent-workspace",
    age: 4000,
    rev: 2,
    size: "30 KB",
    editing: [],
    agent: true,
    access: "own",
    chats: [{ chat: "c3", act: "created", rev: 1 }],
    text: "migration plan 18.0 modules risks dates owners",
  },
  {
    id: "d8",
    name: "Acme framework contract.pdf",
    format: "pdf",
    folder: "acme",
    owner: "A",
    cls: "internal",
    age: 7200,
    rev: 1,
    size: "860 KB",
    editing: [],
    agent: false,
    access: "comment",
    chats: [{ chat: "c2", act: "read", rev: 1 }],
    text: "framework contract acme clauses confidentiality term invoicing",
  },
  {
    id: "d9",
    name: "Holiday policy 2027.docx",
    format: "docx",
    folder: "dir",
    owner: "M",
    cls: "confidential",
    age: 4400,
    rev: 9,
    size: "52 KB",
    editing: [],
    agent: false,
    access: "view",
    chats: [],
    text: "holiday policy 2027 days request approval",
  },
  {
    id: "d10",
    name: "Dynapps style guide.docx",
    format: "docx",
    folder: "int",
    owner: "D",
    cls: "internal",
    age: 1500,
    rev: 12,
    size: "1.4 MB",
    editing: [],
    agent: false,
    access: "own",
    chats: [],
    text: "style guide dynapps tone voice colors typography readex",
  },
  {
    id: "d11",
    name: "IT budget 2027.xlsx",
    format: "xlsx",
    folder: "dir",
    owner: "M",
    cls: "confidential",
    age: 4300,
    rev: 4,
    size: "48 KB",
    editing: [],
    agent: false,
    access: "comment",
    chats: [],
    text: "budget it 2027 licences hardware cloud",
  },
  {
    id: "d12",
    name: "Odoo Experience event landing.html",
    format: "html",
    folder: "int",
    owner: "S",
    cls: "internal",
    age: 60,
    rev: 6,
    size: "26 KB",
    editing: ["S"],
    agent: false,
    access: "edit",
    chats: [],
    text: "landing event odoo experience booth sign up",
  },
  {
    id: "d13",
    name: "Project start checklist.md",
    format: "markdown",
    owner: "D",
    cls: "internal",
    age: 8000,
    rev: 3,
    size: "2 KB",
    editing: [],
    agent: false,
    access: "own",
    chats: [],
    text: "checklist project start access environments",
  },
]

export const threads: Record<string, readonly Thread[]> = {
  d1: [
    {
      id: "t1",
      quote: "rounding is computed line by line",
      anchor: { kind: "text" },
      open: true,
      messages: [
        { by: "A", text: "Does this also apply to vendor bills, or only to customer invoices?", age: 35 },
        {
          by: "AI",
          text: "Both: the rounding method belongs to the company. I clarified it in the Impact section (rev 3).",
          age: 30,
          via: "c1",
        },
      ],
    },
    {
      id: "t2",
      quote: "about 140 credit notes a month",
      anchor: { kind: "text" },
      open: true,
      messages: [
        { by: "A", text: "@Agent can you put the exact figure for last quarter and link the spreadsheet?", age: 10 },
      ],
    },
    {
      id: "t3",
      quote: "Next steps",
      anchor: { kind: "text" },
      open: false,
      messages: [
        { by: "D", text: "Add who signs it off at the customer.", age: 60 },
        { by: "AI", text: "Added: Acme's head of accounting signs it off.", age: 55, via: "c1" },
      ],
    },
  ],
  d2: [
    {
      id: "t4",
      quote: "−0.01",
      anchor: { kind: "cell", sheet: 0, cell: "F7" },
      open: true,
      messages: [{ by: "D", text: "This difference is positive in the ERP, check the sign.", age: 15 }],
    },
    {
      id: "t6",
      quote: "Computed VAT · Correct VAT",
      anchor: { kind: "range", sheet: 0, from: "D2", to: "E9" },
      open: true,
      messages: [
        {
          by: "A",
          text: "Do these two columns come from the same Odoo export? Note where each one comes from.",
          age: 25,
        },
      ],
    },
  ],
  d4: [
    {
      id: "t5",
      quote: "Phase 4 · Training (2 weeks)",
      anchor: { kind: "shape", slide: 2, node: "s2.li3" },
      open: true,
      messages: [
        { by: "A", text: "The training phase is missing. @Agent add it with 2 weeks.", age: 120 },
        { by: "AI", text: "Added as phase 4 (rev 7).", age: 118, via: "c2" },
      ],
    },
    {
      id: "t7",
      quote: "1 day month-end close",
      anchor: { kind: "shape", slide: 3, node: "s3.kpi1" },
      open: true,
      messages: [{ by: "M", text: "Is 1 day realistic in the first quarter? I'd say “2 days” at first.", age: 60 }],
    },
  ],
  d6: [
    {
      id: "t10",
      quote: "Accounting in a second phase",
      anchor: { kind: "text" },
      open: true,
      messages: [{ by: "A", text: "Shall we date the second phase? Acme asked about March.", age: 1400 }],
    },
  ],
  d8: [
    {
      id: "t9",
      quote: "Clause 4 · Confidentiality",
      anchor: { kind: "page", page: 1, x: 74, y: 7 },
      open: true,
      messages: [
        { by: "A", text: "Check with legal before signing: it does not mention Acme's customer data.", age: 7200 },
      ],
    },
  ],
  d3: [
    {
      id: "t8",
      quote: "50 with a difference",
      anchor: { kind: "element", find: "50 with a difference" },
      open: true,
      messages: [{ by: "S", text: "Can you put the percentage next to the number?", age: 3 }],
    },
  ],
}

export const proposals: Record<string, readonly Proposal[]> = {
  d1: [
    {
      id: "p1",
      by: "AI",
      via: "c1",
      age: 8,
      title: "Fix: global rounding in the proposal",
      before: "round each line to two decimals before adding up",
      after: "add up the bases per tax and round once (round_globally)",
      state: "open",
    },
  ],
}

export const versions: Record<string, readonly Version[]> = {
  d1: [
    { rev: 4, by: "AI", via: "c1", what: "Pending proposal: fix with global rounding", age: 8, proposal: true },
    { rev: 3, by: "AI", via: "c1", what: "Clarifies vendor bills in Impact (answer to a comment)", age: 30 },
    { rev: 2, by: "A", via: "web", what: "Summary wording", age: 40 },
    { rev: 1, by: "AI", via: "c1", what: "Created with artifact_create", age: 60 },
  ],
  d3: [
    { rev: 5, by: "AI", via: "c1", what: "Chart by journal, no decimals", age: 4 },
    { rev: 4, by: "AI", via: "c1", what: "Quarter filter", age: 20 },
    { rev: 3, by: "D", via: "web", what: "Title changed in Governance", age: 35 },
    { rev: 2, by: "AI", via: "c1", what: "KPI cards", age: 50 },
    { rev: 1, by: "AI", via: "c1", what: "Created with artifact_create", age: 60 },
  ],
  d2: [
    { rev: 3, by: "AI", via: "c1", what: "“Summary by journal” sheet", age: 12 },
    { rev: 2, by: "AI", via: "c1", what: "Difference column", age: 45 },
    { rev: 1, by: "AI", via: "c1", what: "Created from the Dynapps Sheet template", age: 60 },
  ],
  d4: [
    { rev: 7, by: "AI", via: "c2", what: "Training phase on slide 3", age: 120 },
    { rev: 6, by: "A", via: "web", what: "New cover", age: 180 },
    { rev: 5, by: "A", via: "drive", what: "Uploaded from the Drive folder on her Mac", age: 1500 },
  ],
}

export const shares: Record<string, readonly Share[]> = {
  d1: [
    { person: "D", level: "own" },
    { person: "A", level: "edit" },
  ],
  d2: [{ person: "D", level: "own" }],
  d3: [
    { person: "D", level: "own" },
    { person: "A", level: "view" },
  ],
  d4: [
    { person: "A", level: "own" },
    { person: "D", level: "edit" },
    { person: "S", level: "comment" },
  ],
}

/** One change a conversation made to a document, as its card shows: the act, the revision, and the one before. */
export interface Change {
  readonly doc: string
  readonly act: Act
  readonly rev: number
  readonly from?: number
}

/** What the sample conversation "Fix VAT rounding" made, in order: the side panel loads it into a chat. */
export const sampleChanges: readonly Change[] = [
  { doc: "d2", act: "created", rev: 1 },
  { doc: "d1", act: "created", rev: 1 },
  { doc: "d3", act: "created", rev: 1 },
  { doc: "d3", act: "edited", rev: 5, from: 4 },
  { doc: "d1", act: "proposed", rev: 4 },
]
