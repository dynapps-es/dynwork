import { expect, test } from "bun:test"
import { DynWorkShell } from "../src/shell"

const service = { XDG_STATE_HOME: "/profile/service/state", XDG_DATA_HOME: "/profile" }

test("a shell gets the user's own XDG values back, and an unset one is removed", () => {
  const env: Record<string, string | undefined> = { ...service, PATH: "/bin", [DynWorkShell.variable]: "{}" }
  DynWorkShell.restore(env, { XDG_STATE_HOME: "/home/u/.local/state", XDG_DATA_HOME: null }, service)
  expect(env).toEqual({ XDG_STATE_HOME: "/home/u/.local/state", PATH: "/bin" })
})

test("a value a session environment set on purpose stays", () => {
  const env: Record<string, string | undefined> = { XDG_STATE_HOME: "/session/state", XDG_DATA_HOME: "/profile" }
  DynWorkShell.restore(env, { XDG_STATE_HOME: "/home/u/.local/state" }, service)
  expect(env).toEqual({ XDG_STATE_HOME: "/session/state", XDG_DATA_HOME: "/profile" })
})

test("the saved values are read from the service environment, and garbage reads as none", () => {
  expect(DynWorkShell.saved({ [DynWorkShell.variable]: '{"XDG_STATE_HOME":"/s","XDG_DATA_HOME":null}' })).toEqual({
    XDG_STATE_HOME: "/s",
    XDG_DATA_HOME: null,
  })
  expect(DynWorkShell.saved({ [DynWorkShell.variable]: "{nope" })).toBeUndefined()
  expect(DynWorkShell.saved({ [DynWorkShell.variable]: '{"XDG_STATE_HOME":1}' })).toBeUndefined()
  expect(DynWorkShell.saved({})).toBeUndefined()
})
