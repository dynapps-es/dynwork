import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { Account, State } from "../../src/accounts/contract"
import { SignInVisibility } from "../../src/signin/visibility"

const account = (overrides: Partial<Account>): Account => ({
  id: "a",
  label: "Alpha",
  url: "https://sp.example.com",
  status: "signedIn",
  active: true,
  trusted: false,
  ...overrides,
})

function visible(initial: State | undefined) {
  return createRoot((dispose) => {
    const [state, setState] = createSignal(initial)

    return { dispose, setState, visibility: SignInVisibility.create(state) }
  })
}

describe("gate visibility", () => {
  test("nothing shows, and the cover holds, until main answers", () => {
    const { visibility, dispose } = visible(undefined)

    expect(visibility.known()).toBe(false)
    expect(visibility.open()).toBe(false)
    dispose()
  })

  test("an active signed-in account keeps the gate closed without a flash", () => {
    const { visibility, dispose } = visible({ accounts: [account({})] })

    expect(visibility.known()).toBe(true)
    expect(visibility.open()).toBe(false)
    dispose()
  })

  test.each([
    { name: "no accounts", accounts: [] },
    { name: "only signed-out accounts", accounts: [account({ status: "signedOut", active: false })] },
    { name: "a signed-in account that is not active", accounts: [account({ active: false })] },
  ])("$name opens the gate", (row) => {
    const { visibility, dispose } = visible({ accounts: row.accounts })

    expect(visibility.open()).toBe(true)
    dispose()
  })

  test("the first snapshot decides: a late answer opens the gate", () => {
    const { visibility, setState, dispose } = visible(undefined)

    setState({ accounts: [] })
    expect(visibility.open()).toBe(true)
    dispose()
  })

  test("signing in does not close it; dismissing does", () => {
    const { visibility, setState, dispose } = visible({ accounts: [] })

    // The screen reads `open` as it mounts, while nothing is signed in.
    expect(visibility.open()).toBe(true)
    setState({ accounts: [account({})] })
    expect(visibility.open()).toBe(true)
    visibility.dismiss()
    expect(visibility.open()).toBe(false)
    dispose()
  })

  test("signing out of the active account brings the gate back", () => {
    const { visibility, setState, dispose } = visible({ accounts: [account({})] })

    expect(visibility.open()).toBe(false)
    setState({ accounts: [account({ status: "signedOut", active: false })] })
    expect(visibility.open()).toBe(true)
    setState({ accounts: [account({})] })
    expect(visibility.open()).toBe(true)
    visibility.dismiss()
    expect(visibility.open()).toBe(false)
    dispose()
  })
})
