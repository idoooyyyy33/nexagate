import { lazy, Suspense, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '../lib/api/hooks';
import { socket } from '../lib/api/socket';
import { Layout } from '../components/Layout';
import { LoadingState } from '../components/ui';
const Login = lazy(() => import('./Login'));
const Dashboard = lazy(() => import('./Dashboard'));
const Cards = lazy(() => import('./Cards'));
const Logs = lazy(() => import('./Logs'));
const Settings = lazy(() => import('./Settings'));
const Users = lazy(() => import('./Users'));
const Audit = lazy(() => import('./Audit'));

export default function App() {
  const session = useSession();
  const location = useLocation();
  const cache = useQueryClient();
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    localStorage.getItem('rfid-theme') === 'light' ? 'light' : 'dark');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('rfid-theme', theme);
  }, [theme]);
  useEffect(() => {
    if (session.data?.user) {
      socket.connect();
      const refresh = () => {
        void cache.invalidateQueries({ queryKey: ['devices'] });
        void cache.invalidateQueries({ queryKey: ['logs'] });
        void cache.invalidateQueries({ queryKey: ['notifications'] });
        void cache.invalidateQueries({ queryKey: ['cards'] });
      };
      socket.on('device:status', refresh);
      socket.on('access:new', refresh);
      socket.on('notification:new', refresh);
      return () => { socket.off('device:status', refresh); socket.off('access:new', refresh); socket.off('notification:new', refresh); socket.disconnect(); };
    }
    return;
  }, [session.data?.user, cache]);

  if (session.isLoading) return <LoadingState />;
  if (!session.data && location.pathname !== '/login') return <Navigate to="/login" replace />;
  if (session.data && location.pathname === '/login') return <Navigate to="/" replace />;
  const user = session.data?.user;
  if (!user) return <Suspense fallback={<LoadingState />}><Routes><Route path="/login" element={<Login />} /><Route path="*" element={<Navigate to="/login" replace />} /></Routes></Suspense>;
  return <Suspense fallback={<LoadingState />}><Routes><Route element={<Layout user={user} theme={theme} onThemeChange={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />}>
    <Route path="/" element={<Dashboard user={user} />} />
    <Route path="/cards" element={<Cards user={user} />} />
    <Route path="/history" element={<Logs />} />
    <Route path="/settings" element={user.role === 'admin' ? <Settings /> : <Navigate to="/" replace />} />
    <Route path="/users" element={user.role === 'admin' ? <Users /> : <Navigate to="/" replace />} />
    <Route path="/audit" element={user.role === 'admin' ? <Audit /> : <Navigate to="/" replace />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Route></Routes></Suspense>;
}
