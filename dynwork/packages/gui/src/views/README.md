# DynWork views

The screens DynWork adds to the desktop app's main area: Agents, over the routines Ipc, and Brain, on built-in demo
data; and the Runs panel, beside a routine's conversation. They belong to the `dynwork` built-in (`../accounts/index.ts`); its window entry (`../accounts/renderer.ts`) registers them through
`registerViews` (`./register.tsx`), on desktop only.

## How they reach the app

The host has two slots only built-ins fill (`BuiltinSlotMap` in `packages/plugin/src/gui/builtin.ts`), and a layout call
to open a page (`BuiltinLayout.page`):

- `sidebar.nav`: rows after New session in the vertical sidebar, after Home in the tabs drawer of a window under
  768px (where the host hides the sidebar), and icon buttons after Search in the horizontal titlebar, which has no
  sidebar; `place` says which. `./nav.tsx` renders the entries of `./entries.ts`.
- `page`: the main area of the `/page/:id` route. `./route.tsx` mounts the view whose id the route names.
- `ctx.layout.page(id)` (through `builtinContext`) routes to `/page/<id>`, the way `ctx.layout.settings(page)` opens
  settings.

The sidebar has two rows: Agents and Brain. The governance accounts are reached from Settings only, and no visible string
names the platform behind them.

## Agents

One list of routines, local and remote together (`./agents`), read from the `dynwork.routines` Ipc through
`RoutinesClient` (`../routines`); the view never reaches a backend and holds no data of its own. `Capabilities` decide
everything a backend changes: the Local and Remote chips (`kind`), the status line (`label`, `status`, `quota`), the
actions it allows and why not, and the detail's facts (`fields`). The `routines` page is the same view filtered to Local,
kept so its route and the Agents row's highlight still work.

| File          | Role                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| `index.tsx`   | The view: header and status line, the tabs, the detail page, the run viewer in the drawer; it watches the Ipc |
| `model.ts`    | The state over the Ipc: filters, selection, each routine's runs, Activity, the viewer, actions                |
| `routine.ts`  | Pure reads of a routine and its capabilities: status tag, filters, allowed actions, the detail's facts        |
| `schedule.ts` | A cron in words, and its next runs in its zone (Effect `Cron`)                                                |
| `format.ts`   | Times, durations, costs, instructions and the status line as copy                                             |
| `list.tsx`    | The toolbar, the cards, Templates and Activity                                                                |
| `detail.tsx`  | A routine's detail: the same layout for both kinds                                                            |
| `viewer.tsx`  | A remote run, read only: result, usage, log tail                                                              |
| `form.ts`     | The form's state: the draft, its `Definition`, the problems of a save, the save over the Ipc                  |
| `fields.ts`   | How a backend's `capabilities().fields` are drawn: the control of each kind, `when`, the form's blocks        |
| `editor.tsx`  | The form in the app's dialog (`editor.css`): common fields, then the backend's, drawn from its fields         |

How it holds at each width (containers decide, not the window, because the drawer and the host's sidebar change the
room): the cards fill columns of at least 300px and drop to one; the toolbar wraps, with status and search on their own
row in a narrow window; the detail's two columns stack under 720px of its own width; Activity rows fold the where badge
and the time under the name under 560px; the run viewer is the shell's drawer, 520px wide, and the whole pane with Back
in a narrow window. Nothing scrolls sideways; long names, paths and logs wrap or ellipsize.

### The routine form

New routine and Edit open one form, in the app's dialog, for both kinds. The common fields are written in `editor.tsx`
(where it runs, name, instructions with agent and model where the backend takes them, trigger with its zone and the next
three runs, Active); the rest is drawn from `capabilities().fields` and nothing else:

- `workspace`, `permissions`, `plugins` and `limits` make the backend's own block; any other section the backend invents
  makes a second block (dashed for a remote backend), so the farm adds options without the form changing;
- `advanced`, `notifications` and `connectors` are the tabs of the advanced settings;
- each `Field.kind` has a control (`fields.ts`: `control`), a `when` hides a field and its value with it, and a few fixed
  choices are radios while a lookup is a dropdown; a multiselect such as the connectors is a row per choice with a switch;
- the instructions are one box, as Claude's task form draws it: the text, and under a hairline a footer with the local
  permission mode (`fields.ts`: `layout().prompt`) and the agent on the left and the model on the right, each a compact
  select with the composer chip's look (`prompt-select.tsx`, `@opencode/ui/select` loaded on the client only); the
  chosen mode's warning shows under the box;
