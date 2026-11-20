import { createRoot } from "solid-js"
import type { Backend } from "../../../src/drive/backend"
import type { DriveCapabilities } from "../../../src/drive/capabilities"
import type { Document, Folder } from "../../../src/drive/contract"
import { DriveFake } from "../../../src/drive/fake"
import { DriveIpc } from "../../../src/drive/ipc"
import { createDriveStore } from "../../../src/views/drive/store"
import { storage } from "../../routines/fixture"
import { connect, manualTimers } from "../../drive/wire"

// The Drive view over the real `dynwork.drive` service and an in-memory Drive, seeded with a small sample: the user's
// own folders and files, and a customer folder and a contract someone else shares with them. Every call crosses the
// Ipc's schemas as a window's would.

export const account = { id: "account-david", user: "david@dynapps.es" }
export const chat = { id: "ses_vat", name: "Fix VAT rounding" }
const text = (value: string) => new TextEncoder().encode(value)

/** The sample, by name: folders by their path, documents by their folder's path (none at the root). */
const folders = [
  "Artifacts",
  "Artifacts/odoo-modules",
  "Artifacts/acme-retail",
  "Internal",
  "Customers",
  "Customers/Acme Retail",
]
const documents = [
  { name: "Project start checklist.md", mime: "text/markdown" },
  { name: "VAT rounding report.docx", folder: "Artifacts/odoo-modules" },
  { name: "Credit note analysis.xlsx", folder: "Artifacts/odoo-modules" },
  { name: "VAT dashboard by journal.html", folder: "Artifacts/odoo-modules", mime: "text/html" },
  { name: "Acme proposal 2027.pptx", folder: "Artifacts/acme-retail" },
  { name: "Kickoff meeting notes.md", folder: "Customers/Acme Retail", mime: "text/markdown" },
  { name: "Framework contract.pdf", mime: "application/pdf" },
]
/** What someone else owns and shares with the user. */
const others = ["Customers", "Customers/Acme Retail", "Kickoff meeting notes.md", "Framework contract.pdf"]

export interface Options {
  capabilities?: Partial<DriveCapabilities.Capabilities>
  /** Wraps the seeded backend, to delay or break a call. */
  backend?: (backend: Backend) => Backend
  /** No connection to main: the store's client is undefined. */
  disconnected?: boolean
  /** Called when the service pushes a new state to the windows. */
  changed?: () => void
  /** The core the seeded Drive answers as; 0.83 when absent. */
  version?: "0.83" | "0.84"
}

/** A store over the service over a seeded Drive, and handles on each layer. */
export async function setup(options: Options = {}) {
  const fake = DriveFake.make({ user: "user-david", version: options.version })
  const ids = new Map<string, string>()
  for (const path of folders) {
    const slash = path.lastIndexOf("/")
    const made = await fake.createFolder({
      name: path.slice(slash + 1),
      parent: slash < 0 ? undefined : ids.get(path.slice(0, slash)),
    })
    if ("id" in made) ids.set(path, made.id)
  }
  for (const item of documents) {
    const made = await fake.upload({
      name: item.name,
      bytes: text(`${item.name}\nFirst line`),
      mime: item.mime,
      folder: item.folder && ids.get(item.folder),
    })
    if ("document" in made) ids.set(item.name, made.document.id)
  }
  const foreign = new Set(others.map((name) => ids.get(name)))
  const seeded = shared(fake, foreign)
  const timers = manualTimers()
  const seen: Array<{ method: string; input: unknown }> = []
  const spied: Backend = {
    ...seeded,
    upload: (input) => (seen.push({ method: "upload", input }), seeded.upload(input)),
    create: (input) => (seen.push({ method: "create", input }), seeded.create(input)),
  }
  const service = DriveIpc.make({
    account: () => account,
    backend: () => options.backend?.(spied) ?? spied,
    store: storage(DriveIpc.Saved, DriveIpc.initial),
    changed: () => options.changed?.(),
    capabilities: () => options.capabilities ?? {},
    timers,
  })
  const client = connect(service)
  await client.refresh()
  const { store, dispose } = createRoot((dispose) => ({
    store: createDriveStore({ client: () => (options.disconnected ? undefined : client) }),
    dispose,
  }))
  return {
    store,
    client,
    service,
    fake,
    seen,
    dispose,
    /** A seeded folder's or document's id, by its path or name. */
    id: (name: string) => {
      const found = ids.get(name)
      if (!found) throw new Error(`not in the sample: ${name}`)
      return found
    },
  }
}

export const names = (list: readonly { name: string }[]) => list.map((item) => item.name)

export const file = (name: string, content = "x", mime?: string) => ({ name, bytes: text(content), mime })

// The fake owns everything as the user: this view of it gives `foreign` to someone else, so Mine and Shared split.
function shared(fake: DriveFake.Fake, foreign: ReadonlySet<string | undefined>): Backend {
  const own = <A extends Document | Folder>(item: A): A =>
    foreign.has(item.id) ? { ...item, mine: false, owner: "user-ana" } : item
  return {
    ...fake,
    list: async (query) => {
      const scope = query.scope ?? "mine"
      if (scope !== "mine" && scope !== "shared") {
        const answer = await fake.list(query)
        if ("code" in answer) return answer
        return { ...answer, folders: answer.folders.map(own), documents: answer.documents.map(own) }
      }
      // Split the whole Drive by owner first, then page what is left, as the instance pages a scope.
      const all = await fake.list({ ...query, scope: "recent", cursor: undefined, limit: Number.MAX_SAFE_INTEGER })
      if ("code" in all) return all
      const owned = all.documents.map(own).filter((item) => item.mine === (scope === "mine"))
      const start = Number(query.cursor ?? 0)
      const end = start + (query.limit ?? 50)
      return { folders: [], documents: owned.slice(start, end), next: end < owned.length ? String(end) : undefined }
    },
    folders: async () => {
      const answer = await fake.folders()
      return "code" in answer ? answer : answer.map(own)
    },
    get: async (id) => {
      const answer = await fake.get(id)
      return "code" in answer ? answer : { ...answer, document: own(answer.document) }
    },
  }
}
