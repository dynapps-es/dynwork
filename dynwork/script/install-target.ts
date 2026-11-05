// Where `desktop.ts` installs the bundle: /Applications/Dynwork.app by default, or `<dir>/Dynwork.app` with `--to <dir>`
// (a leading `~` is the home directory), so a build can live beside another session's installed app.
import { homedir } from "node:os"
import path from "node:path"
import { DynWorkIdentity } from "../packages/branding/src/identity"

const bundle = `${DynWorkIdentity.name}.app`

export const defaultInstall = path.join("/Applications", bundle)

export function installTarget(argv: readonly string[], home = homedir()) {
  const at = argv.indexOf("--to")
  if (at < 0) return defaultInstall
  const dir = argv[at + 1]
  if (!dir || dir.startsWith("--")) throw new Error("--to takes a directory")
  return path.join(path.resolve(dir.replace(/^~(?=$|\/)/, home)), bundle)
}
