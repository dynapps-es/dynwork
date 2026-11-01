export * as DynWorkRuntime from "./runtime"

import { isDeepStrictEqual } from "node:util"
import { Effect } from "effect"
import { SpClient, SpConsumer, type Manifest, type Publication } from "@dynwork/sp-client"
import type { DynWorkAccounts } from "../accounts/accounts"
import type { DynWorkSyncMain } from "../accounts/sync"

// A skill's runtime files (`references/*`, `config.yaml`) do not come in the manifest: like the systemprompt bridge's
// installation evidence (`feedback_capture/mod.rs`, `feedback/{enrol,sync,outbox}.rs`), this install enrols as the
// user's device, reads each skill publication's plan for OpenCode with the device credential, has the plugin write the
// files beside the SKILL.md `apply` wrote and read them back, and posts a receipt. Receipts wait in an outbox kept with
// the account until the instance acknowledges them. Every failure here is a warning: the sync stands either way.

export type Plugin = Pick<ReturnType<typeof DynWorkSyncMain.make>, "materialize" | "inspect" | "device">

/** How long one capture may spend installing publications, and then delivering receipts, as the bridge budgets. */
export const recoveryBudget = 30_000
export const deliveryBudget = 10_000
// Below this a plan and its readback cannot finish, and would only spend the item's backoff
const itemBudget = 2_000
// Outbox entries kept per account, as the bridge's outbox
const outboxLimit = 512
// Sessions kept per receipt; the bridge refuses a new one past 256 waiting
const sessionLimit = 256

export type Outcome = {
  /** Publications installed by this capture. */
  readonly recovered: number
  /** Publications due that were not installed: no device, a failure, a backoff or the budget. */
  readonly remaining: number
  /** Receipts still waiting for the instance. */
  readonly undelivered: boolean
}

export type Input = {
  readonly id: string
  readonly account: { readonly label: string; readonly url: string }
  readonly manifest: Manifest
}

type Serial = <A>(call: () => Promise<A>) => Promise<A>

export function make(options: { accounts: DynWorkAccounts.Accounts; plugin: Plugin }) {
  const accounts = options.accounts
  const plugin = options.plugin
  // When a failed enrolment or installation may be tried again, by account or publication
  const waits = new Map<string, { attempts: number; next: number }>()

  const due = (key: string) => (waits.get(key)?.next ?? 0) <= Date.now()
  const failed = (key: string) => {
    const attempts = (waits.get(key)?.attempts ?? 0) + 1
    waits.set(key, { attempts, next: Date.now() + backoff(attempts) })
  }

  // Captures and bindings read the outbox, post, then save it: one at a time, so neither overwrites the other.
  const queue = { tail: Promise.resolve() as Promise<unknown> }
  const exclusive = <A>(run: () => Promise<A>) => {
    const next = queue.tail.then(run, run)
    queue.tail = next.catch(() => undefined)
    return next
  }

  const capture = (input: Input, serial: Serial = (call) => call()) => exclusive(() => captureNow(input, serial))

  const captureNow = async (input: Input, serial: Serial): Promise<Outcome> => {
    const skills = selected(input.manifest)
    const enrolment = `device:${input.id}`
    const device = due(enrolment)
      ? await accounts.device(input.id, input.manifest.user_id).catch(() => {
          failed(enrolment)
          return undefined
        })
      : undefined
    if (device === undefined) return { recovered: 0, remaining: skills.length, undelivered: false }
    waits.delete(enrolment)
    // The governance events carry it as device evidence, like the bridge's proxy forwards a hook
    await serial(() => plugin.device({ account: input.account, credential: device.credential })).catch(() => false)
    const outbox = { entries: [...device.receipts], refused: false }
    const post = (deadline: number) => deliver(input.account.url, device.credential, outbox, deadline)

    // The outbox first, so a receipt a failed sync left reaches the instance before anything new
    await post(Date.now() + deliveryBudget)
    const deadline = Date.now() + recoveryBudget
    const counts = { recovered: 0, remaining: 0 }
    for (const skill of skills) {
      const recorded = outbox.entries.find((entry) => sameInstallation(entry.receipt, skill.publication))
      const intact =
        recorded !== undefined &&
        (await serial(() =>
          plugin.inspect({
            account: input.account,
            skill: skill.id,
            files: recorded.receipt.runtime_files.map((file) => ({
              path: file.path,
              digest: file.digest,
              bytes: file.bytes,
              executable: file.executable,
            })),
          }),
        ).catch(() => false))
      if (intact) continue
      if (outbox.refused || !due(skill.publication.publication_id) || deadline - Date.now() < itemBudget) {
        counts.remaining++
        continue
      }
      const receipt = await install(input, device, skill, outbox, serial)
      if (receipt === undefined) {
        // A refused credential is the device's failure, not the publication's
        if (!outbox.refused) failed(skill.publication.publication_id)
        counts.remaining++
        continue
      }
      waits.delete(skill.publication.publication_id)
      enqueue(outbox, receipt)
      counts.recovered++
    }
    await post(Date.now() + deliveryBudget)

    if (outbox.refused) await forget(input, serial)
    if (!outbox.refused) accounts.receipts(input.id, outbox.entries)
    return { ...counts, undelivered: undelivered(outbox.entries) }
  }

  // The instance refused the device credential: forgotten, and taken back from the plugin's events.
  const forget = async (input: Pick<Input, "id" | "account">, serial: Serial) => {
    accounts.forgetDevice(input.id)
    await serial(() => plugin.device({ account: input.account })).catch(() => false)
  }

  /**
   * Binds a native Session the plugin's governance events reported to every receipt of the newest generation of each
   * resource, and posts what is due, as the bridge's proxy queues a hook's session and its outbox delivers it. Without
   * an enrolled device nothing is queued (nor enrolled). What fails waits for the next capture.
   */
  const bind = (input: Pick<Input, "id" | "account"> & { readonly session: string }) =>
    exclusive(async () => {
      const held = accounts.stored(input.id)?.device
      if (held === undefined) return
      const device = await accounts.device(input.id, held.consumer).catch(() => undefined)
      if (device === undefined) return
      const outbox = { entries: bindSession(device.receipts, input.session), refused: false }
      await deliver(input.account.url, device.credential, outbox, Date.now() + deliveryBudget)
      if (outbox.refused) await forget(input, (call) => call())
      if (!outbox.refused) accounts.receipts(input.id, outbox.entries)
    })

  // One publication: its plan, the files written and read back by the plugin, and the receipt that reports them.
  const install = async (
    input: Input,
    device: { readonly installation: string; readonly credential: string },
    skill: { readonly id: string; readonly publication: Publication },
    outbox: { refused: boolean },
    serial: Serial,
  ) => {
    const plan = await Effect.runPromise(
      Effect.result(SpConsumer.plan(input.account.url, device.credential, skill.publication)),
    )
    if (plan._tag === "Failure") {
      outbox.refused ||= plan.failure instanceof SpClient.Unauthorized
      return undefined
    }
    const written = await serial(() =>
      plugin.materialize({
        account: input.account,
        skill: skill.id,
        files: plan.success.runtime_files.map((file) => ({
          path: file.path,
          content: Buffer.from(file.bytes).toString("base64"),
          executable: file.executable,
        })),
      }),
    ).catch(() => undefined)
    if (written?.outcome !== "written") return undefined
    const built = SpConsumer.receipt(plan.success, written.files, device.installation, new Date().toISOString())
    return "receipt" in built ? built.receipt : undefined
  }

  return { capture, bind }
}

