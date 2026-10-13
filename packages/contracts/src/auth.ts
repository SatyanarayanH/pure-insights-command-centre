import { z } from 'zod';
import { PermissionSchema, RoleSchema } from './rbac.js';

export const UserSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    role: RoleSchema,
    roleLabel: z.string(),
    scope: z.enum(['all', 'own']),
    permissions: z.array(PermissionSchema),
  })
  .meta({ id: 'User' });
export type User = z.infer<typeof UserSchema>;

export const LoginRequestSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(1).max(200),
});

export const DemoLoginRequestSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
});

export const AuthResponseSchema = z
  .object({
    accessToken: z.string().meta({ description: 'Short-lived JWT. Send as `Authorization: Bearer <token>`.' }),
    expiresIn: z.number().int().meta({ description: 'Seconds until the access token expires.' }),
    user: UserSchema,
  })
  .meta({ id: 'AuthResponse' });
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

export const PersonaSchema = z
  .object({
    email: z.string(),
    name: z.string(),
    role: RoleSchema,
    roleLabel: z.string(),
    description: z.string(),
  })
  .meta({ id: 'Persona' });
export type Persona = z.infer<typeof PersonaSchema>;

export const AuthConfigSchema = z.object({
  demoMode: z.boolean(),
  personas: z.array(PersonaSchema),
});
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

export const RealtimeTicketSchema = z
  .object({
    ticket: z.string().meta({ description: 'Single-use ticket, valid for 30 seconds.' }),
    expiresIn: z.number().int(),
    wsPath: z.string(),
    ssePath: z.string(),
  })
  .meta({ id: 'RealtimeTicket' });
export type RealtimeTicket = z.infer<typeof RealtimeTicketSchema>;
