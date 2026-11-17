// The app's chat composer for built-ins that hold a conversation the app's server does not run, such as DynWork's cloud
// chats: the session screen's composer, drawn by the host, over a send, a stop and a list of models the built-in owns.
// For workspace imports only, like `builtin.ts`.

import type { JSX } from "solid-js"
import type { Ui } from "./host-apis.js"

/** A model the chat composer's model chip offers. */
export interface BuiltinChatModel {
  /** The model's id at its provider. */
  readonly id: string
  /** The provider's id. */
  readonly providerID: string
  /** The model's display name. */
  readonly name: string
  /** The provider's display name. */
  readonly provider: string
}

/** What the chat composer shows and does. Every field is read reactively. */
export interface BuiltinChatComposerProps {
  /** A reply is running: the send button stops it, and a new prompt waits for it. */
  readonly working: boolean
  /** False while nothing can be sent, such as signed out or offline. Defaults to true. */
  readonly available?: boolean
  /** The empty draft's hint. Defaults to the session composer's, which names commands and mentions. */
  readonly placeholder?: string
  /** The models the chip offers. An empty list hides the chip. */
  readonly models: readonly BuiltinChatModel[]
  /** The chosen model, by `providerID` and `id`. */
  readonly model?: { readonly providerID: string; readonly id: string }
  /**
   * The user chose a model in the chip.
   *
   * @param model - The chosen model.
   */
  onModel(model: BuiltinChatModel): void
  /**
   * Sends the draft's text. The draft is cleared at once and put back when the answer is false.
   *
   * @param text - The draft's text, trimmed.
   */
  onSubmit(text: string): Promise<boolean>
  /** Stops the running reply. */
  onStop(): void
}

/** `Ui` with the components only built-ins use. */
export interface BuiltinUi extends Ui {
  /**
   * The session screen's composer region and composer, for a conversation the built-in runs: no attachments, commands
   * or shell, and a model chip over `models`.
   *
   * @param props - What it shows and does.
   *
   * @example
   * ```tsx
   * const Composer = builtinContext(ctx).ui.ChatComposer
   * <Composer working={running()} models={models()} onModel={choose} onSubmit={send} onStop={stop} />
   * ```
   */
  ChatComposer(props: BuiltinChatComposerProps): JSX.Element
}
