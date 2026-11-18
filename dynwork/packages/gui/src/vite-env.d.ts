// The desktop build is Vite's. The session UI the Chats view reuses (`@opencode/session-ui`, `@opencode/ui`) imports
// SVG files and globs as Vite does; vite/client would declare them, but this package does not depend on Vite.
declare module "*.svg" {
  const url: string
  export default url
}

interface ImportMeta {
  glob<T = unknown>(
    pattern: string | string[],
    options: { query?: string; import?: string; eager: true },
  ): Record<string, T>
  glob<T = unknown>(
    pattern: string | string[],
    options?: { query?: string; import?: string; eager?: boolean },
  ): Record<string, () => Promise<T>>
}
