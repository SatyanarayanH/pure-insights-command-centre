import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { RoleSchema, type Role } from '@picc/contracts';
import { jwtVerify, SignJWT } from 'jose';
import type { Config } from '../config.js';
import { SERVICE_NAME } from '../config.js';
import type { OpsDb } from '../opsdb/db.js';

export interface AccessClaims {
  sub: string;
  email: string;
  name: string;
  role: Role;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * Access tokens are short-lived JWTs held in memory by the browser. Refresh tokens are opaque,
 * stored only as a hash, delivered in an httpOnly cookie and rotated on every use. Presenting
 * a refresh token that was already rotated revokes its whole family, which is what turns a
 * stolen cookie into a detectable event instead of a silent second session.
 */
export class TokenService {
  private readonly key: Uint8Array;

  constructor(
    private readonly config: Pick<Config, 'jwtSecret' | 'accessTokenTtlSec' | 'refreshTokenTtlDays'>,
    private readonly db: OpsDb,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.key = new TextEncoder().encode(config.jwtSecret);
  }

  async issueAccessToken(claims: AccessClaims): Promise<string> {
    const issuedAt = Math.floor(this.now().getTime() / 1000);
    return new SignJWT({ email: claims.email, name: claims.name, role: claims.role })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.sub)
      .setIssuer(SERVICE_NAME)
      .setAudience(SERVICE_NAME)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + this.config.accessTokenTtlSec)
      .sign(this.key);
  }

  async verifyAccessToken(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: SERVICE_NAME,
        audience: SERVICE_NAME,
        algorithms: ['HS256'],
        currentDate: this.now(),
      });
      const role = RoleSchema.safeParse(payload.role);
      if (!payload.sub || typeof payload.email !== 'string' || !role.success) return null;
      return { sub: payload.sub, email: payload.email, name: String(payload.name ?? ''), role: role.data };
    } catch {
      return null;
    }
  }

  issueRefreshToken(userId: string, familyId: string = randomUUID()): string {
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    const expires = new Date(now.getTime() + this.config.refreshTokenTtlDays * 86_400_000);
    this.db.run(
      'INSERT INTO refresh_tokens (token_hash, user_id, family_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      sha256(token),
      userId,
      familyId,
      now.toISOString(),
      expires.toISOString(),
    );
    return token;
  }

  /** Exchanges a refresh token for a new one. Returns null if it is unknown, expired or reused. */
  rotateRefreshToken(token: string): { userId: string; refreshToken: string } | null {
    const row = this.db.get<{ user_id: string; family_id: string; expires_at: string; revoked_at: string | null }>(
      'SELECT user_id, family_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = ?',
      sha256(token),
    );
    if (!row) return null;
    const now = this.now().toISOString();
    if (row.revoked_at) {
      // Reuse of a rotated token: assume theft and end every session in the family.
      this.db.run('UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL', now, row.family_id);
      return null;
    }
    if (row.expires_at <= now) return null;
    this.db.run('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?', now, sha256(token));
    return { userId: row.user_id, refreshToken: this.issueRefreshToken(row.user_id, row.family_id) };
  }

  revokeRefreshToken(token: string): void {
    const row = this.db.get<{ family_id: string }>(
      'SELECT family_id FROM refresh_tokens WHERE token_hash = ?',
      sha256(token),
    );
    if (row) {
      this.db.run(
        'UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL',
        this.now().toISOString(),
        row.family_id,
      );
    }
  }
}
