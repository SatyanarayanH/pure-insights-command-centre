import type { Persona } from '@picc/contracts';
import { Coins, Eye, ShieldCheck, UserCheck } from 'lucide-react';
import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { Button, inputClass, Select } from '../components/ui';

const ROLE_ICON: Record<Persona['role'], ReactNode> = {
  admin: <ShieldCheck size={18} />,
  finops: <Coins size={18} />,
  owner: <UserCheck size={18} />,
  viewer: <Eye size={18} />,
};

export function LoginPage() {
  const { login, demoLogin, config } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const personas = config?.personas ?? [];
  const staff = useMemo(() => personas.filter((p) => p.role !== 'owner'), [personas]);
  const owners = useMemo(() => personas.filter((p) => p.role === 'owner'), [personas]);
  const [ownerEmail, setOwnerEmail] = useState('');
  const selectedOwner =
    owners.find((o) => o.email === ownerEmail) ??
    owners.find((o) => o.email === 'user_7@company.com') ??
    owners[0];

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed');
    } finally {
      setBusy(null);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void run('password', () => login(email, password));
  };

  return (
    <div className="grid min-h-full lg:grid-cols-[1.1fr_1fr]">
      <div className="flex flex-col justify-between bg-[#0b0b0b] px-10 py-10 text-white max-lg:hidden">
        <div className="flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="h-8 w-8" />
          <span className="text-[15px] font-semibold">Pure Insights Command Centre</span>
        </div>
        <div className="max-w-lg">
          <h1 className="text-[34px] leading-[1.15] font-semibold tracking-tight">
            The admin view the portal lost when it left Tableau Server.
          </h1>
          <ul className="mt-8 space-y-4 text-[15px] text-white/75">
            <li>
              <span className="font-medium text-white">Health.</span> Refresh failures and slow
              dashboards, alerted in real time and grouped so the feed stays readable.
            </li>
            <li>
              <span className="font-medium text-white">Ownership.</span> Orphaned reports ranked by
              what they cost, each with a suggested owner.
            </li>
            <li>
              <span className="font-medium text-white">Cost.</span> Snowflake credits attributed to
              individual reports, reconciled to the metered bill.
            </li>
          </ul>
        </div>
        <div className="text-[12.5px] text-white/50">
          Case Study 3 · Technical Data AI Validation · 100 reports, 20 periods
        </div>
      </div>

      <div className="flex items-center justify-center px-6 py-10">
        <div className="w-full max-w-md">
          <h2 className="text-[22px] font-semibold tracking-tight">Sign in</h2>

          {config?.demoMode && personas.length > 0 && (
            <div className="mt-6">
              <div className="text-[13px] font-medium text-ink">Demo personas</div>
              <p className="mt-0.5 text-[13px] text-ink-2">
                One click each. Sign in as different roles to see what changes.
              </p>
              <div className="mt-3 space-y-2">
                {staff.map((persona) => (
                  <button
                    key={persona.email}
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void run(persona.email, () => demoLogin(persona.email))}
                    className="flex w-full items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left transition-colors hover:border-line-2 hover:bg-surface-2 disabled:opacity-60"
                  >
                    <span className="mt-0.5 text-ink-2">{ROLE_ICON[persona.role]}</span>
                    <span className="min-w-0">
                      <span className="block text-[14px] font-medium text-ink">
                        {persona.roleLabel}
                      </span>
                      <span className="block text-[12.5px] text-ink-2">{persona.description}</span>
                    </span>
                  </button>
                ))}
                {selectedOwner && (
                  <div className="rounded-xl border border-line bg-surface px-4 py-3">
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 text-ink-2">{ROLE_ICON.owner}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-medium text-ink">
                          {selectedOwner.roleLabel}
                        </div>
                        <div className="text-[12.5px] text-ink-2">{selectedOwner.description}</div>
                        <div className="mt-2.5 flex gap-2">
                          <Select
                            aria-label="Report owner account"
                            value={selectedOwner.email}
                            onChange={(e) => setOwnerEmail(e.target.value)}
                            className="min-w-0 flex-1"
                          >
                            {owners.map((owner) => (
                              <option key={owner.email} value={owner.email}>
                                {owner.email}
                              </option>
                            ))}
                          </Select>
                          <Button
                            variant="primary"
                            busy={busy === 'owner'}
                            disabled={busy !== null}
                            onClick={() => void run('owner', () => demoLogin(selectedOwner.email))}
                          >
                            Sign in
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              <div className="my-6 flex items-center gap-3 text-[12px] text-ink-3">
                <span className="h-px flex-1 bg-line" /> or with a password{' '}
                <span className="h-px flex-1 bg-line" />
              </div>
            </div>
          )}

          <form onSubmit={onSubmit} className={config?.demoMode ? '' : 'mt-6'}>
            <label className="block text-[13px] font-medium text-ink" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={`${inputClass} mt-1 w-full`}
              placeholder="admin@company.com"
            />
            <label className="mt-3 block text-[13px] font-medium text-ink" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={`${inputClass} mt-1 w-full`}
            />
            <Button
              type="submit"
              variant="primary"
              className="mt-4 w-full"
              busy={busy === 'password'}
              disabled={busy !== null}
            >
              Sign in
            </Button>
          </form>

          {error && (
            <div
              role="alert"
              className="mt-4 rounded-lg bg-critical-wash px-3.5 py-2.5 text-[13px] text-critical-ink"
            >
              {error}
            </div>
          )}
          {config?.demoMode && (
            <p className="mt-5 text-[12px] text-ink-3">
              Demo mode is on. One-click sign-in exists only while the server runs with{' '}
              <code className="font-mono">DEMO_MODE=true</code>.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
