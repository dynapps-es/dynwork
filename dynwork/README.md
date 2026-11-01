# DynWork overlay

Everything DynWork adds on top of upstream OpenCode lives in this directory. The branch `main` is an upstream
release tag plus a short stack of `dynwork`-scoped commits, so syncing with upstream means rebasing that stack onto
the next tag.

## Layout

| Path | Contents |
| --- | --- |
| `PATCHES.md` | Every upstream file we modify, why, and the risk on upstream updates |
| `packages/branding` | `@dynwork/branding`: the prod app identity (`src/identity.ts`) that the desktop package reads |
| `packages/branding/logo` | `wordmark.svg`: "dynwork" outlined, in `currentColor`. `lockup.svg`: the Dynapps symbol in its gradient left of the wordmark |
| `packages/build` | `@dynwork/build`: the build seam. `src/vite.ts` exports `DynWorkVite`, the aliases and plugins that swap the theme and the logos, which `packages/desktop/electron.vite.config.ts` spreads into its main and renderer plugins. `test/vite.test.ts` fails when an upstream specifier, module or export a swap relies on moves |
| `script/patches.ts` | The patch guard (`bun dynwork/script/patches.ts`, logic in `packages/build/src/patches.ts`). `UPSTREAM` holds the upstream tag the stack sits on |
| `script/sync-upstream.ts` | The upstream sync (logic in `packages/build/src/sync.ts`): rebases the stack onto a newer upstream ref in a throwaway worktree, checks it and writes a report. See "Syncing with upstream" |
| `script/sp-local.ts`, `test/sp-local` | The local systemprompt harness (see "Local systemprompt instances") |
| `packages/gui` | `@dynwork/gui`: DynWork's own screens and main-process helpers. `src/signin`: the sign-in gate the desktop shows until the device is signed in. `src/service.ts`: the layout of DynWork's own background service (see "Background service") |
| `packages/branding/src` | `outline.ts`: the wordmark letters, the symbol and the lockup geometry. `logo.tsx`, `wordmark.tsx` and `new-session-wordmark.tsx`: the Solid components the desktop build uses in place of upstream's logos. `lockup.tsx`: the lockup, ink letters in light and white in dark |
| `packages/branding/theme` | `dynapps.json`: the Dynapps light and dark theme, bundled by the desktop build in place of `oc-2.json`. `dynapps-deep.json`: Dynapps Deep, the same light variant and a pure black dark variant, linked into the upstream theme folder as `oc-2-deep.json` |

## Sign-in

The desktop shows a full-window sign-in screen until this device is signed in to a systemprompt instance
(`packages/gui/src/signin`, mounted by `desktop-app.tsx`, see `PATCHES.md`). It is a visual mock for now: every remote
step goes through `SignInAccounts.Interface`, and `SignInAccounts.mock()` answers each one after a short delay, with no
network. Real systemprompt auth will implement the same interface.

The screen sits under the startup splash, so it appears when the splash fades and the shell keeps loading underneath.
Finishing stores the `dynwork-signin` key (a small JSON with the URL and the chosen instance) in the renderer's
`localStorage`, or in `sessionStorage` when "Keep me signed in on this device" is off, and fades the screen out.
Removing the key shows the screen again on the next launch. While it shows, the gate keeps focus and every keydown
to itself, so app shortcuts do not act on the hidden shell. All copy lives in `copy.ts`.

## Local systemprompt instances

`bun dynwork/script/sp-local.ts up|seed|check|status|code|down` runs two disposable systemprompt 0.76 instances in Docker
(alpha and beta, loopback only, seeded with a user, a PAT, an exchange code and content) so DynWork can be tested against
real servers without touching a Dynapps environment. Setup, what the image needs and the seeded content are in
`test/sp-local/README.md`; the generated secrets stay in the gitignored `test/sp-local/.env.local`.

## Background service

The packaged prod build runs its own OpenCode background service (`opencode serve --service` from the CLI it bundles),
never the one OpenCode.app uses. `DynWorkService.layout` (`packages/gui/src/service.ts`) gives the desktop's
`background-service.ts` and `sidecar-probe.ts` (see `PATCHES.md`) everything that service keeps, all under
`<userData>/service`:

| What | Where |
| --- | --- |
| Registration file (url, pid, version, private password) | `state/opencode/service.json`, through `XDG_STATE_HOME=<userData>/service/state` |
| Config dir (`OPENCODE_CONFIG_DIR`), also the service's own `service.json` settings | `config` |
| Database (`OPENCODE_DB`) | `opencode.db` |
| Port | `127.0.0.1:17495` (`DynWorkIdentity.servicePort`, `0x4457`), never OpenCode's `0xC0DE` |

