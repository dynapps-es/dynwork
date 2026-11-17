import { createSignal } from "solid-js"

/**
 * A new task asked for from outside the Scheduled view: the "+" of its sidebar row (`../nav.tsx`) sets it and opens the
 * view, which starts the chat or opens the form as its own New task menu does, then clears it.
 */
export const [newTask, askNewTask] = createSignal<"chat" | "manual">()
