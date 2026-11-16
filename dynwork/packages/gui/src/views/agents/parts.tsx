import { usePlugin, type IconName } from "@opencode/plugin/gui"
import { Icon } from "@opencode/ui/icon"
import { Loader } from "@opencode/ui/loader"
import { Show, type JSX } from "solid-js"
import type { Capabilities, Routine, RunState } from "../../routines/contract"
import { runTone, type Tone } from "./routine"

const marks: Record<Exclude<RunState, "running" | "missed">, IconName> = {
  queued: "dash",
  ok: "circle-check",
  late: "circle-exclamation",
  failed: "circle-x",
  blocked: "circle-ban-sign",
  skipped: "minus",
  cancelled: "circle-xmark",
}

/** A run's state as a mark: a spinner while it runs, a dashed ring for a missed slot, else an icon in its tone. */
export function RunMark(props: { state: RunState }) {
  const ctx = usePlugin()

  return (
    <span
      data-slot="agents-mark"
      data-state={props.state}
      data-tone={runTone(props.state)}
      role="img"
      aria-label={ctx.t(`agents.run.${props.state}`)}
    >
      <Show when={props.state === "running"} fallback={<MarkIcon state={props.state} />}>
        <Loader width={14} height={14} />
      </Show>
    </span>
  )
}

function MarkIcon(props: { state: RunState }) {
  return (
    <Show when={props.state !== "missed" && props.state !== "running"} fallback={<span data-slot="agents-ring" />}>
      <Icon name={marks[props.state as keyof typeof marks]} size="small" />
    </Show>
  )
}

/** A small label in a semantic tone: a status, a time zone, "Read only". */
export function Tag(props: { tone?: Tone; children: JSX.Element }) {
  return (
    <span data-slot="agents-tag" data-tone={props.tone}>
      {props.children}
    </span>
  )
}

/**
 * Where a routine runs, as a pill: its device with a dot for online, or the remote backend's name. A routine without an
 * owner reads its backend's label.
 */
export function WhereBadge(props: { routine?: Routine; capabilities?: Capabilities; text?: string }) {
  const remote = () => props.capabilities?.kind === "remote"

  return (
    <span data-slot="agents-where" data-kind={remote() ? "remote" : "local"}>
      <Icon name={remote() ? "cloud-upload" : "monitor"} size="small" />
      <span data-slot="agents-where-text">
        {props.text ?? props.routine?.owner?.label ?? props.capabilities?.label}
      </span>
      <Show when={!remote() && props.routine?.owner}>
        {(owner) => <span data-slot="agents-dot" data-tone={owner().online ? "success" : undefined} />}
      </Show>
    </span>
  )
}

/** The unread dot of a card, a run or a row. */
export function Unread(props: { show: boolean }) {
  const ctx = usePlugin()

  return (
    <Show when={props.show} fallback={<span data-slot="agents-unread-space" />}>
      <span data-slot="agents-unread" role="img" aria-label={ctx.t("agents.unread")} />
    </Show>
  )
}

/**
 * A link that looks like the app's button, for what opens a conversation. The desktop's router follows a same-origin
 * link in place, so a run opens inside its routine's tab (docs/04-ui.md §A.3.3).
 */
export function LinkButton(props: { href: string; icon?: IconName; title?: string; children: JSX.Element }) {
  return (
    <a
      href={props.href}
      title={props.title}
      data-component="button-v2"
      data-size="normal"
      data-variant="neutral"
      data-icon={props.icon}
    >
      <Show when={props.icon}>{(icon) => <Icon name={icon()} />}</Show>
      {props.children}
    </a>
  )
}
