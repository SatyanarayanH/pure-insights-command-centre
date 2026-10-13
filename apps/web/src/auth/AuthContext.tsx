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
import {
  api,
  mayHaveSession,
  refreshSession,
  setAccessToken,
  setCurrentUserId,
  setSessionLostHandler,
  setSessionReplacedHandler,
} from '../lib/api';

interface AuthValue {
  user: User | null;
  /** True until the first attempt to restore a session from the refresh cookie finishes. */
  restoring: boolean;
  config: AuthConfig | null;
  /** True while the API is not answering yet (it builds the warehouse on first start). */
  apiStarting: boolean;
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
  const [apiStarting, setApiStarting] = useState(false);
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
    setCurrentUserId(user?.id ?? null);
  }, [user]);

  useEffect(() => {
    setSessionLostHandler(drop);
    setSessionReplacedHandler(accept);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // On a first start the API spends some seconds building the warehouse before it listens.
    // Keep asking until it answers, rather than concluding that sign-in options do not exist.
    const loadConfig = (attempt: number): void => {
      api
        .get<AuthConfig>('/auth/config')
        .then((loaded) => {
          if (cancelled) return;
          setConfig(loaded);
          setApiStarting(false);
        })
        .catch(() => {
          if (cancelled) return;
          setApiStarting(true);
          timer = setTimeout(() => loadConfig(attempt + 1), Math.min(4000, 800 + attempt * 400));
        });
    };
    loadConfig(0);

    if (mayHaveSession()) {
      void refreshSession()
        .then((session) => !cancelled && session && setUser(session.user))
        .finally(() => !cancelled && setRestoring(false));
    } else {
      setRestoring(false);
    }
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      setSessionLostHandler(null);
      setSessionReplacedHandler(null);
    };
  }, [drop, accept]);

  const value = useMemo<AuthValue>(
    () => ({
      user,
      restoring,
      config,
      apiStarting,
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
    [user, restoring, config, apiStarting, accept, drop],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
