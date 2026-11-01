import { beforeEach, expect, test } from "bun:test"
import { SignInFlag } from "../../src/signin/flag"

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

test("migrate removes the mock sign-in's key from both storages and leaves the rest", () => {
  localStorage.setItem(SignInFlag.key, "{}")
  sessionStorage.setItem(SignInFlag.key, "{}")
  localStorage.setItem("opencode-theme-id", "oc-2")
  SignInFlag.migrate()
  expect(localStorage.getItem(SignInFlag.key)).toBeNull()
  expect(sessionStorage.getItem(SignInFlag.key)).toBeNull()
  expect(localStorage.getItem("opencode-theme-id")).toBe("oc-2")
})
