// Who may do what in the admin app. Mirrors the access matrix in supabase/migrations/README.md and the RPC
// table in docs/m2-plan.md. This is for HIDING and DISABLING buttons only: the database decides, and every
// screen still handles a server refusal gracefully.

export const ADMIN_ROLES = [
  'super_admin',
  'content_editor',
  'reviewer',
  'support',
  'analyst',
] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && (ADMIN_ROLES as readonly string[]).includes(value);
}

export const ROLE_LABELS: Record<AdminRole, string> = {
  super_admin: 'Super admin',
  content_editor: 'Content editor',
  reviewer: 'Reviewer',
  support: 'Support',
  analyst: 'Analyst',
};

export function roleLabel(role: AdminRole): string {
  return ROLE_LABELS[role];
}

/** Everything a role can be asked about. */
export const CAPABILITIES = [
  /** Read schemes, chapters, units, drafts, jobs, characters and settings. */
  'content.view',
  /** Start a Claude job (scheme extraction, chapter plan, unit draft, revision). */
  'job.start',
  'scheme.save',
  'scheme.approve',
  'plan.apply',
  /** Add, remove and reorder units in the chapters of an approved scheme (apply_unit_layout). */
  'layout.apply',
  /** Edit a unit by hand and save the result as a new human version (create_unit_version_draft). */
  'unit.edit',
  /** draft -> in_review */
  'version.submit',
  /** in_review -> approved, in_review -> draft */
  'version.review',
  'version.publish',
  'characters.edit',
  'usage.view',
  'settings.view',
  'settings.edit',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const MATRIX: Record<Capability, readonly AdminRole[]> = {
  'content.view': ['super_admin', 'content_editor', 'reviewer'],
  'job.start': ['super_admin', 'content_editor'],
  'scheme.save': ['super_admin', 'content_editor'],
  'scheme.approve': ['super_admin', 'reviewer'],
  'plan.apply': ['super_admin', 'content_editor'],
  'layout.apply': ['super_admin', 'content_editor'],
  'unit.edit': ['super_admin', 'content_editor'],
  'version.submit': ['super_admin', 'content_editor', 'reviewer'],
  'version.review': ['super_admin', 'reviewer'],
  'version.publish': ['super_admin', 'content_editor', 'reviewer'],
  'characters.edit': ['super_admin', 'content_editor'],
  'usage.view': ['super_admin', 'content_editor', 'analyst'],
  'settings.view': ['super_admin', 'content_editor', 'reviewer'],
  'settings.edit': ['super_admin'],
};

export function can(role: AdminRole | null | undefined, capability: Capability): boolean {
  return role != null && MATRIX[capability].includes(role);
}

/** The roles that hold a capability, in plain words, for a "why is this disabled" hint. */
export function rolesFor(capability: Capability): AdminRole[] {
  return [...MATRIX[capability]];
}

export function whyNot(role: AdminRole | null | undefined, capability: Capability): string | null {
  if (can(role, capability)) return null;
  const names = MATRIX[capability].map((entry) => ROLE_LABELS[entry].toLowerCase());
  const list =
    names.length === 1
      ? (names[0] as string)
      : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  return `Needs the ${list} role.`;
}

export interface NavItem {
  id: string;
  label: string;
  href: string;
  /** Hidden for roles without this capability. */
  requires: Capability;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'schemes', label: 'Schemes', href: '/schemes', requires: 'content.view' },
  { id: 'characters', label: 'Characters', href: '/characters', requires: 'content.view' },
  { id: 'usage', label: 'Usage & settings', href: '/usage', requires: 'usage.view' },
  { id: 'jobs', label: 'Jobs', href: '/jobs', requires: 'content.view' },
];

/** Reviewers can read the settings (kill switch, models) but not usage totals; analysts the reverse. */
export function visibleNav(role: AdminRole | null | undefined): NavItem[] {
  return NAV_ITEMS.filter((item) => {
    if (item.id === 'usage') return can(role, 'usage.view') || can(role, 'settings.view');
    return can(role, item.requires);
  });
}

const CONTENT_ROUTES = ['/schemes', '/units', '/jobs', '/characters'];

/**
 * Whether a role may open a page at all. Home and the demo-only preview are open to every signed-in role; the
 * content pages need content access and the usage page needs usage or settings access. The server has the
 * final say; this only keeps a role from landing on a page it cannot use.
 */
export function canOpenRoute(role: AdminRole | null | undefined, pathname: string): boolean {
  if (role == null) return false;
  if (pathname === '/' || pathname === '' || pathname.startsWith('/preview')) return true;
  if (pathname === '/usage' || pathname.startsWith('/usage/')) {
    return can(role, 'usage.view') || can(role, 'settings.view');
  }
  if (CONTENT_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`))) {
    return can(role, 'content.view');
  }
  return true;
}
