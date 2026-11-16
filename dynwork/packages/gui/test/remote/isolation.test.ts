import { describe, expect, test } from "bun:test"
import { DynWorkIdentity } from "@dynwork/branding/identity"
import { DynWorkService } from "../../src/service"
import { defaultChannel, installTarget, localChannel } from "../../../../script/install-target"

// The plan's isolation from another DynWork on this Mac (decision M6): each channel installs to its own app, and an
// isolated run moves DynWork's service off its fixed port. Neither changes what a plain build or a normal launch does.
describe("install and service isolation", () => {
  test("desktop.ts installs to the canary slot by default, and never over internal's app", () => {
    expect(defaultChannel).toBe("canary")
    expect(localChannel([])).toBe("canary")
    expect(installTarget(localChannel([]))).toBe("/Applications/Dynwork Canary.app")
    expect(installTarget(localChannel(["--channel", "dev"]))).toBe("/Applications/Dynwork Dev.app")
    expect(installTarget(localChannel(["--channel=canary"]))).toBe("/Applications/Dynwork Canary.app")
  })

  test("a local build cannot be sent to internal, to an unknown channel or to an arbitrary directory", () => {
    expect(() => localChannel(["--channel", "internal"])).toThrow('Unknown channel "internal"')
    expect(() => localChannel(["--channel", "prod"])).toThrow('Unknown channel "prod"')
    expect(() => localChannel(["--channel"])).toThrow("--channel takes a channel")
    expect(() => localChannel(["--channel", "--x"])).toThrow("--channel takes a channel")
    expect(() => localChannel(["/tmp/builds"])).toThrow('Unknown argument "/tmp/builds"')
    expect(() => localChannel(["--other"])).toThrow('Unknown argument "--other"')
  })

  test("the service keeps its fixed port unless DYNWORK_SERVICE_PORT names another unprivileged one", () => {
    expect(DynWorkService.port({})).toBe(DynWorkIdentity.servicePort)
    expect(DynWorkService.port({ DYNWORK_SERVICE_PORT: "18555" })).toBe(18555)
    for (const value of ["80", "0", "70000", "abc", "", "1e4"])
      expect(DynWorkService.port({ DYNWORK_SERVICE_PORT: value })).toBe(DynWorkIdentity.servicePort)
  })
})
