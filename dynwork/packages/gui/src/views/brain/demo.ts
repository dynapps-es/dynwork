// The Brain view's demo data, ported from the November 2026 vision mockup. Built in: nothing here is fetched.

export type Origin = "managed" | "mirror" | "native"
export type Role = "Can read" | "Can edit"
export type Tone = "purple" | "gray" | "cyan" | "green" | "orange" | "blue"

/** A group that can open a document, and how. */
export interface Grant {
  readonly id: string
  readonly initials: string
  readonly name: string
  role: Role
  /** `inherited` comes from the space; `explicit` was set on the document. */
  readonly source: "inherited" | "explicit"
  readonly tone: Tone
}

/** A folder (with `children`) or a document in a space's tree. */
export interface TreeNode {
  readonly id: string
  readonly title: string
  readonly children?: readonly TreeNode[]
}

export interface Space {
  readonly id: string
  readonly name: string
  /** `managed` is published to Git, `mirror` is read-only and mirrored from Git, `native` lives in Odoo only. */
  readonly origin: Origin
  readonly repo?: string
  /** What the signed-in user can do in the space. */
  readonly you: Role
  readonly access: readonly Omit<Grant, "source">[]
  readonly children: readonly TreeNode[]
}

export interface Doc {
  readonly id: string
  readonly space: string
  readonly type: string
  readonly owner: string
  readonly canon: "Verified" | "Draft" | "Maintained by source"
  readonly review: string
  readonly langs: readonly string[]
  // The three fields the view edits in its in-memory copy.
  updated: string
  markdown: string
  explicit: Omit<Grant, "source">[]
}

/** Groups the "Share with a group" action offers, in order. */
export const groups: readonly Omit<Grant, "source" | "role">[] = [
  { id: "sales", initials: "ST", name: "Sales team", tone: "orange" },
  { id: "finance", initials: "FN", name: "Finance", tone: "green" },
  { id: "partners", initials: "PA", name: "Partners", tone: "cyan" },
  { id: "interns", initials: "IN", name: "Interns", tone: "blue" },
]

export const spaces: readonly Space[] = [
  {
    id: "delivery",
    name: "Odoo Delivery",
    origin: "managed",
    repo: "gitlab.dynapps.test/docs/odoo-delivery",
    you: "Can edit",
    access: [
      { id: "delivery-team", initials: "DT", name: "Delivery team", role: "Can edit", tone: "purple" },
      { id: "employees", initials: "AE", name: "All employees", role: "Can read", tone: "gray" },
    ],
    children: [
      { id: "methodology", title: "Project methodology" },
      {
        id: "migrations",
        title: "Migrations",
        children: [
          { id: "mig-18", title: "17.0 to 18.0 checklist" },
          { id: "openupgrade", title: "Data migration with OpenUpgrade" },
        ],
      },
      { id: "quality-gate", title: "Quality gate before go-live" },
    ],
  },
  {
    id: "platform",
    name: "Dyncloud Platform",
    origin: "mirror",
    repo: "gitlab.dynapps.test/platform/handbook",
    you: "Can read",
    access: [
      { id: "platform-team", initials: "PT", name: "Platform team", role: "Can read", tone: "cyan" },
      { id: "employees", initials: "AE", name: "All employees", role: "Can read", tone: "gray" },
    ],
    children: [
      { id: "sleep", title: "Environments and sleep" },
      { id: "backups", title: "Backups and restore" },
      { id: "deploy", title: "Deploying a release" },
    ],
  },
  {
    id: "handbook",
    name: "Dynapps Handbook",
    origin: "native",
    you: "Can read",
    access: [
      { id: "people-team", initials: "PE", name: "People team", role: "Can edit", tone: "green" },
      { id: "employees", initials: "AE", name: "All employees", role: "Can read", tone: "gray" },
    ],
    children: [
      { id: "first-week", title: "Your first week" },
      { id: "tools", title: "Tools and accounts" },
      { id: "writing", title: "Writing documentation" },
    ],
  },
]

