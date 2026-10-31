# DynWork overlay

Everything DynWork adds on top of upstream OpenCode lives in this directory. The branch `main` is an upstream
release tag plus a short stack of `dynwork`-scoped commits, so syncing with upstream means rebasing that stack onto
the next tag.

## Layout

| Path | Contents |
| --- | --- |
| `PATCHES.md` | Every upstream file we modify, why, and the risk on upstream updates |

## Syncing with upstream

```bash
git fetch upstream --tags
git rebase --onto <new-tag> <old-tag> main
git range-diff <old-tag>..<old-main> <new-tag>..main
```
