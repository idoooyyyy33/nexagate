import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Activity, BadgeCheck, Cloud, CloudOff, DoorOpen, FileClock, LayoutDashboard, LogOut, Mail, Menu, Moon, RefreshCw, Settings2, ShieldCheck, Sun, Users, X } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type User } from '../lib/api/client';
import { NotificationBell } from './NotificationBell';

const links = [
  { to: '/', label: 'Ringkasan', icon: LayoutDashboard, roles: ['admin', 'operator', 'viewer'] },
  { to: '/cards', label: 'Kartu akses', icon: BadgeCheck, roles: ['admin', 'operator', 'viewer'] },
  { to: '/history', label: 'Riwayat akses', icon: FileClock, roles: ['admin', 'operator', 'viewer'] },
  { to: '/settings', label: 'Perangkat', icon: Settings2, roles: ['admin'] },
  { to: '/users', label: 'Pengguna', icon: Users, roles: ['admin'] },
  { to: '/audit', label: 'Audit', icon: ShieldCheck, roles: ['admin'] }
];

export function Layout({ user, theme, onThemeChange }: {
  user: User; theme: 'dark' | 'light'; onThemeChange: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const cache = useQueryClient();
  const providers = useQuery({ queryKey: ['auth-providers'], queryFn: () => api<{ google: boolean }>('/auth/providers') });
  const syncStatus = useQuery({
    queryKey: ['sync-status'],
    queryFn: () => api<{ enabled: boolean; online: boolean; pendingCount: number; lastSyncAt: string | null }>('/sync/status'),
    refetchInterval: 10_000
  });
  const [syncingNow, setSyncingNow] = useState(false);
  async function triggerSync() {
    setSyncingNow(true);
    try {
      await api('/sync/now', { method: 'POST' });
      await cache.invalidateQueries({ queryKey: ['sync-status'] });
    } finally {
      setSyncingNow(false);
    }
  }
  const now = new Date();
  async function logout() {
    await api('/auth/logout', { method: 'POST' });
    await cache.clear();
    navigate('/login');
  }
  async function unlinkGoogle() {
    await api('/auth/google/unlink', { method: 'POST' });
    await cache.invalidateQueries({ queryKey: ['session'] });
    await cache.invalidateQueries({ queryKey: ['users'] });
  }
  return <div className={`app-shell theme-${theme}`}>
    <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
      <div className="brand"><div className="brand-mark"><DoorOpen size={22} /></div>
        <div><strong>Nexa<span>Gate</span></strong><small>SMART ENTRY SYSTEM</small></div>
        <button className="mobile-close icon-button" aria-label="Tutup menu" onClick={() => setMenuOpen(false)}><X size={19} /></button>
      </div>
      <div className="sidebar-label">MENU UTAMA</div>
      <nav className="nav-list" aria-label="Navigasi utama">
        {links.filter((link) => link.roles.includes(user.role)).map(({ to, label, icon: Icon }) =>
          <NavLink key={to} to={to} end={to === '/'} onClick={() => setMenuOpen(false)}
            className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <Icon size={18} strokeWidth={1.8} /><span>{label}</span>{to === '/' && <span className="nav-live" />}
          </NavLink>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="security-note"><Activity size={17} /><div><strong>Mode aman aktif</strong><small>Broker privat terhubung</small></div></div>
        {syncStatus.data?.enabled && (
          <div className="security-note">
            {syncStatus.data.online ? <Cloud size={17} /> : <CloudOff size={17} />}
            <div style={{ minWidth: 0, flex: 1 }}>
              <strong>{syncStatus.data.online ? 'Cloud Supabase aktif' : 'Cloud offline (antre)'}</strong>
              <small>
                {syncStatus.data.pendingCount > 0
                  ? `${syncStatus.data.pendingCount} data menunggu sync`
                  : syncStatus.data.online
                    ? 'Tersinkron otomatis'
                    : 'Tersimpan aman di lokal'}
              </small>
            </div>
            {user.role === 'admin' && (
              <button type="button" className="icon-button" title="Sinkronkan sekarang" disabled={syncingNow}
                onClick={() => void triggerSync()} style={{ width: 28, height: 28 }}>
                <RefreshCw size={13} className={syncingNow ? 'spin' : ''} />
              </button>
            )}
          </div>
        )}
        {providers.data?.google && (
          <div className="security-note">
            <Mail size={17} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <strong>{user.email ? 'Gmail tertaut' : 'Gmail belum tertaut'}</strong>
              <small style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {user.email ? user.email : 'Tautkan untuk login & terima log'}
              </small>
            </div>
            {user.email
              ? <button type="button" className="button button-quiet" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => void unlinkGoogle()}>Putus</button>
              : <a className="button button-quiet" style={{ padding: '4px 8px', fontSize: 11, textDecoration: 'none' }}
                  href={`/api/auth/google/link?returnTo=${encodeURIComponent(location.pathname)}`}>Tautkan</a>}
          </div>
        )}
        <div className="user-card"><div className="avatar">{user.username.slice(0, 1).toUpperCase()}</div>
          <div className="user-meta"><strong>{user.username}</strong><small>{user.role}</small></div>
          <button className="icon-button logout-button" title="Keluar" onClick={() => void logout()}><LogOut size={17} /></button>
        </div>
      </div>
    </aside>
    {menuOpen && <button className="mobile-scrim" aria-label="Tutup menu" onClick={() => setMenuOpen(false)} />}
    <main className="main-area">
      <header className="topbar">
        <div className="topbar-left"><button className="mobile-menu icon-button" aria-label="Buka menu" onClick={() => setMenuOpen(true)}><Menu size={20} /></button>
          <div><div className="topbar-caption">PANEL KONTROL <span className="caption-dot" /> LIVE</div>
            <time className="topbar-clock">{now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false })}</time></div>
        </div>
        <div className="topbar-tools"><span className="topbar-date">{now.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
          <button className="icon-button" aria-label={theme === 'dark' ? 'Pakai tema terang' : 'Pakai tema gelap'} onClick={onThemeChange}>
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <NotificationBell />
        </div>
      </header>
      <div className="page-content"><Outlet /></div>
      <footer className="app-footer"><span>NEXAGATE <span className="footer-separator">/</span> SISTEM KONTROL PINTU RFID</span><span><Activity size={13} /> Offline-first · Aman</span></footer>
    </main>
  </div>;
}
