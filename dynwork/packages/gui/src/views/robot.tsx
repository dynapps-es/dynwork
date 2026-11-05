/**
 * A robot head for the Agents row: the app's icon catalog has none. Drawn like the catalog's 20px outline icons (a 1px
 * `currentColor` stroke) and sized like `Icon`, so it takes the row's color and hover states.
 */
export function RobotIcon() {
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
      <path d="M10 6.5V3.75" />
      <circle cx="10" cy="3" r="0.75" />
      <rect x="3.5" y="6.5" width="13" height="10" rx="2.5" />
      <path d="M3.5 10.5H2.5V13.5H3.5M16.5 10.5H17.5V13.5H16.5" />
      <circle cx="7.5" cy="11" r="1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="11" r="1" fill="currentColor" stroke="none" />
      <path d="M8.5 14H11.5" />
    </svg>
  )
}
