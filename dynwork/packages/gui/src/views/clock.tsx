/**
 * A clock for the Scheduled row: the app's icon catalog has none. Drawn like the catalog's 20px outline icons (a 1px
 * `currentColor` stroke) and sized like `Icon`, so it takes the row's color and hover states.
 */
export function ClockIcon() {
  return (
    <svg
      data-slot="icon-svg"
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="7" />
      <path d="M10 5.5V10L13 12" />
    </svg>
  )
}
