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

export type Plugin = Pick<ReturnType<typeof DynWorkSyncMain.make>, "materialize" | "inspect">

/** How long one capture may spend installing publications, and then delivering receipts, as the bridge budgets. */
export const recoveryBudget = 30_000
export const deliveryBudget = 10_000
// Below this a plan and its readback cannot finish, and would only spend the item's backoff
const itemBudget = 2_000
// Outbox entries kept per account, as the bridge's outbox
const outboxLimit = 512

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

  const capture = async (input: Input, serial: Serial = (call) => call()): Promise<Outcome> => {
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

    if (outbox.refused) accounts.forgetDevice(input.id)
    if (!outbox.refused) accounts.receipts(input.id, outbox.entries)
    return { ...counts, undelivered: outbox.entries.some((entry) => entry.state === "pending") }
  }

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

  return { capture }
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

// Posts every pending receipt that is due, until `deadline`. The instance's answer settles it: acknowledged, refused
// for good (`409` a conflict; `400`, `403`, `404`, `422` rejected) or tried again later; a refused credential stops.
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
    outbox.entries[index] = settle(entry, answer._tag === "Success" ? 200 : status(answer.failure))
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