DynWork only looks for its service at that registration file, so it never adopts, stops or replaces OpenCode.app's
service, whatever its version, and OpenCode.app never finds DynWork's. Before the service starts, main drops every
`OPENCODE_CONFIG*` variable the login shell exported (`DynWorkService.isolate`), so the user's own OpenCode config
(`~/.config/opencode`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`) never configures it. `layout` takes an optional
config object that reaches the service as `OPENCODE_CONFIG_CONTENT`: the extension point for DynWork's server plugin.
Dev, beta and local builds keep upstream's shared service.

The service's data dir (`XDG_DATA_HOME`: logs, snapshots, worktrees, tool output, artifacts) is userData itself, so
its logs land in `<userData>/opencode/log`, where the desktop's debug-log export already looks. Since the data dir is
DynWork's own, a new DynWork database never imports OpenCode.app's legacy `auth.json` provider
keys. Still shared with OpenCode.app: the cache dir; the service also still reads skills from `~/.claude` and
`~/.agents`, like any OpenCode service. Shells the service runs see `XDG_STATE_HOME` and `XDG_DATA_HOME` under
DynWork's userData.

## Patch guard

```bash
bun dynwork/script/patches.ts
```

Compares `HEAD` against the tag in `dynwork/UPSTREAM` (so commit first; the working tree is not read) and prints one
row per upstream file that differs, outside `dynwork/` and `plans/`. It exits 1 when a changed file has no row in
`PATCHES.md`, when a row lists a file that no longer differs, or when the modified upstream files change more lines than
the `Budget:` line of `PATCHES.md` allows. The tag must be in the clone (`git fetch upstream tag v2.2.5`). The `dynwork`
workflow (`.github/workflows/dynwork.yml`) runs it on every push and pull request to `main` and `sp-auth-sync`, with the
tests and typechecks of every `dynwork/packages/*`; upstream's own workflows are disabled on the fork.

## Syncing with upstream

```bash
bun dynwork/script/sync-upstream.ts <target-ref> [--report <path>] [--from <ref>] [--no-build] [--quick] [--keep]
```

The sync script (logic in `packages/build/src/sync.ts`) runs `git fetch upstream --tags`, adds a detached worktree of
`--from` (default `main`) under the system temp dir and runs `git rebase --onto <target-ref> $(cat dynwork/UPSTREAM)`
there. It never pushes, never moves a branch (the rebase runs on a detached HEAD with `rebase.updateRefs` off) and never
touches this checkout. On a conflict it records the conflicted files and the DynWork commit that hit them, then aborts.
On a clean rebase it writes the target to the worktree's `dynwork/UPSTREAM` (committed when the target is a tag, the
target's commit hash and uncommitted otherwise, so the guard measures the stack against its new base), installs with
the npmjs.org registry, and runs the patch guard, `bun run test` and `bun run typecheck` in every `dynwork/packages/*`,
the desktop typecheck and the desktop bundle (`electron-vite build`, nothing packed, installed or launched).

It prints a Markdown report, or writes it to `--report`: target, base, source, the per-step results with timings, the
output of failed steps, the patch guard table, the stack and the `git range-diff` of the old stack against the rebased
one. Exit codes: 0 green, 2 conflicts, 1 a check failed. `--no-build` skips the desktop bundle, `--quick` runs only the
rebase and the patch guard, `--no-fetch` skips the fetch, and `--keep` keeps the worktree, whose path is in the report;
otherwise it is removed.

Production follows upstream tags; any ref works for a rehearsal (`bun dynwork/script/sync-upstream.ts upstream/dev`).
When the report is green on a tag, the kept worktree's `HEAD` is the new `main`: review the range-diff, then move `main`
there by hand.

## Icons

`packages/branding/icons/source.svg` is the only hand-edited icon file: the Dynapps symbol (the gradient path of the
brand skill's `Dynapps_Logo_Vertical_Color_White.svg`) centered on a Midnight squircle in the macOS Big Sur grid. Every
other file in that folder is generated and committed. Regenerate them after changing the source:

```bash
cd dynwork/packages/branding
bun run icons
```

This needs `rsvg-convert` (`brew install librsvg`) and `iconutil` (macOS). Each size is rendered straight from the SVG,
so the output is deterministic and never downsampled.

## Logo

The wordmark follows the Dyncloud one (`cloud_theme/static/description/dyncloud.svg`): the word in lowercase, Readex Pro
SemiBold (600), no tracking and no kerning, one solid color, no symbol. Outlining "dyncloud" in each static Readex Pro
weight and fitting it to that SVG gives SemiBold at about 31.85 px with zero extra spacing between letters (glyph
positions within 0.01 px without kerning, 0.16 px off with it; `l` stem 4.52 px against 4.51 px).

`logo/wordmark.svg`, `logo/lockup.svg` and the letters in `src/outline.ts` were outlined once, outside the repo, from
`ReadexPro-SemiBold.ttf` (Readex Pro 1.204, OFL, from the `dynapps-brand` skill's fonts) with opentype.js 1.3.4 at
200 px, no kerning, one path per letter, moved to a tight `0 0 867 194` box (baseline at 148). The static font keeps
overlapping contours, which a stroked outline would show, so each letter went through Skia PathOps `simplify`
(pathkit-wasm 1.0.0) and was rounded to two decimals. Nothing reads the font at runtime. The lockup reuses the symbol
path and gradient of `icons/source.svg` at the proportions of `cloud_theme/static/img/login/dyncloud-logo.png`, whose
ascender is also 148 px: a 243.5 px symbol centred 190 px left of the "d" and 91.5 px below the ascender line.

The desktop build (`packages/build`) swaps three upstream modules for the components in `src/` (see `PATCHES.md`):

| Upstream | DynWork |
| --- | --- |
| `@opencode/ui/logo` `Mark`, `Splash` | `src/logo.tsx`: the Dynapps symbol in its brand gradient (the pulsing startup splash, the side panel placeholder) |
| `@opencode/ui/logo` `Logo` | `src/logo.tsx`: the wordmark in `--icon-base` (the error page) |
| `@opencode/ui/wordmark` `Wordmark` | `src/wordmark.tsx`: the wordmark with upstream's outline, fade and muted modes (the first-launch splash draws it, the server connect screen) |
| `new-session/wordmark.tsx` `NewSessionWordmark` | `src/new-session-wordmark.tsx`: the wordmark at rest, in the place and opacity of upstream's; the lodger, pin board and brick breaker easter egg is off |

Tailwind only scans upstream folders, so these components style themselves with SVG attributes, inline styles and
`src/wordmark.css`, never with utility classes of their own. The settings About page keeps upstream's animated OpenCode
wordmark.

## Build and install on macOS

Builds DynWork for Apple Silicon from this checkout and installs it as `/Applications/DynWork.app`. It needs the
workspace installed (`BUN_CONFIG_REGISTRY=https://registry.npmjs.org/ bun install`), Bun 1.4.4 and the Xcode command
line tools. The result is unsigned apart from an ad-hoc signature, so it only runs on the Mac that built it.

```bash
bun dynwork/script/desktop.ts
```

The script builds the CLI for this machine from `packages/cli` (release channel, version taken from
`packages/desktop/package.json`), builds the desktop app on the prod channel, swaps in
`dynwork/packages/branding/icons` before packing, signs ad hoc, clears quarantine and replaces
`/Applications/DynWork.app`. It never touches `/Applications/OpenCode.app`. A run takes about a minute.

To check the installed app, launch it in a throwaway profile:

```bash
bun dynwork/script/smoke.ts [screenshot] [theme-id] [light|dark] [view] [width] [--with-foreign-service]
```

The smoke test starts `/Applications/DynWork.app` with its own home, user data, XDG directories, database and config,
and none of your `OPENCODE_*` variables, so it never attaches to or restarts a running OpenCode service. DynWork's own
service runs inside that profile on its fixed port, so the smoke fails at once when a DynWork is already running. It
also exports an `OPENCODE_CONFIG_CONTENT` the way a login shell would and fails if DynWork's service loaded it.
`--with-foreign-service` first starts an `opencode serve --service` from this checkout, with another version string, at
the profile's default registration, as OpenCode.app's service would be; once DynWork is ready the smoke fails unless
that service still runs with the same pid and DynWork registered its own service under its userData. The output's
`service` key reports both. It waits for the window, optionally stores a theme id and color scheme
and reloads (for example `oc-2-deep dark`), saves a screenshot (by default to
`plans/done/2026-10-dynwork-pilot/docs/smoke.png`), prints the theme colors read from the page, then stops only the
processes it started and deletes the profile. It exits non-zero if the window never appears.

The view defaults to home, which stores the sign-in flag and reloads. `signin` shoots the sign-in screen at step 1,
`signin-choose` at step 2, `signin-finalizing` while it syncs and `signin-done` the app after it fades; each drives the
screen with the keyboard over CDP. A width in CSS pixels (for example `800`) shoots the window at that width.
`new-session` starts as a fresh install, which opens on the new session screen, signs in through the sign-in screen
and applies the theme live instead of reloading, since a reload would land on home. `first-launch` shoots the first-launch splash
once its wordmark has drawn, before any theme can be stored. A fresh install runs the first-launch onboarding, which
may create `Default Project` in your real `~/Documents` (Electron reads it from macOS, not from `HOME`).

Run the app normally from Finder. Its data lives in `~/Library/Application Support/es.dynapps.dynwork`, its background
service's in the `service` folder inside it (see "Background service"), so DynWork and OpenCode run side by side.
