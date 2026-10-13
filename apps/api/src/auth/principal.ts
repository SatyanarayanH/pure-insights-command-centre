import {
  type DataScope,
  type Permission,
  permissionsFor,
  ROLE_DEFINITIONS,
  type Role,
  scopeFor,
  type User,
} from '@picc/contracts';

/** The authenticated caller. `service` is a machine identity (the portal pushing telemetry). */
export interface Principal {
  kind: 'user' | 'service';
  id: string;
  email: string;
  name: string;
  role: Role | 'service';
  scope: DataScope;
  permissions: ReadonlySet<Permission>;
}

export function userPrincipal(user: {
  id: string;
  email: string;
  name: string;
  role: Role;
}): Principal {
  return {
    kind: 'user',
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    scope: scopeFor(user.role),
    permissions: new Set(permissionsFor(user.role)),
  };
}

export const SERVICE_PRINCIPAL: Principal = {
  kind: 'service',
  id: 'svc-portal-telemetry',
  email: 'portal-telemetry@service',
  name: 'Portal telemetry emitter',
  role: 'service',
  scope: 'all',
  permissions: new Set<Permission>(['telemetry:ingest']),
};

export const can = (principal: Principal, permission: Permission): boolean =>
  principal.permissions.has(permission);

export function toUserDto(user: { id: string; email: string; name: string; role: Role }): User {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    roleLabel: ROLE_DEFINITIONS[user.role].label,
    scope: scopeFor(user.role),
    permissions: [...permissionsFor(user.role)],
  };
}
