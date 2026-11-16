import { Switch } from "@opencode/ui/switch"

// The form's on/off rows. They live apart because the form also uses Solid's own `Switch`, and an import is never aliased.
export function FormToggle(props: {
  checked: boolean
  label: string
  description?: string
  onChange: (checked: boolean) => void
}) {
  return (
    <Switch checked={props.checked} description={props.description} onChange={props.onChange}>
      {props.label}
    </Switch>
  )
}