export type Runtime = ReturnType<typeof make>

const hosts = ["opencode", "opencode-cli"]

// The skills with a publication that reach OpenCode, as the bridge's `capture_host` selects them for an enabled host.
function selected(manifest: Manifest) {
  if (!manifest.enabled_hosts?.some((host) => hosts.includes(host))) return []
  return manifest.skills.flatMap((skill) =>
    skill.publication !== undefined && (!skill.hosts?.length || skill.hosts.some((host) => hosts.includes(host)))
      ? [{ id: skill.id, publication: skill.publication }]
      : [],
  )
}

function sameInstallation(receipt: SpConsumer.Receipt, publication: Publication) {
  return (
    receipt.publication_id === publication.publication_id &&
    receipt.resource_id === publication.resource_id &&
    receipt.revision_id === publication.revision_id &&
    receipt.generation === publication.generation &&
    receipt.bundle_digest === publication.bundle_digest
  )
}

// The bridge's outbox: one entry per installation, publication and host. The same receipt again keeps its entry and
// its state; a different one is pending again. An older generation of the same resource is superseded.
function enqueue(outbox: { entries: DynWorkAccounts.Receipt[] }, receipt: SpConsumer.Receipt) {
  const existing = outbox.entries.find(
    (entry) =>
      entry.receipt.installation_id === receipt.installation_id &&
      entry.receipt.resource_id === receipt.resource_id &&
      entry.receipt.publication_id === receipt.publication_id &&
      entry.receipt.host === receipt.host,
  )
  if (existing && isDeepStrictEqual({ ...existing.receipt, observed_at: "" }, { ...receipt, observed_at: "" })) return
  const kept = outbox.entries.filter(
    (entry) =>
      entry !== existing &&
      !(entry.receipt.resource_id === receipt.resource_id && entry.receipt.generation < receipt.generation),
  )
  // Full: the oldest settled entry makes room, as the bridge evicts acknowledged and refused ones
  const settled = kept.findIndex((entry) => entry.state !== "pending")
  if (kept.length >= outboxLimit && settled >= 0) kept.splice(settled, 1)
  outbox.entries = [...kept, { receipt, state: "pending", attempts: 0, next: Date.now() }]
}

