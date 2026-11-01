export * as SignInFlag from "./flag"

// The mock sign-in stored this key in the renderer's storage to remember it had finished. The screen now follows the
// accounts in main, so the key only needs to go.
export const key = "dynwork-signin"

export function migrate() {
  localStorage.removeItem(key)
  sessionStorage.removeItem(key)
}
