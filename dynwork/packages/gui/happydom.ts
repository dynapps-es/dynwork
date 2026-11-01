import { GlobalRegistrator } from "@happy-dom/global-registrator"

// The accounts tests run main-process code against real local servers, which needs Bun's own HTTP globals: happy-dom's
// fetch applies browser CORS rules, its Response breaks `Bun.serve`, and Bun's fetch refuses its AbortSignal.
const native = {
  fetch: globalThis.fetch,
  Request: globalThis.Request,
  Response: globalThis.Response,
  Headers: globalThis.Headers,
  URL: globalThis.URL,
  URLSearchParams: globalThis.URLSearchParams,
  AbortController: globalThis.AbortController,
  AbortSignal: globalThis.AbortSignal,
  Blob: globalThis.Blob,
  FormData: globalThis.FormData,
}

GlobalRegistrator.register()

Object.assign(globalThis, native)
