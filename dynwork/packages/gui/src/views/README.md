# DynWork views

The screens DynWork adds to the desktop app's main area: Agents, over the routines Ipc, and Brain, on built-in demo
data. They belong to the `dynwork` built-in (`../accounts/index.ts`); its window entry (`../accounts/renderer.ts`) registers them through
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
| `toggle.tsx`  | The on/off rows, apart so the editor can use Solid's own `Switch`                                             |

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
  choices are radios while a lookup is a dropdown;
- Save asks the backend's `validate` first, and each message of an `invalid` failure lands under the field it names. A
  failure that is not about a field, such as a full quota or a signed-out backend, shows above the buttons.

The trigger is written as a cron in an IANA zone (`schedule.ts`: `presetOf`, `cronOf`), a cron a preset would write
differently opens as a custom one so saving never rewrites it, and the preview is Effect's `Cron` in that zone, so it
follows the Madrid changes of 29 March and 25 October. A run set on the hour carries a hint that it can start late.

On a wide window the form is a dialog of up to 760px. Under 768px (the shell's narrow layout, down to a phone near 360px)
it is a sheet over the whole window with the buttons pinned under a scrolling body; the fields sit in a grid of columns of
at least 240px, so a narrow sheet is one column, the trigger's controls take a line each, and the footer keeps clear of the
home indicator. Nothing scrolls sideways.

A store's proxies cannot cross the Ipc: `createFormModel` sends `unwrap(state.draft)`. Bun's tests run Solid's server
build, where a store is a plain object, so only a render with `--conditions=browser` shows that.

## Adding to a view

Each view owns its folder: `<view>/index.tsx` exports the view component as its default, `<view>/en.ts` its strings
(keys start with `<view>.`; `./en.ts` merges them into the plugin's table), and anything else it needs (`demo.ts`,
components, a CSS file) lives beside them. Tests go in `test/views/<view>/`.

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
