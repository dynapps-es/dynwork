# DynWork overlay

Everything DynWork adds on top of upstream OpenCode lives in this directory. The branch `main` is an upstream
release tag plus a short stack of `dynwork`-scoped commits, so syncing with upstream means rebasing that stack onto
the next tag.

## Layout

| Path | Contents |
| --- | --- |
| `PATCHES.md` | Every upstream file we modify, why, and the risk on upstream updates |
| `packages/branding` | `@dynwork/branding`: the prod app identity (`src/identity.ts`) that the desktop package reads |
| `packages/branding/theme` | `dynapps.json`: the Dynapps light and dark theme, bundled by the desktop build in place of `oc-2.json` |

## Syncing with upstream

```bash
git fetch upstream --tags
git rebase --onto <new-tag> <old-tag> main
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
