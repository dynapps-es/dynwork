import type { ClaudeIO } from "@opencode/core/plugin/provider/claude-agent/claude/io"
import { ClaudeQueryOptions } from "@opencode/core/plugin/provider/claude-agent/claude/query-options"
import { ClaudeSessions } from "@opencode/core/plugin/provider/claude-agent/claude/sessions"
import { RequestKind } from "@opencode/core/plugin/provider/claude-agent/language-model/request-kind"
import { ClaudeIntegration } from "@opencode/core/plugin/provider/claude-agent/integration"
import { ClaudeProvider } from "@opencode/core/plugin/provider/claude-agent/provider"
import { AISDK } from "@opencode/core/aisdk"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { ID, make } from "@opencode/core/plugin/provider/claude-agent/index"
import { Provider } from "@opencode/core/provider"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { FakeClaude } from "./lib/fake-claude"
import { FakeIO } from "./lib/fake-io"
import { TestSessions } from "./lib/sessions"
import { eventually } from "../../../lib/eventually"
import { testEffect } from "../../../lib/effect"
import { PluginTestLayer } from "../../fixture"

// DynWork routes Claude Agent's calls through its Governance gateway from a request hook: a call's own connection.

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* (io: ClaudeIO.Interface) {
  const registry = ClaudeSessions.registry()
  yield* Effect.addFinalizer(() => registry.close())
  const host = yield* PluginHost.make(yield* Plugin.Service, ID)
  yield* make(io, registry).effect(host)
  return registry
})

const connect = Effect.gen(function* () {
  const credentials = yield* Credential.Service
  return yield* credentials.create({
    integrationID: Integration.ID.make(ClaudeProvider.ID),
    value: Credential.External.make({
      type: "external",
      methodID: Integration.MethodID.make(ClaudeIntegration.METHOD_ID),
    }),
  })
})

const claudeModels = Effect.gen(function* () {
  const models = yield* Model.Service
  return (yield* models.all()).filter((model) => model.providerID === ClaudeProvider.ID)
})

describe("ClaudeAgentPlugin routed connection", () => {
  it.live("a call a plugin routes replaces the provider's connection for that call", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make(
        [FakeClaude.expectStartup(), FakeClaude.expectTurn(), FakeClaude.expectInterrupt()],
        { probes: true },
      )
      const registry = yield* addPlugin(FakeIO.make({ claude }))
      const providers = yield* Provider.Service
      yield* providers.transform((editor) => {
        editor.update(ClaudeProvider.ID, (provider) => {
          provider.settings = { baseURL: "https://configured.example", authToken: "config-token" }
          provider.headers = { "X-Team": "core" }
        })
      })
      yield* connect
      yield* eventually(claudeModels, (models) => models.some((model) => model.id === "sonnet"))

      const models = yield* Model.Service
      const aisdk = yield* AISDK.Service
      const model = yield* models.get(ClaudeProvider.ID, Model.ID.make("haiku"))
      if (!model) throw new Error("Expected the haiku model")
      const language = yield* aisdk.language(model)
      const result = yield* Effect.promise(() =>
        language.doStream({
          prompt: TestSessions.prompt("Remember the marker COPPER-OTTER. Reply only with that marker."),
          headers: { [RequestKind.SESSION_HEADER]: "session-a", [RequestKind.HEADER]: "primary" },
          providerOptions: {
            [ClaudeProvider.ID]: {
              [ClaudeQueryOptions.CONNECTION_OPTION]: {
                settings: { baseURL: "https://routed.example/v1" },
                headers: { "x-gateway-authorization": "Bearer routed" },
              },
            },
          },
        }),
      )
      expect(TestSessions.text(yield* Effect.promise(() => TestSessions.collect(result.stream)))).toBe("COPPER-OTTER")

      // Nothing of the provider's own connection is kept: its token would displace the login the call goes with
      const chat = claude.runs.find((run) => run.args.includes("--include-partial-messages"))!.env
      expect(chat.ANTHROPIC_BASE_URL).toBe("https://routed.example/v1")
      expect(chat.ANTHROPIC_CUSTOM_HEADERS).toBe("x-gateway-authorization: Bearer routed")
      expect(chat.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
      yield* registry.close()
      claude.check()
    }),
  )
})
