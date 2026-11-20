import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { DrivePresent } from "../../src/drive/present"

// Electron only loads inside Electron: a window and its contents are event emitters here, as they are there, and the
// window records each change of full screen asked of it.

function stand(options: { full?: boolean } = {}) {
  const asked: boolean[] = []
  const contents = new EventEmitter()
  const win = Object.assign(new EventEmitter(), {
    full: options.full ?? false,
    destroyed: false,
    webContents: contents,
    isDestroyed: () => win.destroyed,
    isFullScreen: () => win.full,
    setFullScreen: (full: boolean) => {
      asked.push(full)
      win.full = full
    },
  })
  // SAFETY: `present` uses only these members of a window and its contents.
  const present = DrivePresent.make({ window: (id) => (id === 1 ? (win as unknown as DrivePresent.Window) : undefined) })
  const ended = { done: false }
  const call = new AbortController()
  const run = (window = 1) =>
    present.present(window, call.signal).then(() => {
      ended.done = true
    })
  const key = (input: { type: string; key: string }) => contents.emit("before-input-event", {}, input)
  return { win, contents, asked, call, run, ended, key }
}

describe("Present, in main", () => {
  test("takes the window full screen while the window holds the call, and back when it lets go", async () => {
    const main = stand()
    const done = main.run()
    expect(main.asked).toEqual([true])
    await Bun.sleep(0)
    expect(main.ended.done).toBe(false)
    main.call.abort()
    await done
    expect(main.asked).toEqual([true, false])
    expect(main.win.listenerCount("leave-full-screen")).toBe(0)
    expect(main.contents.listenerCount("before-input-event")).toBe(0)
  })

  test("Escape anywhere in the window ends it; other keys do not", async () => {
    const main = stand()
    const done = main.run()
    main.key({ type: "keyDown", key: "Enter" })
    main.key({ type: "keyUp", key: "Escape" })
    await Bun.sleep(0)
    expect(main.ended.done).toBe(false)
    main.key({ type: "keyDown", key: "Escape" })
    await done
    expect(main.asked).toEqual([true, false])
    // Letting go afterwards changes nothing more.
    main.call.abort()
    expect(main.asked).toEqual([true, false])
  })

  test("the window leaving full screen another way ends it, with nothing more asked", async () => {
    const main = stand()
    const done = main.run()
    main.win.full = false
    main.win.emit("leave-full-screen")
    await done
    expect(main.asked).toEqual([true])
  })

  test("a window the user had full screen stays so", async () => {
    const main = stand({ full: true })
    const done = main.run()
    main.call.abort()
    await done
    expect(main.asked).toEqual([])
    expect(main.win.full).toBe(true)
  })

  test("a window that closes ends it; one that does not exist is not presented", async () => {
    const main = stand()
    const done = main.run()
    main.win.destroyed = true
    main.win.emit("closed")
    await done
    expect(main.asked).toEqual([true])
    const other = stand()
    await other.run(2)
    expect(other.asked).toEqual([])
  })
})
