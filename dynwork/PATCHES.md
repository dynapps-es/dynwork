# Upstream patches

Every upstream file DynWork modifies. Keep this list short: each row is a potential conflict on every upstream
release. New files under `dynwork/` are not listed.

| File | Why | Risk on upstream updates |
| --- | --- | --- |
| `package.json` | Adds `dynwork/packages/*` to the workspaces | Low: one line in the workspace list |
| `bun.lock` | Records the `@dynwork/branding` workspace and the desktop dependency on it | Low: regenerate with `bun install` after resolving `package.json` |
| `packages/desktop/package.json` | Declares `@dynwork/branding` (the isolated linker only links declared dependencies) | Low: one dev dependency line |
| `packages/desktop/src/main/constants.ts` | Prod app name and app id come from `DynWorkIdentity` (sets userData to `es.dynapps.dynwork`) | Low: two map entries and one import |
| `packages/desktop/src/main/lifecycle/environment.ts` | Prod registers the `dynwork` URL scheme; dev and beta keep `opencode` | Low: one call and two imports |
| `packages/desktop/electron-builder.config.ts` | Prod appId, productName, artifactName, protocols, ICNS mac icon (no `actool`), publish feed and rpm package name come from `DynWorkIdentity` | Medium: upstream often edits the prod block and its comments |
| `packages/desktop/electron-builder.config.test.ts` | Prod identity expectations (app id, feed, ICNS mac icon) | Medium: follows every upstream change to the channel tables |
