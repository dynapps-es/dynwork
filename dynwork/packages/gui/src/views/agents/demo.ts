// The Agents view's built-in demo data, ported from the November 2026 vision mockup. Nothing here is fetched.

import { demoRoutines } from "../routines/demo"

export type AgentStatus = "running" | "queued" | "idle" | "failed"

export type RunStatus = "running" | "queued" | "succeeded" | "failed" | "cancelled"

export interface LogLine {
  time: string
  level: "info" | "warn" | "error"
  text: string
}

export interface AgentRun {
  status: RunStatus
  title: string
  detail: string
}

export interface AgentSchedule {
  words: string
  cron: string
  tz: string
  state: "active" | "paused"
  next: string
  runs: number
}

export interface Agent {
  id: string
  /** What the agent is called on the farm: the id of the agent definition it runs. */
  slug: string
  name: string
  status: AgentStatus
  task: string
  failure?: string
  repo: string
  branch: string
  started: string
  /** Last run, in words: "6 min", "Yesterday". */
  when: string
  cost: string
  plugins: string
  access: string
  schedule?: AgentSchedule
  log: LogLine[]
  runs: AgentRun[]
  /** Log lines a running agent has not written yet; the simulation appends them one by one. */
  upcoming: string[]
}

/** The agent definitions a new agent can run, as the mockup's "Use an agent" list. */
export const catalog = [
  {
    id: "mr-review",
    name: "Merge request review",
    description: "Reviews a merge request and leaves inline comments",
    plugins: "odoo-code-auditor, odoo-pr-reviewer",
  },
  {
    id: "migration-analysis",
    name: "Migration analysis",
    description: "Assesses custom modules for a version upgrade",
    plugins: "odoo-module-upgrader, odoo-impact-analyzer",
  },
  {
    id: "release-notes",
    name: "Release notes",
    description: "Writes release notes from merged changes",
    plugins: "git-manager",
  },
  {
    id: "brain-curator",
    name: "Brain curator",
    description: "Builds the weekly review queue for Knowledge documents",
    plugins: "dynbrain, dynbrain-weekly-queue",
  },
  {
    id: "ticket-triage",
    name: "Ticket triage",
    description: "Sorts support tickets by module and urgency",
    plugins: "client-request-manager",
  },
  {
    id: "flow-tester",
    name: "Flow tester",
    description: "Runs business flows on a staging environment",
    plugins: "odoo-flow-tester",
  },
]

export const savedAccess = ["gitlab-review", "None"] as const

/** The repeat options of the New agent dialog. */
export const schedules = [
  { words: "Weekdays at 08:00", cron: "0 8 * * 1-5", next: "Mon 10 Nov, 08:00" },
  { words: "Every Monday at 08:00", cron: "0 8 * * 1", next: "Mon 10 Nov, 08:00" },
  { words: "Every day at 23:00", cron: "0 23 * * *", next: "Today 23:00" },
] as const

export const timezone = "Europe/Madrid"

export const instance = "Dynapps"

/** How many routines the demo Routines view lists as on: the count beside "Routines" in the sub-navigation. */
export const routinesOn = demoRoutines.filter((routine) => routine.enabled).length

export const farm = { host: "farm-dev.ai.dyncloud.es", user: "dev@dynapps.test" }

const info = (time: string, text: string): LogLine => ({ time, level: "info", text })
const warn = (time: string, text: string): LogLine => ({ time, level: "warn", text })
const error = (time: string, text: string): LogLine => ({ time, level: "error", text })
const run = (status: RunStatus, title: string, detail: string): AgentRun => ({ status, title, detail })

