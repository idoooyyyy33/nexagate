import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Activity, BadgeCheck, CircleAlert, DoorClosed, DoorOpen, Radio, ShieldCheck, Wifi, WifiOff } from 'lucide-react';
import { api, type Device, type User } from '../lib/api/client';
import { useDevices } from '../lib/api/hooks';
import { Button, EmptyState, ErrorMessage, LoadingState, PageTitle, Panel } from '../components/ui';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { VoiceAssistant } from '../components/VoiceAssistant';

type Charts = { hours: { label: string; total: number; accepted: number; denied: number }[]; days: { label: string; total: number; accepted: number; denied: number }[]; busiestHour: { hour: string; total: number } | null };
export default function Dashboard({ user }: { user: User }) {
  const devicesQuery = useDevices();
  const devices = devicesQuery.data?.devices ?? [];
  const [selected, setSelected] = useState('');
  const [range, setRange] = useState<'7d' | '30d'>('7d');
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState('');
  const [now, setNow] = useState(Date.now());
  const cache = useQueryClient();
  const deviceId = selected || devices[0]?.id || '';
  const chartsQuery = useQuery({
    queryKey: ['charts', deviceId, range],
    queryFn: () => api<Charts>(`/dashboard/charts?deviceId=${deviceId}&range=${range}`),
    enabled: Boolean(deviceId)
  });
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const device = devices.find((item) => item.id === deviceId);
  const countdown = useMemo(() => {
    if (!device || device.door_state !== 'open') return 0;
    const elapsed = device.last_seen_at ? Math.max(0, Math.floor((now - Date.parse(device.last_seen_at)) / 1000)) : 0;
    return Math.max(0, device.remaining_seconds - elapsed);
  }, [device, now]);

  async function executeOpenDoor() {
    if (!device) return { ok: false, message: 'Perangkat tidak ditemukan.' };
    setConfirm(false); setMessage('Mengirim perintah dan menunggu konfirmasi perangkat…');
    try {
      const result = await api<{ ok: boolean; message?: string }>(`/devices/${device.id}/commands/open`, {
        method: 'POST', body: JSON.stringify({ confirm: true })
      });
      setMessage(result.ok ? 'Pintu berhasil dibuka oleh perangkat.' : result.message ?? 'Perangkat tidak mengonfirmasi perintah.');
      await cache.invalidateQueries({ queryKey: ['devices'] });
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Perintah gagal dikirim.';
      setMessage(msg);
      return { ok: false, message: msg };
    }
  }

  async function openDoor() {
    await executeOpenDoor();
  }

  if (devicesQuery.isLoading) return <LoadingState />;
  if (devicesQuery.isError) return <ErrorMessage>{(devicesQuery.error as Error).message}</ErrorMessage>;
  if (!devices.length) return <EmptyState>Belum ada perangkat. Tambahkan perangkat di pengaturan.</EmptyState>;

  return <div className="page-stack">
    <PageTitle eyebrow="PUSAT OPERASI" title="Ringkasan akses" description="Pantau status pintu dan aktivitas akses secara langsung."
      action={<label className="select-wrap"><span className="sr-only">Pilih perangkat</span><select value={deviceId} onChange={(event) => setSelected(event.target.value)}>
        {devices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>} />
    {message && <div className="inline-result" role="status">{message}<button aria-label="Tutup" onClick={() => setMessage('')}>×</button></div>}
    {device && <div className="dashboard-grid">
      <Panel className="door-panel">
        <div className="panel-kicker"><span className={`live-badge ${device.online ? 'online' : 'offline'}`}><i />{device.online ? 'PERANGKAT ONLINE' : 'PERANGKAT OFFLINE'}</span>
          <span className="door-updated">{device.last_seen_at ? `Terakhir aktif ${new Date(device.last_seen_at).toLocaleTimeString('id-ID')}` : 'Belum ada sinyal'}</span></div>
        <div className={`door-orbit ${device.door_state === 'open' ? 'is-open' : 'is-closed'}`}>
          <div className="orbit-ring"><div className="orbit-center">{device.door_state === 'open' ? <DoorOpen size={36} /> : <DoorClosed size={36} />}</div></div>
          <div className="orbit-tag">{device.door_state === 'open' ? 'AKSES TERBUKA' : 'TERKUNCI'}</div>
        </div>
        <div className="door-state-copy"><h2>{device.door_state === 'open' ? 'Pintu terbuka' : 'Pintu terkunci'}</h2>
          <p>{device.door_state === 'open' ? `Mengunci otomatis dalam ${countdown} detik` : 'Sistem siap menerima kartu terdaftar'}</p></div>
        <div className="door-controls">{user.role !== 'viewer' && <Button className="button-primary open-button" onClick={() => setConfirm(true)}>
          <DoorOpen size={17} /> Buka pintu
        </Button>}
          <div className="device-signal"><span className={`signal-icon ${device.online ? '' : 'muted'}`}>{device.online ? <Wifi size={16} /> : <WifiOff size={16} />}</span>
            <span>{device.wifi_rssi !== null ? `${device.wifi_rssi} dBm` : 'Wi-Fi —'}</span></div></div>
      </Panel>
      <div className="stats-column">
        <Panel className="stat-card stat-cyan"><div className="stat-icon"><Activity size={18} /></div><div className="stat-label">AKSES HARI INI</div>
          <div className="stat-value">{device.today.total}<span className="stat-unit">akses</span></div>
          <div className="stat-foot"><span className="success-text">{device.today.accepted} diterima</span><span className="stat-sep">/</span><span className="danger-text">{device.today.denied} ditolak</span></div></Panel>
        <Panel className="stat-card stat-green"><div className="stat-icon"><BadgeCheck size={18} /></div><div className="stat-label">KARTU AKTIF</div>
          <div className="stat-value">{device.cardCount}<span className="stat-unit">kartu</span></div>
          <div className="stat-foot"><span className="muted"><ShieldCheck size={13} /> Terdaftar di sistem</span></div></Panel>
        <Panel className={`stat-card ${device.online ? 'stat-blue' : 'stat-amber'}`}><div className="stat-icon">{device.online ? <Radio size={18} /> : <CircleAlert size={18} />}</div>
          <div className="stat-label">KONEKSI ALAT</div><div className="stat-value stat-status">{device.online ? 'Online' : 'Offline'}</div>
          <div className="stat-foot"><span className="muted">{device.name}</span></div></Panel>
      </div>
      <VoiceAssistant device={device} user={user} onOpenDoor={executeOpenDoor} />
      <Panel className="chart-panel chart-wide"><div className="panel-heading"><div><div className="eyebrow">AKTIVITAS</div><h3>Tren akses</h3></div>
        <div className="segmented-control"><button className={range === '7d' ? 'selected' : ''} onClick={() => setRange('7d')}>7 hari</button>
          <button className={range === '30d' ? 'selected' : ''} onClick={() => setRange('30d')}>30 hari</button></div></div>
        <div className="chart-legend"><span><i className="legend-dot accepted" />Diterima</span><span><i className="legend-dot denied" />Ditolak</span></div>
        <div className="chart-area">{chartsQuery.isLoading ? <LoadingState /> : <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartsQuery.data?.days ?? []} margin={{ left: -18, right: 8, top: 8 }}>
            <defs><linearGradient id="okFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#52dfc0" stopOpacity={0.28} /><stop offset="100%" stopColor="#52dfc0" stopOpacity={0} /></linearGradient>
              <linearGradient id="denyFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#ff7d89" stopOpacity={0.18} /><stop offset="100%" stopColor="#ff7d89" stopOpacity={0} /></linearGradient></defs>
            <CartesianGrid stroke="rgba(200,225,245,.08)" vertical={false} /><XAxis dataKey="label" tickFormatter={(value: string) => value.slice(5)} tickLine={false} axisLine={false} tick={{ fill: '#8fa4b8', fontSize: 11 }} />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: '#8fa4b8', fontSize: 11 }} />
            <Tooltip contentStyle={{ background: '#132338', border: '1px solid #31445a', borderRadius: 12, color: '#edf5ff' }} />
            <Area type="monotone" dataKey="accepted" stroke="#52dfc0" strokeWidth={2} fill="url(#okFill)" />
            <Area type="monotone" dataKey="denied" stroke="#ff7d89" strokeWidth={2} fill="url(#denyFill)" />
          </AreaChart></ResponsiveContainer>}</div>
      </Panel>
      <Panel className="chart-panel hour-chart"><div className="panel-heading"><div><div className="eyebrow">HARI INI</div><h3>Jam akses</h3></div>
        <span className="chart-note">{chartsQuery.data?.busiestHour ? `Puncak ${chartsQuery.data.busiestHour.hour}:00` : 'Per jam'}</span></div>
        <div className="chart-area short-chart">{chartsQuery.isLoading ? <LoadingState /> : <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartsQuery.data?.hours ?? []} margin={{ left: -20, right: 2, top: 10 }}>
            <CartesianGrid stroke="rgba(200,225,245,.08)" vertical={false} /><XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: '#8fa4b8', fontSize: 10 }} />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: '#8fa4b8', fontSize: 10 }} />
            <Tooltip contentStyle={{ background: '#132338', border: '1px solid #31445a', borderRadius: 12, color: '#edf5ff' }} />
            <Bar dataKey="total" name="Akses" fill="#66c9ef" radius={[4, 4, 0, 0]} maxBarSize={20}>
              {(chartsQuery.data?.hours ?? []).map((entry, index) => <Cell key={index} fill={entry.denied > entry.accepted ? '#ff8791' : '#66c9ef'} />)}
            </Bar></BarChart></ResponsiveContainer>}</div></Panel>
    </div>}
    {confirm && <ConfirmDialog title="Buka pintu dari web?" onCancel={() => setConfirm(false)} onConfirm={() => void openDoor()}>
      Perintah akan dikirim ke <strong>{device?.name}</strong>. Operasi dicatat di audit dan menunggu ACK dari perangkat.
    </ConfirmDialog>}
  </div>;
}
