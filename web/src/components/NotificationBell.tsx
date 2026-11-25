import { useState } from 'react';
import { Bell, CheckCheck } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api/client';

type Notice = { id: string; kind: string; message: string; createdAt: string; readAt: string | null };
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const cache = useQueryClient();
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ notifications: Notice[] }>('/notifications'),
    refetchInterval: 30_000
  });
  const notices = data?.notifications ?? [];
  const unread = notices.filter((item) => !item.readAt).length;
  async function markAll() {
    await api('/notifications/read-all', { method: 'POST' });
    await cache.invalidateQueries({ queryKey: ['notifications'] });
  }
  async function markOne(id: string) {
    await api(`/notifications/${id}/read`, { method: 'PATCH' });
    await cache.invalidateQueries({ queryKey: ['notifications'] });
  }
  return <div className="notification-wrap">
    <button className="icon-button notification-button" aria-label={`Notifikasi, ${unread} belum dibaca`}
      aria-expanded={open} onClick={() => setOpen(!open)}>
      <Bell size={18} />{unread > 0 && <span className="notification-count">{unread}</span>}
    </button>
    {open && <div className="notification-popover glass-panel">
      <div className="notification-head"><strong>Notifikasi</strong>
        <button className="text-button" onClick={() => void markAll()}><CheckCheck size={15} /> Tandai dibaca</button></div>
      {notices.length === 0 ? <p className="muted small">Belum ada notifikasi.</p> :
        notices.slice(0, 12).map((notice) => <button key={notice.id} className={`notice-item ${notice.readAt ? '' : 'unread'}`}
          onClick={() => void markOne(notice.id)}>
          <span className={`notice-dot ${notice.kind}`} />
          <span><span>{notice.message}</span><small>{new Date(notice.createdAt).toLocaleString('id-ID')}</small></span>
        </button>)}
    </div>}
  </div>;
}
