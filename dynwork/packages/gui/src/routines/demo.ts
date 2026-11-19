export * as RoutinesDemo from "./demo"

import type { Registry } from "./backend"
import type { Capabilities, Routine, Run, Transcript } from "./contract"
import { RoutinesFake } from "./fake"
import { RoutinesFarm } from "./farm/backend"
import { RoutinesLocal } from "./local/backend"

// The demo backends: fictional routines and runs shaped like the approved mockup (`docs/mockup-agents.html`), kept in
// the fakes of `./fake` until a real backend takes their id. The local one stands for this computer, the remote one for
// the Agent Farm. Times are read off the clock once, when the backend is made, so they stay in the same order.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const ZONE = "Europe/Madrid"

export const localId = "local"
export const farmId = RoutinesFarm.id

/** Adds the demo backends whose id nothing has registered, and answers those it added. */
export function register(registry: Registry, now: () => number) {
  const added = [...(registry.get(localId) ? [] : [local(now)]), ...(registry.get(farmId) ? [] : [remote(now)])]
  added.forEach((fake) => registry.register(fake))
  return added
}

const localCapabilities = (label: string): Omit<Capabilities, "backend" | "quota"> => ({
  kind: "local",
  label,
  status: "ready",
  instructions: ["prompt", "skill"],
  agent: "optional",
  model: "choose",
  schedule: { window: false, minimum: 5 },
  actions: { edit: "in-place", reply: "in-place", cancel: true },
  fields: RoutinesLocal.fields,
})

