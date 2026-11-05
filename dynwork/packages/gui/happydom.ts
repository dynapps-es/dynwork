import { GlobalRegistrator } from "@happy-dom/global-registrator"

// The accounts tests run main-process code against real local servers, which needs Bun's own HTTP globals: happy-dom's
// fetch applies browser CORS rules, its Response breaks `Bun.serve`, and Bun's fetch refuses its AbortSignal. The remote
// tunnel tests need Bun's WebSocket, which takes request headers as Node's does in Electron's main process.
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
  WebSocket: globalThis.WebSocket,
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder,
}

GlobalRegistrator.register()

Object.assign(globalThis, native)
