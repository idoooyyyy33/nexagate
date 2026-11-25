import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Device, type User } from './client';

export function useSession() {
  return useQuery({
    queryKey: ['session'],
    queryFn: () => api<{ user: User }>('/auth/me'),
    retry: false,
    staleTime: 60_000
  });
}

export function useDevices() {
  return useQuery({ queryKey: ['devices'], queryFn: () => api<{ devices: Device[] }>('/dashboard/summary') });
}

export function useLogs(params = '') {
  return useQuery({ queryKey: ['logs', params], queryFn: () => api<{ logs: any[]; total: number; page: number; limit: number }>(`/access-logs${params}`) });
}

export function useInvalidateLiveData() {
  const query = useQueryClient();
  return () => {
    void query.invalidateQueries({ queryKey: ['devices'] });
    void query.invalidateQueries({ queryKey: ['logs'] });
  };
}
