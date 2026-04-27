/**
 * Permission resolution — the single authoritative function the rest of the
 * app calls to ask "can this user see X?". Centralised so changes to the
 * model (e.g. adding role inheritance, group memberships) flow through one
 * place.
 *
 * The model is intentionally simple:
 *   • Admins (User.isAdmin = true) get full access — bypass all checks.
 *   • Non-admins access pilots ONLY through UserPilotAccess records.
 *     Each grant carries an `allowedTabs` array — the tabs the user can see
 *     in that specific pilot.
 *   • Tabs not in `allowedTabs` are hidden and direct URLs return 404.
 *
 * Tab keys (kept in one place — UI components import this list):
 */

export const ALL_TABS = [
  "overview",
  "inventory",
  "timeline",
  "comparison",
  "reference",
  "capacity",
  "hypotheses",
  "datahealth",
] as const;

export type TabKey = (typeof ALL_TABS)[number];

/** Human-friendly labels — used by the admin settings UI when editing access. */
export const TAB_LABELS: Record<TabKey, string> = {
  overview: "Overview",
  inventory: "Host Inventory",
  timeline: "CPU Timeline",
  comparison: "CPU Comparison",
  reference: "Reference Store",
  capacity: "Capacity Risk",
  hypotheses: "Hypotheses & Recommendations",
  datahealth: "Data Health",
};

export interface UserAuthState {
  id: string;
  username: string;
  isAdmin: boolean;
  // Resolved access map: pilotId -> allowed tab keys.
  // Admins get { "*": ALL_TABS } in this map for convenience but checks
  // typically short-circuit via isAdmin anyway.
  pilotAccess: Map<string, ReadonlySet<TabKey>>;
}

/** Can this user see this pilot at all? */
export function canAccessPilot(user: UserAuthState | null, pilotId: string): boolean {
  if (!user) return false;
  if (user.isAdmin) return true;
  const tabs = user.pilotAccess.get(pilotId);
  return tabs ? tabs.size > 0 : false;
}

/** Can this user see this specific tab in this pilot? */
export function canAccessTab(
  user: UserAuthState | null,
  pilotId: string,
  tab: TabKey,
): boolean {
  if (!user) return false;
  if (user.isAdmin) return true;
  const tabs = user.pilotAccess.get(pilotId);
  return tabs ? tabs.has(tab) : false;
}

/** Returns the set of pilot ids the user can see. Useful for filtering hub lists. */
export function visiblePilotIds(user: UserAuthState | null): "all" | Set<string> {
  if (!user) return new Set();
  if (user.isAdmin) return "all";
  return new Set(Array.from(user.pilotAccess.keys()).filter((id) => {
    const tabs = user.pilotAccess.get(id);
    return tabs && tabs.size > 0;
  }));
}

/** Filter a list of pilots down to what the user can see. */
export function filterAccessiblePilots<T extends { id: string }>(
  user: UserAuthState | null,
  pilots: T[],
): T[] {
  const ids = visiblePilotIds(user);
  if (ids === "all") return pilots;
  return pilots.filter((p) => ids.has(p.id));
}

/** Return the set of tabs this user can see in this pilot, or empty if none. */
export function allowedTabsFor(
  user: UserAuthState | null,
  pilotId: string,
): ReadonlySet<TabKey> {
  if (!user) return new Set();
  if (user.isAdmin) return new Set(ALL_TABS);
  return user.pilotAccess.get(pilotId) ?? new Set();
}

/** Admin gate — for /settings/users, /settings/roles, etc. */
export function requireAdmin(user: UserAuthState | null): user is UserAuthState {
  return !!user && user.isAdmin;
}

/**
 * Where should a freshly-authenticated user land?
 *
 *   • Admin                          → "/" (the cross-pilot dashboard)
 *   • Non-admin with exactly 1 pilot → "/retellect/<id>" (skip the hub —
 *                                      a one-row picker is a dead click)
 *   • Non-admin with several pilots  → "/retellect" (hub picker)
 *   • Non-admin with zero pilots     → "/no-access" (handled by login page;
 *                                      we never grant a session that lands
 *                                      here in practice, but be explicit)
 *
 * The actual product type isn't checked yet because Retellect is the only
 * shipped pilot category. When TC pilots come back online, this function
 * gets a small lookup; the call sites stay the same.
 */
export function landingPath(
  user: UserAuthState | null,
  accessiblePilotIds: readonly string[],
): string {
  if (!user) return "/login";
  if (user.isAdmin) return "/";
  if (accessiblePilotIds.length === 1) return `/retellect/${accessiblePilotIds[0]}`;
  if (accessiblePilotIds.length > 1) return "/retellect";
  return "/no-access";
}
