import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { Live } from "@opencode/plugin/gui"
import { DriveClient } from "../../src/drive/client"

describe("the Drive's window connection", () => {
  test("is the live client while the window entry that attached it runs, and goes with it", () => {
    expect(DriveClient.connection()).toBeUndefined()
    const [live] = createSignal({ status: "pending" } as Live<DriveClient.Client>)
    const dispose = createRoot((dispose) => {
      DriveClient.attach(live)
      return dispose
    })
    expect(DriveClient.connection()).toEqual({ status: "pending" })
    dispose()
    expect(DriveClient.connection()).toBeUndefined()
  })

  test("a later entry takes over, and an earlier one leaving does not drop it", () => {
    const [first] = createSignal({ status: "pending" } as Live<DriveClient.Client>)
    const [second] = createSignal({ status: "inactive", reason: "disabled" } as Live<DriveClient.Client>)
    const disposeFirst = createRoot((dispose) => {
      DriveClient.attach(first)
      return dispose
    })
    const disposeSecond = createRoot((dispose) => {
      DriveClient.attach(second)
      return dispose
    })
    disposeFirst()
    expect(DriveClient.connection()).toEqual({ status: "inactive", reason: "disabled" })
    disposeSecond()
    expect(DriveClient.connection()).toBeUndefined()
  })
})