/** A fresh copy each call: the view mutates its own copy, so a remount starts from the seed again. */
export function demoAgents(): Agent[] {
  return [
    {
      id: "mr-review",
      slug: "mr-review",
      name: "Merge request review",
      status: "running",
      task: "Review !482: fix VAT rounding on credit notes",
      repo: "gitlab.dynapps.test/odoo/odoo-modules",
      branch: "17.0-fix-vat-rounding",
      started: "6 min ago",
      when: "6 min",
      cost: "0.18 EUR so far",
      plugins: "odoo-code-auditor, odoo-pr-reviewer",
      access: "gitlab-review (saved access)",
      log: [
        info("10:42:07", "Cloning gitlab.dynapps.test/odoo/odoo-modules at 17.0-fix-vat-rounding"),
        info("10:42:15", "Loaded plugins: odoo-code-auditor, odoo-pr-reviewer"),
        info("10:42:16", "Reading merge request !482 (6 files, +148 −37)"),
        info("10:43:02", "account_move_vat/models/account_move.py: rounding per line, compared with per tax group"),
        info("10:44:31", "Running tests for account_move_vat (23 tests)"),
        info("10:46:10", "23 passed"),
        warn("10:46:58", "_compute_amount_tax reads currency_id before it is set on new records"),
        info("10:47:55", "Drafting review comments (3 so far)"),
      ],
      runs: [
        run("running", "Review !482", "Started 10:42, running 6 min"),
        run("succeeded", "Review !479", "Yesterday, 4 min, 0.21 EUR"),
        run("succeeded", "Review !476", "Fri 31 Oct, 7 min, 0.33 EUR"),
        run("failed", "Review !471", "Thu 30 Oct, could not download the repository"),
      ],
      upcoming: [
        "account_move_vat/tests/test_credit_note.py: checking the new rounding cases",
        "Drafting review comments (5 so far)",
        "Posting the review on !482",
      ],
    },
    {
      id: "migration-analysis",
      slug: "migration-analysis",
      name: "Migration analysis",
      status: "running",
      task: "Assess 14 custom modules for the 17.0 to 18.0 upgrade",
      repo: "gitlab.dynapps.test/clients/demo-retail",
      branch: "17.0",
      started: "23 min ago",
      when: "23 min",
      cost: "0.94 EUR so far",
      plugins: "odoo-module-upgrader, odoo-impact-analyzer",
      access: "gitlab-review (saved access)",
      log: [
        info("10:25:40", "Cloning gitlab.dynapps.test/clients/demo-retail at 17.0"),
        info("10:26:02", "Found 14 custom modules, 3 depend on OCA modules"),
        info("10:31:48", "retail_pos_loyalty: 12 API changes for 18.0"),
        info("10:44:19", "retail_stock_rules: report written (7 changes, 1 blocking)"),
        info("10:48:03", "Working on retail_invoice_layout (9 of 14)"),
      ],
      runs: [
        run("running", "Assess demo-retail for 18.0", "Started 10:25, running 23 min"),
        run("succeeded", "Assess demo-retail for 17.0", "12 Aug, 41 min, 2.10 EUR"),
      ],
      upcoming: [
        "retail_invoice_layout: report written (4 changes)",
        "Working on retail_website_theme (10 of 14)",
        "retail_website_theme: report written (11 changes, 2 blocking)",
      ],
    },
    {
      id: "release-notes",
      slug: "release-notes",
      name: "Release notes",
      status: "queued",
      task: "Write the release notes for dyncloud-manager 3.4",
      repo: "gitlab.dynapps.test/platform/dyncloud-manager",
      branch: "release/3.4",
      started: "1 min ago",
      when: "1 min",
      cost: "Not started",
      plugins: "git-manager",
      access: "gitlab-review (saved access)",
      log: [info("10:47:31", "Waiting for its turn (1 ahead of it in your team's queue)")],
      runs: [
        run("queued", "Release notes for 3.4", "Waiting for its turn"),
        run("succeeded", "Release notes for 3.3", "14 Oct, 3 min, 0.12 EUR"),
      ],
      upcoming: [],
    },
    {
      id: "brain-curator",
      slug: "brain-curator",
      name: "Brain curator",
      status: "idle",
      task: "Weekly review queue for Odoo Delivery: 7 documents to review",
      repo: "No repository",
      branch: "",
      started: "Yesterday 08:00",
      when: "Yesterday",
      cost: "0.27 EUR, 6 min",
      plugins: "dynbrain, dynbrain-weekly-queue",
      access: "None",
      schedule: {
        words: "Every Monday at 08:00",
        cron: "0 8 * * 1",
        tz: timezone,
        state: "active",
        next: "Mon 10 Nov, 08:00",
        runs: 31,
      },
      log: [
        info("08:00:04", "Started by schedule (every Monday at 08:00)"),
        info("08:01:12", "Read 64 novelties published since Mon 27 Oct"),
        info("08:05:40", "Queued 7 reviews for document owners"),
        info("08:06:02", "Finished OK"),
      ],
      runs: [
        run("succeeded", "Weekly review queue", "Yesterday 08:00, 6 min, 0.27 EUR"),
        run("succeeded", "Weekly review queue", "Mon 27 Oct, 5 min, 0.24 EUR"),
        run("succeeded", "Weekly review queue", "Mon 20 Oct, 6 min, 0.29 EUR"),
      ],
      upcoming: [],
    },
    {
      id: "ticket-triage",
      slug: "ticket-triage",
      name: "Ticket triage",
      status: "idle",
      task: "Sorted 18 new support tickets by module and urgency",
      repo: "No repository",
      branch: "",
      started: "Fri 31 Oct, 07:30",
      when: "Fri",
      cost: "0.09 EUR, 2 min",
      plugins: "client-request-manager",
      access: "None",
      schedule: {
        words: "Weekdays at 07:30",
        cron: "30 7 * * 1-5",
        tz: timezone,
        state: "paused",
        next: "Paused",
        runs: 112,
      },
      log: [
        info("07:30:02", "Started by schedule (weekdays at 07:30)"),
        info("07:31:44", "Sorted 18 tickets"),
        info("07:31:50", "Finished OK"),
      ],
      runs: [
        run("succeeded", "Morning triage", "Fri 31 Oct, 2 min, 0.09 EUR"),
        run("succeeded", "Morning triage", "Thu 30 Oct, 2 min, 0.08 EUR"),
      ],
      upcoming: [],
    },
    {
      id: "flow-tester",
      slug: "flow-tester",
      name: "Flow tester",
      status: "failed",
      task: "Run the sales-to-invoice flows on staging",
      failure: "It ran out of time",
      repo: "gitlab.dynapps.test/clients/demo-retail",
      branch: "18.0-staging",
      started: "41 min ago",
      when: "41 min",
      cost: "0.61 EUR, 30 min",
      plugins: "odoo-flow-tester",
      access: "gitlab-review (saved access)",
      log: [
        info("10:05:12", "Cloning gitlab.dynapps.test/clients/demo-retail at 18.0-staging"),
        info("10:06:40", "Running 9 flows"),
        info("10:21:03", "Flow 6 of 9: waiting for the payment provider sandbox"),
        error("10:35:12", "Stopped: it ran out of time (30 min limit)"),
      ],
      runs: [
        run("failed", "Sales-to-invoice flows", "41 min ago, ran out of time"),
        run("succeeded", "Sales-to-invoice flows", "Mon 3 Nov, 22 min, 0.48 EUR"),
      ],
      upcoming: [],
    },
  ]
}
