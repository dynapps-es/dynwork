import AgentsView from "../agents"

/** The `routines` page: the Agents view, filtered to the routines of this computer. Kept so the route still opens. */
export default function RoutinesView() {
  return <AgentsView where="local" />
}
