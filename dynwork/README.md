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
| `packages/gui` | `@dynwork/gui`: DynWork's own screens. `src/signin`: the sign-in gate the desktop shows until the device is signed in |
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
git fetch upstream --tags
git rebase --onto <new-tag> <old-tag> main
echo <new-tag> > dynwork/UPSTREAM
git range-diff <old-tag>..<old-main> <new-tag>..main
```

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
bun dynwork/script/smoke.ts [screenshot] [theme-id] [light|dark] [view] [width]
```

The smoke test starts `/Applications/DynWork.app` with its own home, user data, XDG directories, database, config and
background service on a private port, and none of your `OPENCODE_*` variables, so it never attaches to or restarts a
running OpenCode service. It waits for the window, optionally stores a theme id and color scheme
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

Run the app normally from Finder. Its data lives in `~/Library/Application Support/es.dynapps.dynwork`. DynWork and
OpenCode share the `opencode` background service name, so start one of them at a time until that is separated.
