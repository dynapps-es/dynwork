# Scheduled task templates: the contract between Dynwork and Governance

Governance (the `dynwork-routines` extension of systemprompt-dynapps) and Dynwork implement this same text. The types
are in `contract.ts` (`Template`, `TemplateLink`, `Templates`, `Personal`, `Definition.template`, `Routine.template`)
and the rules of a linked task in `templates.ts` (`RoutinesTemplates.locked`, `violates`, `activate`). A change here
is a change on both sides: say so in both pull requests.

In this version templates run only on this computer (`where: "local"`). `where: "cloud"` is reserved for the Agent
Farm backend (`farm/README.md`, "Templates (in progress)"). Names in code stay `routines`; the UI says "task" and
"Templates".

## 1. A template

A template is a row in Governance. What the desktop receives (`Template`):

```jsonc
{
  "id": "daily-odoo-review", // slug, unique, chosen by the author (console or YAML)
  "revision": 4, // bumps on every publish
  "name": "Daily Odoo review",
  "description": "…", // markdown, short
  "mandatory": false, // true = every person who sees it gets it (§4)
  "where": "local", // only "local" for now; "cloud" is reserved for the Agent Farm
  "definition": {
    // the template's part of Definition (contract.ts)
    "instructions": { "kind": "prompt", "text": "…" }, // or {kind:"skill", skill, text}
    "agent": "build", // optional
    "model": "…", // optional
    "schedule": { "cron": "0 8 * * 1-5" }, // never a timezone (personal)
    "options": {
      "permissions": "ask", // "ask" | "bypass" (bypass only with the controls in §5)
      "connectors": ["dynapps-odoo"], // Governance servers by name; never "all", never a user's own server
      "timeLimit": 30,
      "recover": "recent",
      "catchUp": 6,
      "notify": "failures", // optional defaults
    },
  },
  "locks": {
    "model": false, // true = the user cannot change the model
    "schedule": "free", // "free" | "time" (frequency fixed: cron day/month/weekday fields locked, minute/hour free) | "locked"
    "timeLimitMax": null, // a number = the user may lower timeLimit but not exceed it
  },
  "personal": { "folder": "none", "hint": null }, // folder: "none" | "required"; hint: text shown at activation
}
```

Always locked (never editable on an activated task): `instructions`, `agent`, `where`, `options.connectors`, and
`options.permissions` as a ceiling (the user may go `bypass` → `ask`, never the reverse). Always free: `name`,
`enabled` (pause), `options.recover`, `options.catchUp`, `options.notify`. Never in a template: `schedule.timezone`,
`options.folder` (only `personal.folder` says whether one is needed), the task id, owner device, account and local
state.

## 2. The link on a task

A task created from a template carries `Definition.template = { "id": "<template id>", "revision": <n> }` at the same
level as `name` (not in `options`). Governance derives two columns from it on every write (`template_id`,
`template_revision`) and enforces:

| Write                                 | Rule                                                                    | Error                                               |
| ------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------- |
| `PUT /routines/{id}` creating a link  | at most one live (not deleted) task per `(user, template)`              | `409 {"error":"already_activated","routine":<row>}` |
| `PUT /routines/{id}` on a linked task | the locked fields of §1 equal those of the named revision               | `409 {"error":"template_locked"}`                   |
| `DELETE /routines/{id}`               | refused while the template is `mandatory` for this user and `published` | `409 {"error":"template_mandatory"}`                |

A tombstone keeps `template_id` (column), so the admin sees "deactivated on <date>".

## 3. Routes (under `/api/dynwork/routines/v1`, desktop credential as today)

- `GET /templates` with `If-None-Match` → `304`, or `200` + `ETag` with:

  ```jsonc
  {
    "templates": [Template, …],        // published, visible to the caller (§6), mandatory ones included
    "links": [                         // one per template the caller has a live task of, visible or not
      { "id": "daily-odoo-review", "state": "published" | "closed" | "retired" | "no_access",
        "retire": "unlink" | "pause" | "remove" | null }
    ]
  }
  ```

  `closed` = no new activations, existing tasks stay linked and keep receiving revisions.

- `GET /templates/{id}/revisions/{revision}` → that revision's `Template` (the base of the three-way merge), only for a
  caller who has (or had) a task linked to it.
- `PUT /runs/{id}` unchanged: `id` is the run's OpenCode session id (`ses_…`), which is how Governance finds the
  conversation (§7).
- Change hint: relay frame `{"t":"templates.changed"}`, sent to every connected desktop when a template is published,
  closed or retired. Advisory: Dynwork also re-reads `GET /templates` on every 5-minute sync.

## 4. Mandatory templates

On `GET /templates`, for each **published, mandatory, visible** template the caller has no live task of, Governance
inserts an **unclaimed** task first (`owner_device = ''`, the claim of `local/sync.ts`; definition = the template defaults with
`template = {id, revision}` and no timezone) and emits it in the change feed. The first desktop of that user claims
it as today and, in the same write, fills `schedule.timezone` with its own zone. A mandatory template may not have
`personal.folder = "required"` (publish refuses it) and may not be `bypass` (§5). The person can pause it, never
delete it (§2).

## 5. "Don't ask" (bypass) on a template

Publish refuses `permissions: "bypass"` unless `connectors` is a non-empty list, `personal.folder` is `"required"`
and `mandatory` is false. The activation form asks for an explicit confirmation ("Approved by Dynapps; runs without
asking"). Publishing a bypass template is recorded in the revision history with its author.

## 6. Who sees a template

A template names one or more **anchor plugins** (`plugins TEXT[]`). The caller sees it when the core access resolution
admits at least one of them (`allowed_ids(EntityKind::Plugin, …)` for the subject from `find_user_access_profile`, the
same resolution `TemplateMarketplaceFilter` applies to the bridge manifest). No group tables of our own. Losing every
anchor plugin turns the caller's link into `no_access`.

## 7. Run → recorded conversation

Dynwork stamps every model request of a session with `metadata.user_id = {"session_id": uuidv5(NS, "<ses_…>")}`
(`telemetry.ts` `stamp()`, NS = `7c1f5b6e-3a2d-4e8f-9b0c-2d6a1e4f8c73`, the bridge's), whether governance telemetry is
on or not. Core then records the run as its own conversation: `context_id = ContextId::derived_from_client_session`.
Governance resolves a run's conversation from `(user_id, uuidv5(NS, run id))` through
`canonical_conversation_context()` and links to `/admin/analysis/conversations/{context_id}`. Core is not changed.

## 8. Retiring (admin)

| Mode            | Server does                                                                                       | Desktop does                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Close           | state `closed`                                                                                    | hides it from Templates; linked tasks unchanged                              |
| Retire · unlink | state `retired`, `retire = unlink`                                                                | drops the link, keeps the task as an ordinary one, notice "Template retired" |
| Retire · pause  | as unlink, and writes `enabled = false` on every live linked task (revision bump, change emitted) | notice "Template retired; paused"                                            |
| Retire · remove | as unlink, and tombstones every live linked task                                                  | the task disappears like any deleted task                                    |

The server writes for pause and remove so they apply even to a computer that is off.
