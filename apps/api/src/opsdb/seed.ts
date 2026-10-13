import { type Persona, ROLE_DEFINITIONS, type Role } from '@picc/contracts';
import { hashPassword } from '../auth/passwords.js';
import type { UserRepository } from './repositories.js';

export interface SeedUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

const STAFF: readonly SeedUser[] = [
  { id: 'usr_admin', email: 'admin@company.com', name: 'Platform Admin', role: 'admin' },
  { id: 'usr_finops', email: 'finops@company.com', name: 'FinOps Analyst', role: 'finops' },
  { id: 'usr_viewer', email: 'viewer@company.com', name: 'Portal Viewer', role: 'viewer' },
];

/** Every distinct owner address in the dataset becomes a Report Owner account, so signing in
 *  as `user_7@company.com` shows exactly the reports that address owns. */
export function demoUsers(ownerEmails: readonly string[]): SeedUser[] {
  const owners = [...new Set(ownerEmails)]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((email) => {
      const local = email.split('@')[0] ?? email;
      const number = local.replace(/\D+/g, '');
      return {
        id: `usr_${local}`,
        email,
        name: number ? `Report Owner ${number}` : local,
        role: 'owner' as const,
      };
    });
  return [...STAFF, ...owners];
}

export function seedDemoUsers(
  users: UserRepository,
  seed: readonly SeedUser[],
  password: string,
  now: string,
): void {
  // One hash for all demo accounts: they share the demo password, and scrypt is slow by design.
  const passwordHash = hashPassword(password);
  for (const user of seed) {
    if (users.findById(user.id)) continue;
    users.upsert({ ...user, password_hash: passwordHash, created_at: now });
  }
}

export function toPersona(user: SeedUser): Persona {
  const definition = ROLE_DEFINITIONS[user.role];
  return {
    email: user.email,
    name: user.name,
    role: user.role,
    roleLabel: definition.label,
    description: definition.description,
  };
}
