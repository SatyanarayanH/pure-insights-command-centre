import type { AuthResponse, Problem } from '@picc/contracts';

export const API_BASE = '/api/v1';

/** An API failure, carrying the server's RFC 9457 problem body when there is one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Problem | null,
  ) {
    super(problem?.detail ?? problem?.title ?? `Request failed (${status})`);
  }

  get fieldErrors(): string[] {
    return this.problem?.errors?.map((e) => `${e.path}: ${e.message}`) ?? [];
  }
}

/**
 * The access token lives in memory only: never localStorage, so script injected into the page
 * cannot lift a long-lived credential. A page reload restores the session from the httpOnly
 * refresh cookie instead.
 */
let accessToken: string | null = null;
let refreshing: Promise<AuthResponse | null> | null = null;
let onSessionLost: (() => void) | null = null;
let onSessionReplaced: ((session: AuthResponse) => void) | null = null;
let currentUserId: string | null = null;

export const setAccessToken = (token: string | null): void => {
  accessToken = token;
};
export const setSessionLostHandler = (handler: (() => void) | null): void => {
  onSessionLost = handler;
};
/** Called when a refresh comes back as a different user: another window signed in as someone
 *  else, and the shared cookie now belongs to them. */
export const setSessionReplacedHandler = (
  handler: ((session: AuthResponse) => void) | null,
): void => {
  onSessionReplaced = handler;
};
export const setCurrentUserId = (id: string | null): void => {
  currentUserId = id;
};

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // A proxy or gateway answered instead of the API (for example while the API is starting).
    throw new ApiError(res.status, null);
  }
  if (!res.ok) throw new ApiError(res.status, body as Problem | null);
  return body as T;
}

/** True when the server has told this browser that a session may exist. Lets a first-time
 *  visitor skip a refresh call that could only come back 401. */
export const mayHaveSession = (): boolean =>
  document.cookie.split('; ').includes('picc_signed_in=1');

/** One refresh at a time, however many requests hit a 401 together. */
export function refreshSession(): Promise<AuthResponse | null> {
  refreshing ??= fetch(`${API_BASE}/auth/refresh`, { method: 'POST', credentials: 'same-origin' })
    .then(async (res) => {
      if (!res.ok) return null;
      const session = (await res.json()) as AuthResponse;
      accessToken = session.accessToken;
      if (currentUserId !== null && session.user.id !== currentUserId) onSessionReplaced?.(session);
      return session;
    })
    .catch(() => null)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

async function request<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  // An expired access token is refreshed once, transparently, and the request replayed.
  if (res.status === 401 && retry && !path.startsWith('/auth/')) {
    const session = await refreshSession();
    if (session) return request<T>(method, path, body, false);
    onSessionLost?.();
  }
  return parse<T>(res);
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown = {}) => request<T>('PUT', path, body),
};

export function query(
  params: Record<string, string | number | boolean | undefined | null>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}
