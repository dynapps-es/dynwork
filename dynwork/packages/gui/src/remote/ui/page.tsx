import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Switch } from "@opencode/ui/switch"
import { usePlugin, type Live } from "@opencode/plugin/gui"
import { renderSVG } from "@opencode/util/qr"
import { createSignal, For, Show, type Accessor } from "solid-js"
import type definition from "../../accounts/index"
import type { Pairing, Phone } from "../contract"
import { RemoteModel } from "./model"
import type { Client } from "./register"

// Settings -> Remote control: the toggle (asks once what a phone can do), the pairing QR, the paired phones with
// revoke, and the last connections.
export default function RemotePage(props: { remote: Accessor<Live<Client>> }) {
  const ctx = usePlugin<typeof definition>()
  const client = () => {
    const live = props.remote()
    return live.status === "active" ? live.value : undefined
  }
  const state = () => client()?.state()
  const [busy, setBusy] = createSignal(false)
  const time = (at: number) => new Date(at).toLocaleString()

  const toggle = async (enabled: boolean) => {
    const live = client()
    const value = state()
    if (!live || !value) return
    if (
      RemoteModel.asks(value, enabled) &&
      !(await ctx.dialogs.confirm({
        title: ctx.t("remote.confirm.title"),
        description: ctx.t("remote.confirm.description"),
        confirm: ctx.t("remote.confirm"),
      }))
    )
      return
    setBusy(true)
    await live.setEnabled(enabled).finally(() => setBusy(false))
  }

  const pair = async () => {
    const live = client()
    if (!live) return
    const shown = await live.pair().catch(async () => {
      const { showToast } = await import("@opencode/ui/toast")
      showToast({ title: ctx.t("remote.pair.failed") })
      return undefined
    })
    if (!shown) return
    ctx.dialogs.open((dialog) => (
      <PairingDialog
        pairing={() => state()?.pairing ?? shown}
        instance={state()?.instance ?? ""}
        close={() => {
          void live.cancelPairing()
          dialog.close()
        }}
      />
    ))
  }

  const revoke = async (phone: Phone) => {
    const live = client()
    if (!live) return
    const confirmed = await ctx.dialogs.confirm({
      title: ctx.t("remote.revoke.title", { name: phone.name }),
      description: ctx.t("remote.revoke.description"),
      confirm: ctx.t("remote.revoke"),
      danger: true,
    })
    if (confirmed) await live.revoke(phone.id)
  }

  return (
    <div data-component="remote-page">
      <div class="settings-tab-header">
        <h2 class="settings-tab-title">{ctx.t("remote.title")}</h2>
        <p>{ctx.t("remote.description")}</p>
      </div>
      <Show when={state()} fallback={<p>{ctx.t("remote.unavailable")}</p>}>
        {(value) => (
          <>
            <div data-component="settings-row">
              <div data-slot="settings-row-copy">
                <div data-slot="settings-row-title">{ctx.t("remote.toggle.title")}</div>
                <div data-slot="settings-row-description">{ctx.t("remote.toggle.description")}</div>
              </div>
              <div data-slot="settings-row-control">
                <Switch
                  hideLabel
                  data-action="remote-toggle"
                  checked={value().enabled}
                  disabled={busy()}
                  onChange={(enabled) => void toggle(enabled)}
                >
                  {ctx.t("remote.toggle.title")}
                </Switch>
              </div>
            </div>
            <p data-slot="remote-status" data-status={value().status}>
              {ctx.t(RemoteModel.statusKey(value()), { instance: value().instance ?? "" })}
            </p>
            <Show when={value().fingerprint}>
              {(fingerprint) => (
                <p data-slot="remote-fingerprint">{ctx.t("remote.fingerprint", { fingerprint: fingerprint() })}</p>
              )}
            </Show>
            <Button
              data-action="remote-pair"
              variant="neutral"
              icon="plus"
              disabled={value().status !== "connected"}
              onClick={() => void pair()}
            >
              {ctx.t("remote.pair")}
            </Button>
            <h3>{ctx.t("remote.phones.title")}</h3>
            <Show when={value().phones.length > 0} fallback={<p>{ctx.t("remote.phones.empty")}</p>}>
              <ul data-slot="remote-phones">
                <For each={value().phones}>
                  {(phone) => (
                    <li data-component="remote-phone" data-online={phone.online}>
                      <span>{phone.name}</span>
                      <span>{ctx.t(phone.online ? "remote.phones.online" : "remote.phones.offline")}</span>
                      <span>{ctx.t("remote.phones.paired", { time: time(phone.pairedAt) })}</span>
                      <Button variant="ghost" data-action="remote-revoke" onClick={() => void revoke(phone)}>
                        {ctx.t("remote.revoke")}
                      </Button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <h3>{ctx.t("remote.audit.title")}</h3>
            <Show when={value().audit.length > 0} fallback={<p>{ctx.t("remote.audit.empty")}</p>}>
              <ul data-slot="remote-audit">
                <For each={value().audit}>
                  {(entry) => (
                    <li>
                      {time(entry.at)} · {ctx.t(`remote.audit.${entry.event}`, { phone: entry.phone })}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}

function PairingDialog(props: { pairing: Accessor<Pairing>; instance: string; close: () => void }) {
  const ctx = usePlugin<typeof definition>()
  const svg = () => renderSVG(props.pairing().qr, { border: 4, blackColor: "currentColor", whiteColor: "transparent" })
  const [copied, setCopied] = createSignal(false)
  // The same text the QR holds, for a phone that cannot scan it: Dynwork on the phone takes it under "Enter the code
  // manually".
  const copy = async () => {
    const done = await navigator.clipboard.writeText(props.pairing().qr).then(
      () => true,
      () => false,
    )
    if (!done) {
      const { showToast } = await import("@opencode/ui/toast")
      showToast({ title: ctx.t("remote.pair.copyFailed") })
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <Dialog fit containerClass="max-w-[min(400px,calc(100vw-32px))]">
      <DialogHeader>
        <DialogTitleGroup
          title={ctx.t("remote.pair.title")}
          description={ctx.t("remote.pair.description", {
            instance: props.instance,
            time: new Date(props.pairing().expires).toLocaleTimeString(),
          })}
        />
      </DialogHeader>
      <DialogBody class="flex flex-col gap-4 px-4 pb-4" data-component="remote-pairing">
        <div
          data-slot="remote-qr"
          class="mx-auto aspect-square w-full max-w-[calc(100dvh-360px)] shrink-0 rounded-[6px] bg-v2-background-bg-base p-6 text-v2-text-text-base [&>svg]:size-full"
          role="img"
          aria-label={ctx.t("remote.pair.qr")}
          innerHTML={svg()}
        />
        <div class="flex gap-2 [&>*]:flex-1">
          <Button data-action="remote-copy" variant="ghost" icon={copied() ? "check" : "copy"} onClick={() => void copy()}>
            {ctx.t(copied() ? "remote.pair.copied" : "remote.pair.copy")}
          </Button>
          <Button variant="neutral" onClick={props.close}>
            {ctx.t("remote.pair.close")}
          </Button>
        </div>
      </DialogBody>
    </Dialog>
  )
}
