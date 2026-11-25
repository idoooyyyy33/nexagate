const base = import.meta.env.VITE_API_BASE ?? '/api';

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...init.headers }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'Permintaan gagal' }));
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export type User = { id: string; username: string; role: 'admin' | 'operator' | 'viewer'; email?: string | null };
export type Device = {
  id: string; name: string; timezone: string; last_seen_at: string | null;
  door_state: 'open' | 'closed'; remaining_seconds: number; wifi_rssi: number | null;
  online: boolean; cardCount: number; today: { total: number; accepted: number; denied: number };
};
