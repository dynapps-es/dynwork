# Upstream patches

Every upstream file DynWork modifies. Keep this list short: each row is a potential conflict on every upstream
release. New files under `dynwork/` are not listed.

| File | Why | Risk on upstream updates |
| --- | --- | --- |
| `package.json` | Adds `dynwork/packages/*` to the workspaces | Low: one line in the workspace list |
| `bun.lock` | Records the `@dynwork/branding` and `@dynwork/gui` workspaces and the desktop dependencies on them | Low: regenerate with `bun install` after resolving `package.json` |
| `packages/desktop/package.json` | Declares `@dynwork/branding` and `@dynwork/gui` (the isolated linker only links declared dependencies) | Low: two dev dependency lines |
| `packages/desktop/src/main/constants.ts` | Prod app name and app id come from `DynWorkIdentity` (sets userData to `es.dynapps.dynwork`) | Low: two map entries and one import |
| `packages/desktop/src/main/lifecycle/environment.ts` | Prod registers the `dynwork` URL scheme; dev and beta keep `opencode` | Low: one call and two imports |
| `packages/desktop/electron-builder.config.ts` | Prod appId, productName, artifactName, protocols, ICNS mac icon (no `actool`), publish feed and rpm package name come from `DynWorkIdentity` | Medium: upstream often edits the prod block and its comments |
| `packages/desktop/electron-builder.config.test.ts` | Prod identity expectations (app id, feed, ICNS mac icon) | Medium: follows every upstream change to the channel tables |
| `packages/desktop/electron.vite.config.ts` | A main and renderer resolve alias bundles `dynwork/packages/branding/theme/dynapps.json` wherever `themes/oc-2.json` is imported, so the default theme (id `oc-2`) is Dynapps in every channel. Renderer aliases swap `@opencode/ui/logo` and `@opencode/ui/wordmark` for the branding package's `src/logo.tsx` and `src/wordmark.tsx`, and the `dynwork:new-session-wordmark` resolve plugin swaps `./wordmark` imported by `packages/app/src/new-session/view.tsx` for `src/new-session-wordmark.tsx` | Low: two constants, three `alias` entries and one plugin. If upstream renames or moves `oc-2.json`, the logo modules, `view.tsx` or its `./wordmark` specifier, the alias or plugin silently stops matching and the build ships the OpenCode theme or logo again (`test/logo.test.ts` checks the specifiers and the exports) |
| `packages/ui/src/theme/themes/oc-2-deep.json` | New symlink to `dynwork/packages/branding/theme/dynapps-deep.json`; the theme picker globs `themes/*.json`, so the file must exist there for "Dynapps Deep" (pure black dark variant) to be listed next to Dynapps | Low: a new file upstream never ships; if upstream renames the themes folder or stops globbing it, the theme silently disappears from the picker |
| `packages/desktop/src/renderer/desktop-app.tsx` | Renders `SignInGate` from `@dynwork/gui/signin` next to `ReadyApp`, inside `AppBaseProviders` for the theme and fonts. The gate covers the window (z-index 90) until the `dynwork-signin` flag exists; the startup splash (z-index 100) still fades only when the app is ready, so it reveals the gate, and the gate's fade reveals the ready app with first-launch onboarding intact | Low: one import and one JSX line. If upstream moves the startup overlay off z-index 100 or stops rendering it above `ReadyApp`, the gate shows before the splash fades or never shows |
