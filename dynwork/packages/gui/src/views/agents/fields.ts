import type { Capabilities, Choice, Definition, Field } from "../../routines/contract"

// How the form draws the fields a backend declares in `capabilities().fields`: which control each kind gets, which
// fields a `when` hides, and which block of the form each section belongs to. It is all data, so a backend adds options
// without the view changing.

export type Options = Definition["options"]

/** The control a field is drawn with. `radio` and `choices` are for choices; `choices` takes several. */
export type Control =
  | "text"
  | "textarea"
  | "number"
  | "toggle"
  | "radio"
  | "select"
  | "choices"
  | "list"
  | "folder"
  | "repo"

// Up to this many fixed choices read better as a list of radios than as a dropdown.
const RADIO_MAX = 4

/** `choices` are the field's own or those of its lookup once loaded: a lookup's can be long, so it is a dropdown. */
export function control(field: Field, choices: readonly Choice[]): Control {
  if (field.kind === "select")
    return !field.lookup && choices.length > 0 && choices.length <= RADIO_MAX ? "radio" : "select"
  if (field.kind === "multiselect") return "choices"
  return field.kind
}

/** Whether a control sits on the right of its label, as in a Settings row, rather than under it with the whole width. */
export function inline(kind: Control) {
  return kind === "number" || kind === "toggle" || kind === "select"
}

/** The choices of a select or multiselect: its own, or its lookup's through `lookup`. */
export function choicesOf(field: Field, lookup: (name: string) => readonly Choice[]): readonly Choice[] {
  if (field.choices) return field.choices
  return field.lookup ? lookup(field.lookup) : []
}

/** The value a field has: what the user set, else its default. */
export function valueOf(field: Field, options: Options) {
  return options[field.key] ?? field.default
}

/**
 * What a `multiselect` has picked. A field whose default is `"all"` holds `"all"` until the user unpicks one: every
 * choice then counts as picked, and picking them all again goes back to `"all"`, so a choice added later is included.
 */
export function picked(field: Field, value: unknown, choices: readonly Choice[]) {
  if (value === "all" && field.default === "all") return choices.map((choice) => choice.value)
  return Array.isArray(value) ? value.map(String) : []
}

/** The value after the user toggles `choice`; see `picked`. */
export function toggled(field: Field, value: unknown, choices: readonly Choice[], choice: string) {
  const current = picked(field, value, choices)
  const next = current.includes(choice) ? current.filter((item) => item !== choice) : [...current, choice]
  const everything = choices.every((item) => next.includes(item.value))
  return field.default === "all" && everything ? "all" : next
}

/** Whether a field is shown: always, or while the field its `when` names has the value it asks for. */
export function shown(field: Field, fields: readonly Field[], options: Options) {
  if (!field.when) return true
  const other = fields.find((candidate) => candidate.key === field.when?.key)
  const value = other ? valueOf(other, options) : options[field.when.key]
  return JSON.stringify(value) === JSON.stringify(field.when.equals)
}

/** The defaults of every field that has one: the options a new routine starts with. */
export function defaults(capabilities: Pick<Capabilities, "fields">): Options {
  return Object.fromEntries(
    capabilities.fields.flatMap((field) => (field.default === undefined ? [] : [[field.key, field.default]])),
  )
}

// The app's select treats an empty value as no selection and shows nothing, so a blank choice travels under this key.
const BLANK = "\u0000blank"

/**
 * The options and the value a select shows for a field's choices. `blank` is the choice that leaves the field empty,
 * such as "Default"; a stored value the choices do not list, or have not loaded yet, stays selectable instead of
 * vanishing. `fromSelect` turns what the select picks back into the field's value.
 */
export function selectChoices(value: string, choices: readonly Choice[], blank?: string) {
  return {
    value: value === "" ? BLANK : value,
    options: [
      ...(blank === undefined ? [] : [{ value: BLANK, label: blank }]),
      ...choices.map((choice) => ({ value: choice.value, label: choice.label })),
      ...(value !== "" && !choices.some((choice) => choice.value === value) ? [{ value, label: value }] : []),
    ],
  }
}

export function fromSelect(value: string) {
  return value === BLANK ? "" : value
}

/** The sections that make up the backend's own block, "where and with what". */
const where = ["workspace", "permissions", "plugins", "limits"]

/**
 * The shown fields by the block of the form they go in, each in the order the backend declares them:
 * - `where`: workspace, permissions, plugins and limits, under the backend's own heading.
 * - `extra`: every other section the backend invents; the farm's own options live here.
 * - `advanced`, `notifications`, `connectors`: the tabs of the advanced settings.
 * - `prompt`: the `permissions` choice, in the footer of the instructions box beside the model, as Claude's task form
 *   puts its permission mode.
 */
export function layout(capabilities: Pick<Capabilities, "fields">, options: Options) {
  const fields = capabilities.fields
  const visible = fields.filter((field) => shown(field, fields, options))
  const prompt = visible.filter((field) => field.key === "permissions" && field.kind === "select")
  const named = (...sections: string[]) =>
    visible.filter((field) => sections.includes(field.section) && !prompt.includes(field))
  const placed = [...where, "advanced", "notifications", "connectors"]
  return {
    prompt,
    where: named(...where),
    extra: visible.filter((field) => !placed.includes(field.section) && !prompt.includes(field)),
    advanced: named("advanced"),
    notifications: named("notifications"),
    connectors: named("connectors"),
  }
}

export type Layout = ReturnType<typeof layout>