/** The routines of this computer: two of them wait on a result, one on another device, one is paused. */
export function local(now: () => number) {
  const t = now()
  const here = { label: "Demo MacBook", online: true, here: true }
  const home = { label: "Home laptop", online: false, here: false }
  const ref = (id: string) => ({ backend: localId, id })
  const session = (routine: string, run: string) => ({
    kind: "session" as const,
    server: "demo",
    session: `ses-${run}`,
    anchor: `ses-${routine}`,
  })
  const anchor = (routine: string) => ({
    kind: "session" as const,
    server: "demo",
    session: `ses-${routine}`,
    anchor: `ses-${routine}`,
  })
  const defaults = {
    permissions: "ask",
    timeLimit: 30,
    recover: "recent",
    catchUp: 6,
    notify: "failures",
  }
  const routine = (
    id: string,
    patch: Pick<Routine, "definition"> & Partial<Pick<Routine, "state" | "next" | "owner" | "updated">>,
  ): Routine => ({
    ref: ref(id),
    state: "active",
    unread: 0,
    owner: here,
    conversation: anchor(id),
    updated: t - 2 * DAY,
    ...patch,
  })
  const run = (id: string, routineId: string, patch: Partial<Run> & Pick<Run, "state" | "title">): Run => ({
    ref: ref(id),
    routine: ref(routineId),
    trigger: "schedule",
    unread: false,
    conversation: session(routineId, id),
    ...patch,
  })
  const tickets =
    "Review the support tickets opened in the last week, group them by module and urgency, and prepare a summary with the five oldest and a suggested owner for each."

  const routines = [
    routine("tickets", {
      definition: {
        name: "Weekly ticket summary",
        instructions: { kind: "prompt", text: tickets },
        model: "claude-sonnet-5-5",
        schedule: { cron: "45 8 * * 1", timezone: ZONE },
        enabled: true,
        options: { ...defaults },
      },
      next: t + 6 * DAY,
    }),
    routine("tests", {
      definition: {
        name: "Nightly test run",
        instructions: {
          kind: "prompt",
          text: "Run the test suite of this project and, if something fails, summarise the likely cause and the commit that introduced it.",
        },
        schedule: { cron: "0 23 * * 1-5", timezone: ZONE },
        enabled: true,
        options: { ...defaults, folder: "/Users/demo/Projects/portal", permissions: "bypass" },
      },
      next: t + 14 * HOUR,
    }),
    routine("timesheet", {
      definition: {
        name: "Timesheet draft",
        instructions: { kind: "skill", skill: "timesheet-report" },
        schedule: { cron: "0 17 * * 5", timezone: ZONE },
        enabled: true,
        options: { ...defaults },
      },
      next: t + 4 * DAY,
      owner: home,
    }),
    routine("brain", {
      definition: {
        name: "Sort the Brain inbox",
        instructions: {
          kind: "prompt",
          text: "Go through the unsorted Brain items and propose a folder and an owner for each.",
        },
        schedule: { cron: "30 9 * * 1", timezone: ZONE },
        enabled: false,
        options: { ...defaults },
      },
      state: "paused",
    }),
  ]

  const runs = [
    run("tickets-1", "tickets", {
      state: "ok",
      title: "Mon 16 Nov, 08:45",
      due: t - 15 * MINUTE,
      started: t - 15 * MINUTE,
      finished: t - 12 * MINUTE,
      summary: "23 open tickets, 4 urgent.",
      unread: true,
    }),
    run("tests-1", "tests", {
      state: "failed",
      reason: "tests",
      title: "Fri 13 Nov, 23:00",
      due: t - 10 * HOUR,
      started: t - 10 * HOUR,
      finished: t - 10 * HOUR + 7 * MINUTE,
      summary: "2 tests broke in billing.",
      unread: true,
    }),
    run("tickets-2", "tickets", {
      state: "late",
      reason: "closed",
      trigger: "catch-up",
      title: "Mon 9 Nov, 08:45",
      due: t - 7 * DAY - 27 * MINUTE,
      started: t - 7 * DAY,
      finished: t - 7 * DAY + 4 * MINUTE,
      summary: "Planned for 08:45; Dynwork was closed and ran it when it opened.",
    }),
    run("tickets-3", "tickets", {
      state: "missed",
      reason: "closed",
      title: "Mon 2 Nov, 08:45",
      due: t - 14 * DAY,
      conversation: { kind: "none" },
      summary: "Dynwork stayed closed past the catch-up window.",
    }),
    run("tickets-4", "tickets", {
      state: "failed",
      reason: "timeout",
      title: "Mon 26 Oct, 08:45",
      due: t - 21 * DAY,
      started: t - 21 * DAY,
      finished: t - 21 * DAY + 30 * MINUTE,
      summary: "Stopped at the 30 minute limit: the Odoo connector did not answer.",
    }),
    run("tickets-5", "tickets", {
      state: "blocked",
      reason: "permission",
      title: "Mon 19 Oct, 08:45",
      due: t - 28 * DAY,
      started: t - 28 * DAY,
      finished: t - 28 * DAY + 2 * MINUTE,
      summary: "Denied: odoo write is not among the task's rules.",
    }),
  ]

  return RoutinesFake.make({
    id: localId,
    capabilities: localCapabilities(here.label),
    routines,
    runs,
    choices: {
      agents: [
        { value: "build", label: "Build" },
        { value: "plan", label: "Plan" },
      ],
      models: [
        { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
        { value: "claude-opus-5-5", label: "Claude Opus 5.5" },
      ],
      skills: [
        { value: "timesheet-report", label: "Timesheet report" },
        { value: "standup-facilitator", label: "Standup facilitator" },
      ],
      connectors: [
        { value: "dynbrain", label: "Dynbrain" },
        { value: "odoo", label: "Odoo" },
      ],
    },
    owner: here,
    conversation: "session",
    now,
  })
}

// JESÚS: this fake stands in for the Agent Farm until yours registers under `farmId`: read it as the target behavior of
// `routines/farm/`, from the fields it declares to the transcript it serves. Delete it from `register` when yours lands.

/** The routines of the Agent Farm: one running, one that failed on a credential, one manual only, one paused. */
export function remote(now: () => number) {
  const t = now()
  const ref = (id: string) => ({ backend: farmId, id })
  const repository = (name: string) => `https://git.example.com/${name}.git`
  const routine = (
    id: string,
    patch: Pick<Routine, "definition"> & Partial<Pick<Routine, "state" | "next">>,
  ): Routine => ({
    ref: ref(id),
    state: "active",
    unread: 0,
    conversation: { kind: "none" },
    updated: t - 3 * DAY,
    ...patch,
  })
  const run = (id: string, routineId: string | undefined, patch: Partial<Run> & Pick<Run, "state" | "title">): Run => ({
    ref: ref(id),
    routine: routineId ? ref(routineId) : undefined,
    trigger: "schedule",
    unread: false,
    conversation: { kind: "transcript" },
    ...patch,
  })

  const routines = [
    routine("crm", {
      definition: {
        name: "Sync CRM",
        instructions: {
          kind: "agent",
          agent: "crm-sync",
          input:
            "Copy this week's new opportunities to the corporate CRM and update stage and probability of the existing ones.",
        },
        schedule: { cron: "30 7 * * 1-5", timezone: ZONE },
        enabled: true,
        options: {
          repository: repository("crm/sync"),
          branch: "main",
          access: "crm-git",
          plugins: ["crm-tools", "odoo-connector"],
          timeLimit: 15,
          overlap: "skip",
        },
      },
      next: t + 22 * HOUR,
    }),
    routine("reviews", {
      definition: {
        name: "Merge request review",
        instructions: {
          kind: "agent",
          agent: "mr-review",
          input: "Review the open merge requests of odoo-modules and leave inline comments.",
        },
        schedule: { cron: "0 9 * * *", timezone: ZONE },
        enabled: true,
        options: { repository: repository("odoo/odoo-modules"), branch: "main", timeLimit: 30, overlap: "skip" },
      },
      next: t + 20 * HOUR,
    }),
    routine("notes", {
      definition: {
        name: "Release notes",
        instructions: {
          kind: "agent",
          agent: "release-notes",
          input: "Write the release notes from the changes merged since the last tag.",
        },
        enabled: true,
        options: { repository: repository("odoo/odoo-modules"), branch: "main", timeLimit: 15 },
      },
    }),
    routine("audit", {
      definition: {
        name: "Module audit",
        instructions: {
          kind: "agent",
          agent: "module-audit",
          input: "Review the maintenance customers' own modules and open a task for every high risk.",
        },
        schedule: { cron: "0 3 1 * *", timezone: ZONE },
        enabled: false,
        options: { repository: repository("odoo/custom-modules"), timeLimit: 60, overlap: "skip" },
      },
      state: "paused",
    }),
  ]

  const cost = (amount: number) => ({ amount, currency: "EUR" })
  const runs = [
    run("crm-0", "crm", {
      state: "running",
      title: "Mon 16 Nov, 07:30",
      due: t - 6 * MINUTE,
      started: t - 6 * MINUTE,
      cost: cost(0.12),
      unread: true,
    }),
    run("reviews-0", "reviews", {
      state: "skipped",
      reason: "overlap",
      title: "Sun 15 Nov, 09:00",
      due: t - 22 * HOUR,
      summary: "The previous run was still going.",
    }),
    run("reviews-1", "reviews", {
      state: "ok",
      title: "Fri 13 Nov, 09:00",
      due: t - 3 * DAY + 90 * MINUTE,
      started: t - 3 * DAY + 90 * MINUTE,
      finished: t - 3 * DAY + 100 * MINUTE,
      summary: "4 merge requests reviewed.",
      cost: cost(0.58),
    }),
    run("crm-1", "crm", {
      state: "ok",
      title: "Fri 13 Nov, 07:30",
      due: t - 3 * DAY,
      started: t - 3 * DAY,
      finished: t - 3 * DAY + 9 * MINUTE,
      summary: "3 opportunities created, 7 updated.",
      cost: cost(0.41),
      unread: true,
    }),
    run("notes-1", "notes", {
      state: "ok",
      trigger: "manual",
      title: "Thu 12 Nov, 16:20",
      started: t - 4 * DAY,
      finished: t - 4 * DAY + 3 * MINUTE,
      summary: "Run by hand.",
      cost: cost(0.09),
    }),
    run("chat-1", undefined, {
      state: "ok",
      trigger: "manual",
      title: "Wed 11 Nov, 12:05",
      started: t - 5 * DAY,
      finished: t - 5 * DAY + 2 * MINUTE,
      summary: "Started from the chat, outside Dynwork.",
    }),
    run("chat-2", undefined, {
      state: "running",
      reason: "question",
      trigger: "manual",
      title: "Wed 11 Nov, 10:30",
      started: t - 5 * DAY - HOUR,
      unread: true,
      question: {
        id: "q-1",
        text: "The branch feature/old-sync has no open merge request. Delete it?",
        choices: ["Yes, delete it", "No, keep it"],
      },
    }),
    run("crm-3", "crm", {
      state: "failed",
      reason: "credential_error",
      title: "Wed 11 Nov, 07:30",
      due: t - 5 * DAY - 4 * HOUR,
      started: t - 5 * DAY - 4 * HOUR,
      finished: t - 5 * DAY - 4 * HOUR + MINUTE,
      summary: "Could not clone the repository: the stored access crm-git has expired.",
      cost: cost(0.01),
    }),
  ]

  const transcripts: Record<string, Transcript> = {
    "crm-0": {
      log: "07:30:04 Cloning git.example.com/crm/sync (main)\n07:30:19 Plugins loaded: crm-tools, odoo-connector\n07:31:02 Reading 41 new opportunities since Monday\n07:34:40 Created 2; updating the probability of 5",
      usage: { cost: cost(0.12) },
    },
    "crm-1": {
      result:
        "Sync finished: **3 opportunities created** and **7 updated** in the corporate CRM.\n\n| Customer | Stage | Change |\n| --- | --- | --- |\n| Demo Retail | Proposal | created |\n| Demo Logistics | Won | updated |\n| Demo Services | Qualified | updated |",
      log: "07:30:03 Cloning git.example.com/crm/sync (main)\n07:31:10 Reading 37 new opportunities since Thursday\n07:38:52 3 created, 7 updated, 2 skipped (no owner)\n07:39:05 Finished",
      usage: { cost: cost(0.41), turns: 38, duration: 9 * MINUTE },
    },
    "crm-3": {
      result: "The run stopped before it started: authentication was rejected for the stored access `crm-git`.",
      log: "07:30:02 Cloning git.example.com/crm/sync (main)\n07:30:09 ERROR authentication rejected for crm-git\n07:30:09 Task finished: failed (credential_error)",
      usage: { cost: cost(0.01), duration: MINUTE },
    },
    "chat-2": {
      log: "10:30:02 Started\n10:34:31 Found 3 stale branches in odoo/odoo-modules\n10:36:10 Waiting for your answer",
      usage: { cost: cost(0.03) },
    },
    "chat-1": {
      result: "Checked the three open branches: none has conflicts with `main`.",
      log: "12:05:01 Started\n12:07:02 Finished",
      usage: { cost: cost(0.05), turns: 6, duration: 2 * MINUTE },
    },
  }

  return RoutinesFake.make({
    id: farmId,
    capabilities: RoutinesFarm.base,
    // The team holds 4 of the 20 schedules; this user's three scheduled routines make 7.
    quota: { max: 20, others: 4, shared: true },
    routines,
    runs,
    transcripts,
    choices: {
      agents: [
        { value: "crm-sync", label: "CRM sync" },
        { value: "mr-review", label: "Merge request review" },
        { value: "release-notes", label: "Release notes" },
        { value: "module-audit", label: "Module audit" },
      ],
      plugins: [
        { value: "crm-tools", label: "CRM tools" },
        { value: "odoo-connector", label: "Odoo connector" },
        { value: "review-kit", label: "Review kit" },
      ],
      "credentials:git_token": [
        { value: "crm-git", label: "crm-git" },
        { value: "docs-git", label: "docs-git" },
      ],
    },
    conversation: "transcript",
    now,
  })
}
