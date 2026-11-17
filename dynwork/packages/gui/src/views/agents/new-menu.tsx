import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { Menu } from "@opencode/ui/menu"

/** "New routine ▾": create the routine in a chat with Dynwork, or set it up in the form. */
export default function NewRoutineMenu(props: {
  label: string
  chat: string
  manual: string
  disabled: boolean
  onChat: () => void
  onManual: () => void
}) {
  return (
    <Menu placement="bottom-end" gutter={6}>
      <Menu.Trigger as={Button} variant="contrast" icon="plus" disabled={props.disabled}>
        {props.label}
        <Icon name="chevron-down" size="small" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content>
          <Menu.Item onSelect={props.onChat}>
            <Icon name="speech-bubble" size="small" />
            {props.chat}
          </Menu.Item>
          <Menu.Item onSelect={props.onManual}>
            <Icon name="settings-gear" size="small" />
            {props.manual}
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  )
}
