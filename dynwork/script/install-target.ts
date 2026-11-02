// Where `desktop.ts` installs the bundle: /Applications/DynWork.app by default, or `<dir>/DynWork.app` with `--to <dir>`
// (a leading `~` is the home directory), so a build can live beside another session's installed app.
import { homedir } from "node:os"
import path from "node:path"

export const defaultInstall = "/Applications/DynWork.app"

export function installTarget(argv: readonly string[], home = homedir()) {
  const at = argv.indexOf("--to")
  if (at < 0) return defaultInstall
  const dir = argv[at + 1]
  if (!dir || dir.startsWith("--")) throw new Error("--to takes a directory")
  return path.join(path.resolve(dir.replace(/^~(?=$|\/)/, home)), "DynWork.app")
}
