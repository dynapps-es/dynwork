import type { Context } from "@opencode/plugin/gui"

/**
 * This computer as the views name it: "This Mac", "This PC" or "This computer" as a label, and the same in lowercase
 * inside a sentence. Windows other than desktop ones have no `desktop`, and read as a computer.
 */
export function device(ctx: Pick<Context, "desktop" | "t">) {
  const os = ctx.desktop?.os ?? "linux"
  return { label: ctx.t(`views.device.${os}`), inline: ctx.t(`views.device.${os}.inline`) }
}
