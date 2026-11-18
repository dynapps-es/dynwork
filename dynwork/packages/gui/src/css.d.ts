// The desktop build bundles CSS imports; vite/client would declare them, but this package does not depend on Vite.
declare module "*.css" {}

// Vite's `import.meta.glob`, as the PDF viewer uses it: eager, each file's URL.
interface ImportMeta {
  glob<T>(pattern: string, options: { query: string; import: string; eager: true }): Record<string, T>
}

// A Vite `?url` import: the bundled file's URL, served from the app's own origin (the PDF viewer's pdf.js worker).
declare module "*?url" {
  const url: string
  export default url
}
