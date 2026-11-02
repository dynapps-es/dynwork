import { describe, expect, test } from "bun:test"
import { DynWorkIdentity } from "@dynwork/branding/identity"
import { DynWorkService } from "../../src/service"
import { defaultInstall, installTarget } from "../../../../script/install-target"

// The plan's isolation from another DynWork on this Mac (decision M6): builds install where asked, and an isolated run
// moves DynWork's service off its fixed port. Neither changes what a plain build or a normal launch does.
describe("install and service isolation", () => {
  test("desktop.ts still installs to /Applications/DynWork.app by default", () => {
    expect(defaultInstall).toBe("/Applications/DynWork.app")
    expect(installTarget([])).toBe("/Applications/DynWork.app")
    expect(installTarget(["--other"])).toBe("/Applications/DynWork.app")
  })

  test("--to installs into the directory given, with ~ as the home directory", () => {
    expect(installTarget(["--to", "/tmp/builds"])).toBe("/tmp/builds/DynWork.app")
    expect(installTarget(["--to", "~/ai/dynwork/build"], "/Users/me")).toBe("/Users/me/ai/dynwork/build/DynWork.app")
    expect(() => installTarget(["--to"])).toThrow("--to takes a directory")
    expect(() => installTarget(["--to", "--x"])).toThrow("--to takes a directory")
  })

  test("the service keeps its fixed port unless DYNWORK_SERVICE_PORT names another unprivileged one", () => {
    expect(DynWorkService.port({})).toBe(DynWorkIdentity.servicePort)
    expect(DynWorkService.port({ DYNWORK_SERVICE_PORT: "18555" })).toBe(18555)
    for (const value of ["80", "0", "70000", "abc", "", "1e4"])
      expect(DynWorkService.port({ DYNWORK_SERVICE_PORT: value })).toBe(DynWorkIdentity.servicePort)
  })
})
