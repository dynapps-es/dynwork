# Bringing OpenCode's upstream into DynWork

The recurring process to bring `anomalyco/opencode` commits into DynWork's `main`, so DynWork follows OpenCode v2
development. David asks for it in words like "mergea los commits de opencode", "sincroniza con upstream" or "ponte al
día con OpenCode". Run it end to end: merge, check, PR, merge the PR, build and install, report.

## Rules

- Never push to `anomalyco/opencode`, never run its release or publish workflows, never commit to `dev`.
- Never rewrite `main`: no rebase of `main`, no force push. Upstream comes in as a merge commit through a PR.
- Touch an upstream file only to keep a DynWork seam working, with the smallest diff, and keep `dynwork/PATCHES.md`
  true (the patch guard enforces it).
- Branches other sessions work on (for example `mobile`) are theirs: tell them `main` moved, never rebase them.

## Steps

1. **Pick the target.** `git fetch upstream --tags`. Compare `dynwork/UPSTREAM` with the newest `v2.*` tag
   (`git tag -l "v2.*" --sort=-v:refname | head -1`) and with `upstream/dev`. Take the newest tag when it is newer than
   `dynwork/UPSTREAM`; otherwise take `upstream/dev`, which is what David asked for to follow development. Count the
   commits: `git rev-list --count $(cat dynwork/UPSTREAM)..<target>`. Nothing new: say so and stop.
2. **Work in a throwaway worktree**, never in the checkout David uses:
   `git worktree add -b upstream-sync <scratchpad>/upstream-sync origin/main`, then inside it
   `git -c merge.conflictstyle=zdiff3 merge --no-ff --no-commit <target>`.
3. **Resolve the conflicts** (`git status --short | grep '^UU'`). Keep upstream's new shape and put the DynWork seam back
   on top; read upstream's version of the file (`git show <target>:<path>`) before editing. `bun.lock`: take upstream's
   (`git checkout --theirs bun.lock`) and regenerate it in step 5. The usual hot spots, all listed in `PATCHES.md`:
   - `packages/desktop/src/main/service/background-service.ts` and `sidecar-probe.ts`: DynWork's own service layout
     (`DynWorkService.layout`: registration file, `env`, `args`, `isolate`).
   - `packages/app/src/shell/titlebar/titlebar.tsx`: the three `sidebar.nav` slots and the `page` route case.
   - `packages/desktop/src/renderer/desktop-app.tsx`: the `SignInGate` line.
   - `packages/gui-plugins/src/main.ts`, `renderer.ts` and the README copies of both lists: the `dynwork` entry and
     `pairing` with `os: []`.
   - `packages/desktop/electron-builder.config.ts`: the prod identity, the Icon Composer icon and the server plugin
     resource.
4. **Move the base.** Write the target to `dynwork/UPSTREAM`: the tag name for a tag, the full commit hash otherwise
   (`git rev-parse upstream/dev`).
5. **Install** with the public registry: `BUN_CONFIG_REGISTRY=https://registry.npmjs.org/ bun install`.
6. **Commit the merge** with `chore(dynwork): merge upstream <tag or dev (short hash)> ...`, listing each conflict and
   how it was resolved, and the trailers.
7. **Check**, in this order, all from the worktree:
   - `bun dynwork/script/patches.ts` (it reads committed files, so after step 6): every differing upstream file has a
     row and the budget holds. Fix `PATCHES.md` rows when upstream moved or renamed a patched file.
   - `bun run check --force` from the root.
   - `bun run test` in each `dynwork/packages/*`, and `bun test` in `packages/desktop` and `packages/gui-plugins`.
     Never run tests from the repository root.
   - Grep the merged code for anything new that could reach OpenCode.app's own service or config from DynWork: new
     `opencode service` calls, new paths under `~/.config/opencode` or the default `XDG_*` state. DynWork must only
     ever touch its own profile.
8. **PR and merge.** Push the branch, `gh pr create --repo dynapps-es/dynwork --base main`, with the target, the commit
   count, the conflicts and the check results. When CI ("patch guard and tests") is green, `gh pr merge --merge` (a
   merge commit: never squash or rebase, which would flatten upstream's history).
9. **Build and install** from the updated `main`: `bun dynwork/script/desktop.ts` (needs full Xcode for the icon). It
   replaces `/Applications/DynWork.app` and leaves no other copy. Quit DynWork first; the first launch after an install
   may ask for the Keychain, which David approves.
10. **Smoke it live** (Playwright over CDP with `noDefaults: true`, DynWork launched with
    `--remote-debugging-port`): the app signs in, the Agents and Brain views open, a row opens the drawer and Escape
    closes it, Cmd+, opens Settings from a view, Settings shows Governance and no Pairing. Confirm
    `~/.config/opencode/service.json` did not change and no service runs under OpenCode's default registration.
11. **Clean up and report.** Remove the worktree (`git worktree remove`). Tell the sessions with their own branches that
    `main` moved. Report to David in Spanish: target and commit count, conflicts and how they were solved, notable
    upstream changes (`CHANGELOG.md`), checks, PR, and what was installed.

`bun dynwork/script/sync-upstream.ts <ref> --quick` (see the README) still works as a rehearsal that lists conflicts
on a rebased copy, but the merge above is how `main` moves.
