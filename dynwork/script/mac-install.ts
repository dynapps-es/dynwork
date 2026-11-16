// The step `install.ts` and `desktop.ts` share: put a built app in place as its channel's app in /Applications. Only the
// channel's own app is quit and replaced; no other channel's app or service is touched.
import { $ } from "bun"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { DynWorkIdentity } from "../packages/branding/src/identity"
import { Install } from "../packages/build/src/install"

export const lsregister =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

/** Quits the channel's app, replaces its bundle with `source` and makes Launch Services know the installed one. */
export async function installBundle(channel: DynWorkIdentity.Channel, source: string) {
  const target = Install.bundle(channel)

  await quit(channel)
  await mkdir(path.dirname(target), { recursive: true })
  await rm(target, { recursive: true, force: true })
  await $`ditto ${source} ${target}`
  await $`xattr -cr ${target}`
  await $`${lsregister} -f ${target}`.nothrow().quiet()

  return target
}

/** Asks the channel's app, by bundle id, to quit and waits for it to; it fails if the app is still open after 30 s. */
async function quit(channel: DynWorkIdentity.Channel) {
  const running = async () =>
    (await $`osascript -e ${Install.runningScript(channel)}`.nothrow().text()).trim() === "true"
  if (!(await running())) return

  await $`osascript -e ${Install.quitScript(channel)}`.nothrow().quiet()

  const deadline = Date.now() + 30_000
  while (await running()) {
    if (Date.now() > deadline)
      throw new Error(`${DynWorkIdentity.table[channel].name} is still open: close it and run this again`)
    await Bun.sleep(250)
  }
}
