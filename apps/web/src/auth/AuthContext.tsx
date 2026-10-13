import type { AuthConfig, AuthResponse, Permission, User } from '@picc/contracts';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { api, refreshSession, setAccessToken, setSessionLostHandler } from '../lib/api';

interface AuthValue {
  user: User | null;
  /** True until the first attempt to restore a session from the refresh cookie finishes. */
  restoring: boolean;
  config: AuthConfig | null;
  can: (permission: Permission) => boolean;
  login: (email: string, password: string) => Promise<void>;
  demoLogin: (email: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const queryClient = useQueryClient();

  const accept = useCallback(
    (session: AuthResponse) => {
      setAccessToken(session.accessToken);
      // Nothing cached for the previous user may be shown to the next one.
      queryClient.clear();
      setUser(session.user);
    },
    [queryClient],
  );

  const drop = useCallback(() => {
    setAccessToken(null);
    queryClient.clear();
    setUser(null);
  }, [queryClient]);

  useEffect(() => {
    setSessionLostHandler(drop);
    void api
      .get<AuthConfig>('/auth/config')
      .then(setConfig)
      .catch(() => setConfig({ demoMode: false, personas: [] }));
    void refreshSession()
      .then((session) => session && setUser(session.user))
      .finally(() => setRestoring(false));
    return () => setSessionLostHandler(null);
  }, [drop]);

  const value = useMemo<AuthValue>(
    () => ({
      user,
      restoring,
      config,
      can: (permission) => user?.permissions.includes(permission) ?? false,
      login: async (email, password) =>
        accept(await api.post<AuthResponse>('/auth/login', { email, password })),
      demoLogin: async (email) =>
        accept(await api.post<AuthResponse>('/auth/demo-login', { email })),
      logout: async () => {
        await api.post('/auth/logout').catch(() => undefined);
        drop();
      },
    }),
    [user, restoring, config, accept, drop],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