// Whether a receipt or a session binding still waits for the instance.
function undelivered(entries: ReadonlyArray<DynWorkAccounts.Receipt>) {
  return entries.some(
    (entry) =>
      entry.state === "pending" ||
      (entry.state === "acknowledged" && Object.values(entry.sessions ?? {}).includes("pending")),
  )
}

// The bridge's `bind_session`: the session waits on every entry of the newest generation of its resource that the
// instance has not refused, unless that entry refused this session already or holds too many waiting.
function bindSession(entries: ReadonlyArray<DynWorkAccounts.Receipt>, session: string) {
  const live = entries.filter((entry) => entry.state === "pending" || entry.state === "acknowledged")
  const newest = new Map<string, number>()
  for (const entry of live)
    newest.set(entry.receipt.resource_id, Math.max(newest.get(entry.receipt.resource_id) ?? 0, entry.receipt.generation))
  return entries.map((entry) => {
    const sessions = entry.sessions ?? {}
    if (!live.includes(entry) || newest.get(entry.receipt.resource_id) !== entry.receipt.generation) return entry
    if (sessions[session] !== undefined) return entry
    if (Object.values(sessions).filter((state) => state === "pending").length >= sessionLimit) return entry
    // Settled sessions make room, oldest first
    const kept = Object.entries(sessions).slice(-(sessionLimit - 1))
    return { ...entry, sessions: { ...Object.fromEntries(kept), [session]: "pending" as const } }
  })
}

// Posts every pending receipt that is due, until `deadline`. The instance's answer settles it: acknowledged, refused
// for good (`409` a conflict; `400`, `403`, `404`, `422` rejected) or tried again later; a refused credential stops.
// Then the pending session bindings of every verified acknowledged receipt, as the bridge's `deliver`: bound, refused
// for good (`400`, `403`, `404`, `409`, `422`), or left for later with the entry's backoff.
async function deliver(
  url: string,
  credential: string,
  outbox: { entries: DynWorkAccounts.Receipt[]; refused: boolean },
  deadline: number,
) {
  for (const [index, entry] of outbox.entries.entries()) {
    if (outbox.refused || entry.state !== "pending" || entry.next > Date.now() || Date.now() > deadline) continue
    const answer = await Effect.runPromise(Effect.result(SpConsumer.post(url, credential, entry.receipt)))
    outbox.refused ||= answer._tag === "Failure" && answer.failure instanceof SpClient.Unauthorized
    const settled = settle(entry, answer._tag === "Success" ? 200 : status(answer.failure))
    outbox.entries[index] =
      answer._tag === "Success"
        ? { ...settled, receiptId: answer.success.receipt_id, verified: answer.success.fully_verified }
        : settled
  }
  for (const [index, entry] of outbox.entries.entries()) {
    if (outbox.refused || entry.state !== "acknowledged" || entry.receiptId === undefined || !entry.verified) continue
    if (entry.next > Date.now()) continue
    const sessions = { ...entry.sessions }
    for (const [session, state] of Object.entries(sessions)) {
      if (state !== "pending" || outbox.refused || Date.now() > deadline) continue
      const answer = await Effect.runPromise(
        Effect.result(SpConsumer.bind(url, credential, { receipt_id: entry.receiptId, session_id: session })),
      )
      if (answer._tag === "Success") {
        sessions[session] = "bound"
        continue
      }
      const code = status(answer.failure)
      outbox.refused ||= code === 401
      if ([400, 403, 404, 409, 422].includes(code)) {
        sessions[session] = "refused"
        continue
      }
      const attempts = entry.attempts + 1
      outbox.entries[index] = { ...entry, sessions, attempts, next: Date.now() + backoff(attempts) }
      break
    }
    if (outbox.entries[index] === entry) outbox.entries[index] = { ...entry, sessions }
  }
}

function settle(entry: DynWorkAccounts.Receipt, status: number): DynWorkAccounts.Receipt {
  if (status === 200) return { ...entry, state: "acknowledged", attempts: 0, next: Date.now() }
  const attempts = entry.attempts + 1
  if (status === 409) return { ...entry, state: "conflict", attempts }
  if ([400, 403, 404, 422].includes(status)) return { ...entry, state: "rejected", attempts }
  return { ...entry, attempts, next: Date.now() + backoff(attempts) }
}

function status(error: SpClient.SpError) {
  if (error instanceof SpClient.Unauthorized) return 401
  if (error instanceof SpClient.Protocol || error instanceof SpClient.Unreachable) return error.status ?? 0
  return 0
}

// The bridge's `retry_after`: 2^attempts seconds, at most an hour.
function backoff(attempts: number) {
  return Math.min(2 ** Math.min(attempts, 10), 3600) * 1000
}
