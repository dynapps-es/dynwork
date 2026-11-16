import { describe, expect, test } from "bun:test"
import { device } from "../../src/views/device"
import en from "../../src/views/en"

// A window context as far as `device` reads it: the real English table and the desktop's OS (none on the web).
function setup(os?: "macos" | "windows" | "linux") {
  const ctx = {
    t: (key: string, params?: Record<string, string>) =>
      ((en as Record<string, string>)[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => params?.[name] ?? ""),
    desktop: os ? { os } : undefined,
  }
  // SAFETY: `device` reads only `t` and `desktop.os`.
  return ctx as never as Parameters<typeof device>[0] & typeof ctx
}

describe("this computer's name", () => {
  test.each([
    ["macos", "This Mac", "this Mac"],
    ["windows", "This PC", "this PC"],
    ["linux", "This computer", "this computer"],
    [undefined, "This computer", "this computer"],
  ] as const)("on %s it is %s", (os, label, inline) => {
    expect(device(setup(os))).toEqual({ label, inline })
  })

  test("reaches the Agents view's description", () => {
    const ctx = setup("windows")
    expect(ctx.t("agents.description", { device: device(ctx).inline })).toContain("Local routines run on this PC")
  })
})
