# DynWork views

The screens DynWork adds to the desktop app's main area: Agents, Routines and Brain, on built-in demo data. They belong
to the `dynwork` built-in (`../accounts/index.ts`); its window entry (`../accounts/renderer.ts`) registers them through
`registerViews` (`./register.tsx`), on desktop only.

## How they reach the app

The host has two slots only built-ins fill (`BuiltinSlotMap` in `packages/plugin/src/gui/builtin.ts`), and a layout call
to open a page (`BuiltinLayout.page`):

- `sidebar.nav`: rows after New session in the vertical sidebar, and after Home in the tabs drawer of a window under
  768px, where the host hides the sidebar. `./nav.tsx` renders the rows of `./entries.ts`.
- `page`: the main area of the `/page/:id` route. `./route.tsx` mounts the view whose id the route names.
- `ctx.layout.page(id)` (through `builtinContext`) routes to `/page/<id>`, the way `ctx.layout.settings(page)` opens
  settings. The systemprompt row opens the real Accounts settings page instead of a view.

## Adding to a view

Each view owns its folder: `<view>/index.tsx` exports the view component as its default, `<view>/en.ts` its strings
(keys start with `<view>.`; `./en.ts` merges them into the plugin's table), and anything else it needs (`demo.ts`,
components, a CSS file) lives beside them. Tests go in `test/views/<view>/`.

A view renders `ViewShell` from `./shell.tsx`, reads strings with `usePlugin().t(...)` and opens another view with
`builtinContext(usePlugin()).layout.page(id)` (`layout.page` is not on the public plugin type):

```tsx
<ViewShell
  view="agents"
  title={ctx.t("agents.title")}
  badge={ctx.t("agents.badge")}
  description={ctx.t("agents.description")}
  actions={<Button variant="contrast">{ctx.t("agents.new")}</Button>}
  nav={{ groups, selected: "agents", select: (id) => builtinContext(ctx).layout.page(id) }}
  detail={selected() ? <AgentDetail agent={selected()} /> : undefined}
  detailTitle={selected()?.name}
  onCloseDetail={() => setSelected(undefined)}
>
  <AgentList />
</ViewShell>
```

- **Header.** `title`, an optional `badge` (such as "Agent Farm"), `description`, and `actions` at its end. The shell
  always adds the "Demo data" marker (`DemoBadge`): the views never fetch, call an Ipc or reach the service.
- **Sub-navigation.** `nav` takes groups of rows (`label`, optional `icon` and `count`), the selected row's id, `select`,
  and an optional `footer` under the column. Omit it for a view without one.
- **Detail pane.** The pane shows while `detail` is set; `onCloseDetail` clears it. `detailTitle` is its accessible
  name.
- **Primary buttons.** `Button` with `variant="contrast"` takes the brand color inside the shell: Midnight on light,
  Unicorn Violet on dark.

## Layout by window width

`createViewLayout()` answers from the window width, like the host's own breakpoints, and the shell puts the answer on
`data-layout`:

| Layout   | Width        | Sub-navigation  | Detail pane                                        |
| -------- | ------------ | --------------- | -------------------------------------------------- |
| `wide`   | 1200px or up | Left column     | Third column                                       |
| `medium` | 768–1199px   | Narrower column | Drawer over the content; Close or Escape closes it |
| `narrow` | under 768px  | Select on top   | Replaces the content, with Back                    |

Style a view with plain CSS under `[data-component="dynwork-view"][data-view="<view>"]` and the theme's v2 tokens:
Tailwind does not scan `dynwork/`.
