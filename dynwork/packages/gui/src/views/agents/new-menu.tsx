import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"

/**
 * "New task ▾": create the task in a chat with Dynwork, or set it up in the form. `compact` is the "+" the Scheduled
 * sidebar row shows on hover, opening the same two choices beside it.
 */
export default function NewRoutineMenu(props: {
  label: string
  chat: string
  manual: string
  disabled: boolean
  compact?: boolean
  onChat: () => void
  onManual: () => void
}) {
  return (
    <Menu placement={props.compact ? "right-start" : "bottom-end"} gutter={6}>
      {props.compact ? (
        <Menu.Trigger
          as={IconButton}
          variant="ghost-muted"
          size="small"
          icon={<Icon name="plus" size="small" />}
          data-slot="dynwork-nav-add"
          aria-label={props.label}
          title={props.label}
        />
      ) : (
        <Menu.Trigger as={Button} variant="contrast" icon="plus" disabled={props.disabled}>
          {props.label}
          <Icon name="chevron-down" size="small" />
        </Menu.Trigger>
      )}
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