export const docs: readonly Doc[] = [
  {
    id: "mig-18",
    space: "delivery",
    type: "Procedure",
    owner: "Delivery lead",
    canon: "Verified",
    review: "1 Feb 2027",
    updated: "3 days ago",
    langs: ["Spanish", "English"],
    explicit: [{ id: "consultants", initials: "CO", name: "Consultants", role: "Can edit", tone: "orange" }],
    markdown: `---
title: 17.0 to 18.0 checklist
description: What to check before, during and after moving a customer from Odoo 17.0 to 18.0.
doc_type: procedure
owner: Delivery lead
canon_state: verified
canon_review_by: 2027-02-01
---

## Before you start

Agree the upgrade window with the customer and freeze custom development two weeks before it. Every module in the
\`addons\` repository needs an owner who signs off its migration.

- Export the list of installed modules from production, not from staging.
- Check that every OCA dependency has an 18.0 branch.
- Take a backup and restore it into a fresh staging environment.

## Module audit

Run the **migration analysis** agent on the customer's repository. It writes one report per module with the API
changes it found and marks the blocking ones.

| Check | Who | When |
| --- | --- | --- |
| Custom modules build on 18.0 | Developer | Week 1 |
| Reports and invoice layouts reviewed | Consultant | Week 2 |
| Data migration rehearsed twice | Developer | Week 3 |
| Key users sign the test plan | Consultant | Week 4 |

## Cutover

1. Announce the read-only window to the customer.
2. Run the final data migration and the quality gate.
3. Open production and keep the previous version available for 30 days.

> The quality gate is not optional. A green test run that executed nothing is not a green run.
`,
  },
  {
    id: "openupgrade",
    space: "delivery",
    type: "Guide",
    owner: "Senior developer",
    canon: "Draft",
    review: "Not set",
    updated: "2 weeks ago",
    langs: ["Spanish", "English"],
    explicit: [],
    markdown: `---
title: Data migration with OpenUpgrade
doc_type: guide
owner: Senior developer
---

## When to use it

Use OpenUpgrade for community databases and for the community part of an enterprise database. Rehearse it on a copy
of production at least twice before the cutover.

## Steps

1. Restore the production backup into a staging environment.
2. Run the migration scripts module by module.
3. Compare record counts before and after for the key models.
`,
  },
  {
    id: "methodology",
    space: "delivery",
    type: "Governance",
    owner: "Head of delivery",
    canon: "Verified",
    review: "1 Mar 2027",
    updated: "1 month ago",
    langs: ["Spanish", "English"],
    explicit: [],
    markdown: `---
title: Project methodology
doc_type: governance
owner: Head of delivery
canon_state: verified
---

## Phases

Every implementation goes through analysis, configuration, data, training and go-live. Each phase ends with a
document the customer signs.

## Roles

- **Consultant**: owns the analysis and the configuration.
- **Developer**: owns custom modules and data migration.
- **Delivery lead**: owns the plan and the customer relationship.
`,
  },
  {
    id: "quality-gate",
    space: "delivery",
    type: "Checklist",
    owner: "Delivery lead",
    canon: "Verified",
    review: "1 Feb 2027",
    updated: "5 days ago",
    langs: ["Spanish", "English"],
    explicit: [],
    markdown: `---
title: Quality gate before go-live
doc_type: checklist
owner: Delivery lead
---

## The gate

- Every custom module has tests, and they ran.
- Key flows pass on a copy of production.
- Backups are scheduled and one restore was tested.
- The customer signed the acceptance document.
`,
  },
  {
    id: "sleep",
    space: "platform",
    type: "Reference",
    owner: "Platform team",
    canon: "Maintained by source",
    review: "Follows Git",
    updated: "Synced 1 hour ago",
    langs: ["English"],
    explicit: [],
    markdown: `---
title: Environments and sleep
doc_type: reference
owner: Platform team
---

## What sleeps

Kubernetes environments on development and staging stages go to sleep after a period without use. Production never
sleeps, and Docker environments have no sleep.

- **Light sleep**: Odoo is stopped and the database stays up.
- **Deep sleep**: the database is stopped too.

## Waking an environment

A sleeping environment does not answer. Wake it from Dyncloud Manager or ask the assistant to wake it; waking takes
from a few seconds to a few minutes. Deploys and configuration changes wake the environment on their own and put it
back to sleep afterwards.
`,
  },
  {
    id: "backups",
    space: "platform",
    type: "Reference",
    owner: "Platform team",
    canon: "Maintained by source",
    review: "Follows Git",
    updated: "Synced 1 hour ago",
    langs: ["English"],
    explicit: [],
    markdown: `---
title: Backups and restore
doc_type: reference
---

## Schedule

Production databases are backed up every night and kept for 30 days. A backup can also be taken on demand before a
risky change.

## Restoring

Restores go to a new environment first. Check the restored data before you point the customer to it.
`,
  },
  {
    id: "deploy",
    space: "platform",
    type: "Procedure",
    owner: "Platform team",
    canon: "Maintained by source",
    review: "Follows Git",
    updated: "Synced 1 hour ago",
    langs: ["English"],
    explicit: [],
    markdown: `---
title: Deploying a release
doc_type: procedure
---

## Steps

1. Tag the release in the customer's code repository.
2. Deploy it to staging and run the quality gate.
3. Deploy to production in the agreed window.
`,
  },
  {
    id: "first-week",
    space: "handbook",
    type: "Guide",
    owner: "People team",
    canon: "Verified",
    review: "1 Jun 2027",
    updated: "2 weeks ago",
    langs: ["Spanish", "English"],
    explicit: [{ id: "team-leads", initials: "TL", name: "Team leads", role: "Can edit", tone: "blue" }],
    markdown: `---
title: Your first week
doc_type: guide
owner: People team
---

## Day one

Your team lead walks you through the tools you will use and pairs you with a buddy for the first month.

## By the end of the week

- You can sign in to Dynwork with your governance account.
- You have read the project methodology.
- You have shadowed one customer meeting.
`,
  },
  {
    id: "tools",
    space: "handbook",
    type: "Reference",
    owner: "People team",
    canon: "Draft",
    review: "Not set",
    updated: "1 week ago",
    langs: ["Spanish"],
    explicit: [],
    markdown: `---
title: Tools and accounts
doc_type: reference
owner: People team
---

## Accounts you get

- Dynwork, signed in to the Dynapps governance instance.
- Odoo, with the Knowledge app for this brain.
- GitLab, for code and for documentation that lives in Git.
`,
  },
  {
    id: "writing",
    space: "handbook",
    type: "Governance",
    owner: "Knowledge owner",
    canon: "Verified",
    review: "1 Jan 2027",
    updated: "1 month ago",
    langs: ["Spanish", "English"],
    explicit: [],
    markdown: `---
title: Writing documentation
doc_type: governance
owner: Knowledge owner
---

## Where a document goes

Customer-facing procedures go to Odoo Delivery. Platform references live in Git and appear here as mirrors.
Everything else goes to the handbook.

## Every document exists in Spanish and in English

Spanish governs. The English version is a translation of the same document, not a second document.
`,
  },
]
