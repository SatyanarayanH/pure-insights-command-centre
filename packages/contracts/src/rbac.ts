import { z } from 'zod';

/**
 * Role-based access control, defined once and used by the API middleware, the WebSocket
 * gateway, the React navigation and the generated specification.
 *
 * Authorisation is checked against permissions, never against role names, so adding a role is
 * a change to this table only.
 */
export const ROLES = ['admin', 'finops', 'owner', 'viewer'] as const;
export const RoleSchema = z.enum(ROLES).meta({ id: 'Role' });
export type Role = z.infer<typeof RoleSchema>;

export const PERMISSIONS = [
  'reports:read',
  'costs:read',
  'chargeback:read',
  'pii:read',
  'orphans:read',
  'orphans:assign',
  'alerts:read',
  'alerts:ack',
  'alerts:snooze',
  'alert-rules:read',
  'alert-rules:write',
  'dq:read',
  'users:read',
  'audit:read',
  'telemetry:ingest',
  'incidents:inject',
  'simulator:control',
  'notifications:read',
  'warehouse:refresh',
] as const;
export const PermissionSchema = z.enum(PERMISSIONS).meta({ id: 'Permission' });
export type Permission = z.infer<typeof PermissionSchema>;

/** `all`: every report. `own`: only reports the user currently owns (row-level security). */
export type DataScope = 'all' | 'own';

export interface RoleDefinition {
  label: string;
  description: string;
  scope: DataScope;
  permissions: readonly Permission[];
}

export const ROLE_DEFINITIONS: Record<Role, RoleDefinition> = {
  admin: {
    label: 'Platform Admin',
    description:
      'Runs the portal. Full visibility, assigns owners, tunes alert rules, reads the audit log.',
    scope: 'all',
    permissions: PERMISSIONS,
  },
  finops: {
    label: 'FinOps Analyst',
    description:
      'Owns the cloud bill. Reads every cost, chargeback and data-quality view; changes nothing.',
    scope: 'all',
    permissions: [
      'reports:read',
      'costs:read',
      'chargeback:read',
      'pii:read',
      'orphans:read',
      'alerts:read',
      'alert-rules:read',
      'dq:read',
    ],
  },
  owner: {
    label: 'Report Owner',
    description:
      'Accountable for specific reports. Sees and acknowledges alerts and cost for those reports only.',
    scope: 'own',
    permissions: ['reports:read', 'costs:read', 'pii:read', 'alerts:read', 'alerts:ack'],
  },
  viewer: {
    label: 'Viewer',
    description: 'Read-only health view. No cost figures; owner email addresses are masked.',
    scope: 'all',
    permissions: ['reports:read', 'alerts:read'],
  },
};

export function permissionsFor(role: Role): readonly Permission[] {
  return ROLE_DEFINITIONS[role].permissions;
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_DEFINITIONS[role].permissions.includes(permission);
}

export function scopeFor(role: Role): DataScope {
  return ROLE_DEFINITIONS[role].scope;
}

/**
 * `user_7@company.com` -> `u***@company.com`. Applied when the caller lacks `pii:read`.
 *
 * Only the first character and the domain survive, and the number of stars is fixed. Keeping
 * the last character or the length would let a viewer tell `user_7` from `user_12`, which for
 * a small set of owners is the same as not masking at all.
 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}
