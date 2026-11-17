import type { IconName } from "@opencode/plugin/gui"
import { Icon } from "@opencode/ui/icon"
import { Select } from "@opencode/ui/select"
import type { Choice } from "../../routines/contract"
import { fromSelect, selectChoices } from "./fields"

/**
 * A compact select in the footer of the instructions box, as the composer's model chip: no field around it, a fill on
 * hover, the check on the chosen item. `@opencode/ui/select` runs browser-only code as soon as it loads, so the editor
 * loads this on the client only.
 */
export default function PromptSelect(props: {
  label: string
  value: string
  options: readonly Choice[]
  blank?: string
  icon?: IconName
  invalid?: boolean
  disabled?: boolean
  placement?: "top-start" | "top-end"
  onChange: (value: string) => void
}) {
  const choices = () => selectChoices(props.value, props.options, props.blank)

  return (
    <span data-slot="form-prompt-select">
      {props.icon && <Icon name={props.icon} size="small" />}
      <Select
        aria-label={props.label}
        appearance="base"
        surface="invisible"
        options={choices().options}
        current={choices().options.find((option) => option.value === choices().value)}
        value={(option) => option.value}
        label={(option) => option.label}
        invalid={props.invalid}
        disabled={props.disabled}
        placement={props.placement ?? "top-start"}
        gutter={6}
        onSelect={(option) => option && props.onChange(fromSelect(option.value))}
      />
    </span>
  )
}
