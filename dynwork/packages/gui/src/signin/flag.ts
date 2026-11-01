export * as SignInFlag from "./flag"

import type { Instance } from "./accounts"

// Removing this key shows the sign-in screen again on the next launch.
export const key = "dynwork-signin"

export function signedIn() {
  return localStorage.getItem(key) !== null || sessionStorage.getItem(key) !== null
}

// "Keep me signed in" keeps the flag across launches; without it the flag lasts as long as the window's session.
export function store(input: { url: string; instance: Instance; keep: boolean }) {
  const value = JSON.stringify({
    url: input.url,
    instance: { id: input.instance.id, name: input.instance.name, host: input.instance.host },
  })

  if (input.keep) return localStorage.setItem(key, value)
  sessionStorage.setItem(key, value)
}
