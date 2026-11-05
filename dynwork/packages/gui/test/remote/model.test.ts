import { describe, expect, test } from "bun:test"
import remote from "../../src/remote/i18n/en"
import definition from "../../src/accounts"
import { Audit, Failure, Status, type State } from "../../src/remote/contract"
import { RemoteModel } from "../../src/remote/ui/model"

const state = (patch: Partial<State> = {}): State => ({
  enabled: true,
  confirmed: true,
  status: "connected",
  instance: "Dynapps",
  phones: [
    { id: "a", name: "Pixel", fingerprint: "f", pairedAt: 1, online: true },
    { id: "b", name: "iPhone", fingerprint: "g", pairedAt: 2, online: false },
  ],
  audit: [],
  ...patch,
})

describe("remote control's window model", () => {
  test("the titlebar indicator shows only while a paired phone is connected", () => {
    expect(RemoteModel.indicator(state())).toEqual({ count: 1, name: "Pixel" })
    expect(RemoteModel.indicator(state({ status: "connecting" }))).toBeUndefined()
    expect(RemoteModel.indicator(state({ enabled: false }))).toBeUndefined()
    expect(
      RemoteModel.indicator(state({ phones: state().phones.map((phone) => ({ ...phone, online: false })) })),
    ).toBeUndefined()
    expect(
      RemoteModel.indicator(state({ phones: state().phones.map((phone) => ({ ...phone, online: true })) }))?.count,
    ).toBe(2)
  })

  test("turning it on asks once, until the user has confirmed", () => {
    expect(RemoteModel.asks(state({ confirmed: false }), true)).toBe(true)
    expect(RemoteModel.asks(state({ confirmed: true }), true)).toBe(false)
    expect(RemoteModel.asks(state({ confirmed: false }), false)).toBe(false)
  })

  test("every status, failure, audit event and literal key the UI looks up has copy, in the plugin's strings", async () => {
    const en = definition.i18n?.en ?? {}
    const keys = [
      ...Status.literals
        .filter((status) => status !== "error")
        .map((status) => RemoteModel.statusKey(state({ status }))),
      ...Failure.literals.map((failure) => RemoteModel.statusKey(state({ status: "error", failure }))),
      ...Audit.fields.event.literals.map((event) => `remote.audit.${event}`),
    ]
    const sources = ["page.tsx", "register.tsx"].map((file) =>
      Bun.file(new URL(`../../src/remote/ui/${file}`, import.meta.url)).text(),
    )
    const literal = (await Promise.all(sources)).flatMap((text) =>
      [...text.matchAll(/\bt\(\s*"([^"]+)"/g)].map((match) => match[1] ?? ""),
    )
    expect(literal.length).toBeGreaterThan(20)
    expect([...keys, ...literal].filter((key) => !(key in remote) || !(key in en))).toEqual([])
  })
})
