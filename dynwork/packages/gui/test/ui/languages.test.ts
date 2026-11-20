import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import en from "../../src/accounts/i18n/en"
import es from "../../src/accounts/i18n/es"
import fr from "../../src/accounts/i18n/fr"
import nl from "../../src/accounts/i18n/nl"
import remote from "../../src/remote/i18n/en"
import remoteEs from "../../src/remote/i18n/es"
import remoteFr from "../../src/remote/i18n/fr"
import remoteNl from "../../src/remote/i18n/nl"
import { RoutinesBackend } from "../../src/routines/backend"
import type { Field } from "../../src/routines/contract"
import { RoutinesDemo } from "../../src/routines/demo"
import { RoutinesFarm } from "../../src/routines/farm/backend"
import main from "../../src/routines/i18n/en"
import { RoutinesLocal } from "../../src/routines/local/backend"
import { SignInCopy } from "../../src/signin/copy"
import { fieldSaid, fromMain } from "../../src/views/agents/format"
import { createAgentsModel } from "../../src/views/agents/model"
import { connect } from "../routines/wire"
import { translator } from "./translator"

// The `dynwork` built-in's catalog, as `accounts/index.ts` declares it.
const english: Record<string, string> = { ...en, ...remote }
const spanish: Record<string, string> = { ...es, ...remoteEs }
const french: Record<string, string> = { ...fr, ...remoteFr }
const dutch: Record<string, string> = { ...nl, ...remoteNl }
const languages: Array<[string, Record<string, string>]> = [
  ["Spanish", spanish],
  ["French", french],
  ["Dutch", dutch],
]
const params = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).toSorted()
const texts = (field: Field) => [
  field.label,
  ...(field.help === undefined ? [] : [field.help]),
  ...(field.choices ?? []).flatMap((choice) => [
    choice.label,
    ...(choice.warning === undefined ? [] : [choice.warning]),
  ]),
]
// The main-process sources whose failures and fields a window shows.
const sources = ["validate.ts", "ipc.ts", "chat.ts", "local/backend.ts", "farm/backend.ts", "fake.ts"]

describe.each(languages)("Dynwork in %s", (_, table) => {
  test("every English key has one with the same placeholders, and none extra", () => {
    expect(Object.keys(english).length).toBeGreaterThan(400)
    expect(Object.keys(table).toSorted()).toEqual(Object.keys(english).toSorted())
    expect(
      Object.keys(english).filter((key) => params(english[key] ?? "").join() !== params(table[key] ?? "").join()),
    ).toEqual([])
  })

  test("is translated, not copied from English", () => {
    // Names and short tokens read the same in both; three words or more that match were left untranslated.
    const words = (text: string) => text.replace(/\{\{\w+\}\}/g, "").match(/[A-Za-z]{3,}/g) ?? []
    const same = Object.keys(english).filter(
      (key) => english[key] === table[key] && words(english[key] ?? "").length >= 3,
    )
    expect(same).toEqual([])
  })
})

describe("Dynwork in other languages", () => {
  test("every field a backend declares has its words in main's table", () => {
    const written = new Set(Object.values(main))
    expect(
      [...RoutinesLocal.fields, ...RoutinesFarm.fields].flatMap(texts).filter((text) => !written.has(text)),
    ).toEqual([])
  })

  test("main's table holds only text main writes, word for word", async () => {
    const code = (
      await Promise.all(sources.map((file) => Bun.file(new URL(`../../src/routines/${file}`, import.meta.url)).text()))
    ).join("\n")
    expect(Object.values(main).filter((text) => !code.includes(JSON.stringify(text)))).toEqual([])
  })

  test("every fixed failure the backends, the Ipc and the validation write is in main's table", async () => {
    const shown = await Promise.all(
      ["validate.ts", "ipc.ts", "local/backend.ts"].map((file) =>
        Bun.file(new URL(`../../src/routines/${file}`, import.meta.url)).text(),
      ),
    )
    const written = shown.join("\n").matchAll(/(?:fail\("[a-z-]+", |problems\.\w+ = |return |\? )"([^"]+\.)"/g)
    const missing = [...written].map((match) => match[1] ?? "").filter((text) => !Object.values(main).includes(text))
    expect(missing).toEqual([])
  })

  test("a window shows main's English in its language", () => {
    const t = translator(spanish)
    expect(fromMain(t, "The run has already finished.")).toBe("La ejecución ya ha terminado.")
    expect(fromMain(t, "Something the table does not know.")).toBe("Something the table does not know.")
    const permissions = RoutinesLocal.fields.find((field) => field.key === "permissions")
    if (!permissions) throw new Error("No permissions field")
    expect(fieldSaid(t, permissions)).toMatchObject({
      key: "permissions",
      label: "Permisos",
      choices: [
        { value: "ask", label: "Preguntarme" },
        {
          value: "bypass",
          label: "No preguntar",
          warning: "La tarea puede editar archivos y ejecutar comandos sin preguntarte.",
        },
      ],
    })
  })

  test("the Agents view reads the backends' fields in the window's language, once per language", async () => {
    const registry = RoutinesBackend.make()
    registry.register(RoutinesDemo.local(() => Date.UTC(2026, 10, 16, 9)))
    const wire = connect(registry)
    await wire.client.refresh()
    // A window's Ipc state keeps its objects until main pushes again; the test wire decodes them on every read.
    const state = wire.client.state()
    const client = { ...wire.client, state: () => state }
    const language = { locale: "es" }
    const t = (key: string, values?: Record<string, string | number>) =>
      translator(language.locale === "es" ? spanish : english)(key, values)
    const model = createRoot(() =>
      createAgentsModel({ client: () => client, speak: { t, locale: () => language.locale } }),
    )
    const labels = () => model.backends().flatMap((backend) => backend.fields.map((field) => field.label))
    expect(labels()).toContain("Carpeta del proyecto")
    expect(labels()).toContain("Recuperar ejecuciones perdidas")
    expect(model.backends()[0]).toBe(model.backends()[0])
    language.locale = "en"
    expect(labels()).toContain("Project folder")
  })

  test("a window shows main's English in French and Dutch", () => {
    expect(fromMain(translator(french), "Don't ask")).toBe("Ne pas demander")
    expect(fromMain(translator(dutch), "If recent")).toBe("Indien recent")
  })

  test("the sign-in screen follows the app's language", () => {
    expect(SignInCopy.of("es")).toBe(SignInCopy.es)
    expect(SignInCopy.of("es-ES")).toBe(SignInCopy.es)
    expect(SignInCopy.of("fr")).toBe(SignInCopy.fr)
    expect(SignInCopy.of("nl")).toBe(SignInCopy.nl)
    expect(SignInCopy.of("nl-BE")).toBe(SignInCopy.nl)
    expect(SignInCopy.of("en")).toBe(SignInCopy.en)
    expect(SignInCopy.of("de")).toBe(SignInCopy.en)
    expect(SignInCopy.fr.choose.sync({ skills: 2, agents: 1, servers: 1 })).toBe("2 skills · 1 agent · 1 serveur MCP")
    expect(SignInCopy.nl.choose.sync({ skills: 1, agents: 2, servers: 3 })).toBe("1 skill · 2 agents · 3 MCP-servers")
    expect(SignInCopy.es.choose.sync({ skills: 1, agents: 2, servers: 3 })).toBe(
      "1 skill · 2 agentes · 3 servidores MCP",
    )
  })
})
