// Which channel `desktop.ts` builds and installs: canary by default, to `/Applications/Dynwork Canary.app`. A local
// build is never internal, so it can never replace the app testers rely on.
import { Install } from "../packages/build/src/install"

export const defaultChannel = Install.defaultLocal

export const installTarget = Install.bundle

export function localChannel(argv: readonly string[]) {
  const usage = `expected --channel <${Install.localChannels.join("|")}>`
  const [first, second, ...rest] = argv
  if (first === undefined) return defaultChannel
  if (rest.length > 0) throw new Error(`Unknown argument "${rest[0]}": ${usage}`)
  if (first.startsWith("--channel=")) {
    if (second !== undefined) throw new Error(`Unknown argument "${second}": ${usage}`)
    return Install.choose(first.slice("--channel=".length), Install.localChannels)
  }
  if (first !== "--channel") throw new Error(`Unknown argument "${first}": ${usage}`)
  if (second === undefined || second.startsWith("--")) throw new Error("--channel takes a channel")
  return Install.choose(second, Install.localChannels)
}