- every control is the app's own (`@opencode/ui` or `ctx.ui`): `ctx.ui.Select` and `ctx.ui.Switch` as Settings uses
  them, `RadioGroup`, `SegmentedControl`, `Tabs`, `Checkbox`, `TextInput`, `Textarea`. A short control sits on the right
  of its label and hint, as a Settings row (`fields.ts`: `inline`); one with long content takes the width under them;
- Save asks the backend's `validate` first, and each message of an `invalid` failure lands under the field it names. A
  failure that is not about a field, such as a full quota or a signed-out backend, shows above the buttons.

The trigger is written as a cron in an IANA zone (`schedule.ts`: `presetOf`, `cronOf`), a cron a preset would write
differently opens as a custom one so saving never rewrites it, and the preview is Effect's `Cron` in that zone, so it
follows the Madrid changes of 29 March and 25 October. A run set on the hour carries a hint that it can start late.

On a wide window the form is a dialog of up to 760px. Under 768px (the shell's narrow layout, down to a phone near 360px)
it is a sheet over the whole window with the buttons pinned under a scrolling body; the rows stack one under another, a
row's control drops under its label under 480px, and the footer keeps clear of the home indicator. Nothing scrolls
sideways.

The app's `Select` and `Menu` run browser-only code as soon as they load, and Bun's tests import the view with Solid's
server build: the row selects come through `ctx.ui.Select`, which the app renders, and the instructions box's selects and
the New routine menu are loaded on the client only (`prompt-select.tsx`, `new-menu.tsx`). That select treats an empty
value as no selection, so a blank choice such as "Default" travels under its own key (`fields.ts`: `selectChoices`).

A store's proxies cannot cross the Ipc: `createFormModel` sends `unwrap(state.draft)`. Bun's tests run Solid's server
build, where a store is a plain object, so only a render with `--conditions=browser` shows that.

### Opening a local run

A run read in a session (`conversation.kind === "session"`, every local run) is a link to its session's route,
`/server/<base64url server>/session/<id>` (`../runs/model.ts`: `runHref`, the same route as the app's `sessionHref`). The
desktop's router follows a same-origin link in place, and its route machine opens a child session inside its root's tab,
so a run opens under its routine's anchor with the breadcrumb "Routine › Run". History and Activity rows are such links,
and Open conversation goes to the newest run, or to the anchor before any run (`routineHref`). Remote runs still open in
the viewer.

## Runs

The Runs panel (`./runs`, docs/04-ui.md §A.3.3) sits in the session's side region on a local routine's conversation: its
anchor session and each run, which is a child session of the anchor. It is a `Panel` with one pinned tab, listed only
while the routed session belongs to a routine that exists: by the session's `metadata.dynwork` (`{ backend, routine,
role }`, written by the local backend), else by the routines' state until the metadata has loaded. The first time a window
routes such a session, the panel opens beside it (`ctx.layout.open(..., { tab: "select", background: true })`); on a
narrow window it is an entry of the More drawer.

| File        | Role                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| `model.ts`  | Which sessions are a routine's (`marker`, `routineOf`), the links, the runs by day, and the panel's state and actions |
| `panel.tsx` | The panel: the routine in a line with Run now, Pause or Resume and Edit, and the runs by day                          |
| `runs.css`  | One column that wraps at any width                                                                                    |
| `en.ts`     | Its strings                                                                                                           |

- Each run shows its mark, its time, its state and duration, and an unread dot. A run is a link that opens it in place;
  the routed run is highlighted.
- A run on screen that has finished is marked read: the routines Ipc's `viewed`, which marks the run's session viewed
  at its `time.idle` (upstream marks only the root session viewed, never a child).
- A run is continued in place. Upstream gives a child session no composer, only the subagent bar; a run's session has
  `metadata.conversation: true`, which DynWork's patch (`packages/app/src/session/subagent.ts`) reads to give it the
  app's standard composer, with attachments, the agent and model pickers and commands, and its timeline's revert and
  fork. The panel has no reply box of its own, and no "Open as a chat": the timeline's fork already copies a run into a
  top-level conversation.
- Edit opens the routine's detail in the Agents view (`../agents/focus.ts`), where the form is.

Not seen in a real window yet (phase 06 of the plan): that a link from a plugin opens the child in the anchor's tab, that
`metadata` reaches the window's session data, that the panel opens the first time, and the layout at each width.

## Adding to a view

Each view owns its folder: `<view>/index.tsx` exports the view component as its default, `<view>/en.ts` its strings
and `<view>/es.ts` the same keys in Spanish (keys start with `<view>.`; `./en.ts` and `./es.ts` merge them into the
plugin's tables), and anything else it needs (`demo.ts`, components, a CSS file) lives beside them. Tests go in
`test/views/<view>/`; `test/ui/es.test.ts` fails when a key or a `{{param}}` is missing from either language.

Spanish is Spain Spanish with "tú", short and plain: a scheduled task is a "tarea programada", a run an "ejecución",
and Governance, Brain, Dynwork and Cloud keep their names. Text main writes for a window (a backend's field
labels, a failure) stays English in main and is listed in `../routines/i18n/en.ts`, with its Spanish in `es.ts`; the
window shows it through `fromMain` (`agents/format.ts`).

A view renders `ViewShell` from `./shell.tsx`, reads strings with `usePlugin().t(...)` and opens another view with
`builtinContext(usePlugin()).layout.page(id)` (`layout.page` is not on the public plugin type):

```tsx
<ViewShell
  view="brain"
  title={ctx.t("brain.title")}
  badge={ctx.t("brain.badge")}
  description={ctx.t("brain.description")}
  actions={<Button variant="contrast">{ctx.t("brain.new")}</Button>}
  nav={{ groups, selected: "brain", select: (id) => builtinContext(ctx).layout.page(id) }}
  detail={selected() ? <DocumentDetail document={selected()} /> : undefined}
  detailTitle={selected()?.name}
  onCloseDetail={() => setSelected(undefined)}
>
  <DocumentList />
</ViewShell>
```

- **Header.** `title`, an optional `badge` (such as "Agent Farm"), `description`, a `status` line under it, and
  `actions` at its end. The shell adds the "Demo data" marker (`DemoBadge`) unless `demo={false}`: Brain is built-in
  data; Agents reads the routines Ipc and drops it. `header={false}` hides the header for a page that draws its own.
- **Sub-navigation.** `nav` takes groups of rows (`label`, optional `icon` and `count`), the selected row's id, `select`,
  and an optional `footer` under the column. Omit it for a view without one.
- **Detail pane.** The pane shows while `detail` is set; `onCloseDetail` clears it. `detailTitle` is its accessible
  name. It is a drawer over the content, so opening it never squeezes the content; tables still follow their own
  width with container queries.
- **Primary buttons.** `Button` with `variant="contrast"` takes the brand color inside the shell: Midnight on light,
  Unicorn Violet on dark.

## Layout by window width

`createViewLayout()` answers from the window width, like the host's own breakpoints, and the shell puts the answer on
`data-layout`:

| Layout   | Width        | Sub-navigation  | Detail pane                                                   |
| -------- | ------------ | --------------- | ------------------------------------------------------------- |
| `wide`   | 1200px or up | Left column     | Drawer over the content; Close, the scrim or Escape closes it |
| `medium` | 768–1199px   | Narrower column | Drawer over the content; Close, the scrim or Escape closes it |
| `narrow` | under 768px  | Select on top   | Replaces the content, with Back                               |

Style a view with plain CSS under `[data-component="dynwork-view"][data-view="<view>"]` and the theme's v2 tokens:
Tailwind does not scan `dynwork/`.

## The macOS sidebar material

On macOS 26 and later the desktop window shows AppKit's sidebar glass, as Claude desktop does. `./glass/glass.ts` runs
in the main process (the `dynwork` built-in's main entry) and loads `./glass/glass.mm`, an addon that
`@dynwork/build`'s vite plugin compiles for both Mac architectures next to the main bundle. The addon puts an
`NSSplitViewController` behind the page, its sidebar spanning the whole window, over a solid colour (black in dark,
`#fafafa` in light, following `nativeTheme`): the glass takes the desktop picture's tint and never the windows behind.
Electron's material comes off while the glass is on. On older macOS, or when the addon does not load, the window keeps
Electron's `sidebar` vibrancy in its inactive look, which also takes the desktop picture's tint (`platformFrame` in
`packages/desktop/src/main/windows/defaults.ts`).

`registerViews` marks the root with `data-vibrancy`. Only the shell's chrome paints `--v2-background-bg-deep`: the frame
around the panels, the sidebar, the titlebar and its tabs. `./vibrancy.css` makes that token transparent across the
shell, so the sidebar and the frame show the same material in every theme and layout; with Reduce transparency the
shell's root paints the theme's color instead. What sits over the panels gets the opaque color back (the panels, the
peeking sidebar, the narrow window's drawer). The sign-in screen's brand column gets the same material. Windows and
Linux keep the opaque window.
