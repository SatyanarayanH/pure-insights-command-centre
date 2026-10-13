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

/** `user_7@company.com` -> `u****7@company.com`. Applied when the caller lacks `pii:read`. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const masked =
    local.length <= 2
      ? `${local[0]}*`
      : `${local[0]}${'*'.repeat(local.length - 2)}${local.at(-1)}`;
  return `${masked}${email.slice(at)}`;
}
