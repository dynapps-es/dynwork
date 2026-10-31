# DynWork

DynWork is Dynapps' desktop app: a fork of OpenCode V2 Desktop (`anomalyco/opencode`) that will bring together
systemprompt, dynbrain and the Agent Farm. This checkout is the project's monorepo.

@AGENTS.md

## Rules for this fork

- Talk to the user in Spanish. Everything in the repository is English: code, comments, docs, commits.
- Write code exactly the way upstream developers do: follow `AGENTS.md` and the `AGENTS.md` of each package you touch.
- Our code lives under `dynwork/`. New files never conflict with upstream.
- Touch an upstream file only when there is no other way, with the smallest possible diff, and record it in
  `dynwork/PATCHES.md`. Never change OpenCode core behavior (server, sessions, tools, TUI).
- `main` is the upstream release tag plus our commits. `dev` mirrors upstream and is never committed to.
- Commits use the upstream convention with the `dynwork` scope, for example `feat(dynwork): add tenant picker`.
- Never push to `anomalyco/opencode`. Never run upstream release or publish workflows.
- `plans/` holds the local development plans (dev-plan). It is excluded from git and never pushed.
