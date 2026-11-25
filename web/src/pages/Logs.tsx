import { useState } from 'react';
import { Download, Search, SlidersHorizontal } from 'lucide-react';
import { api } from '../lib/api/client';
import { useDevices } from '../lib/api/hooks';
import { Button, EmptyState, ErrorMessage, LoadingState, PageTitle, Panel } from '../components/ui';
import { useQuery } from '@tanstack/react-query';

type Log = { id: string; deviceName: string; uidMasked: string | null; ownerName: string | null; status: string; failedCount: number; receivedAt: string };
export default function Logs() {
  const [deviceId, setDeviceId] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [owner, setOwner] = useState('');
  const [cardId, setCardId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const devices = useDevices();
  const cardsQuery = useQuery({
    queryKey: ['cards-filter', deviceId],
    queryFn: () => api<{ cards: { id: string; ownerName: string; uidMasked: string }[] }>(`/cards${deviceId ? `?deviceId=${deviceId}` : ''}`)
  });
  const filters = new URLSearchParams();
  if (deviceId) filters.set('deviceId', deviceId);
  if (status) filters.set('status', status);
  if (search) filters.set('search', search);
  if (owner) filters.set('owner', owner);
  if (cardId) filters.set('cardId', cardId);
  if (from) filters.set('from', new Date(`${from}T00:00:00`).toISOString());
  if (to) {
    const end = new Date(`${to}T23:59:59.999`);
    filters.set('to', end.toISOString());
  }
  const params = new URLSearchParams(filters);
  params.set('page', String(page)); params.set('limit', '20');
  const query = useQuery({ queryKey: ['logs', params.toString()], queryFn: () => api<{ logs: Log[]; total: number; page: number; limit: number }>(`/access-logs?${params}`) });
  const pages = Math.max(1, Math.ceil((query.data?.total ?? 0) / 20));
  function exportCsv() { window.open(`/api/access-logs.csv?${filters}`, '_blank', 'noopener,noreferrer'); }
  return <div className="page-stack">
    <PageTitle eyebrow="JEJAK AKSES" title="Riwayat akses" description="Telusuri aktivitas dan ekspor laporan dalam format CSV."
      action={<Button className="button-quiet" onClick={exportCsv}><Download size={16} /> Ekspor CSV</Button>} />
    <Panel className="filter-panel"><div className="filter-heading"><SlidersHorizontal size={16} /><span>Filter riwayat</span></div>
      <div className="filter-controls"><label className="search-field"><Search size={16} /><input placeholder="Cari nama atau UID tersamarkan" value={search}
        onChange={(event) => { setSearch(event.target.value); setPage(1); }} /></label>
        <select value={deviceId} onChange={(event) => { setDeviceId(event.target.value); setCardId(''); setPage(1); }}>
          <option value="">Semua perangkat</option>{devices.data?.devices.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}</select>
        <select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
          <option value="">Semua status</option><option value="DITERIMA">Diterima</option><option value="DITOLAK">Ditolak</option>
          <option value="TERKUNCI">Terkunci</option><option value="ALARM_LOCKOUT">Lockout</option></select>
        <select value={cardId} onChange={(event) => { setCardId(event.target.value); setPage(1); }}>
          <option value="">Semua kartu</option>{cardsQuery.data?.cards.map((card) => <option key={card.id} value={card.id}>{card.ownerName} · {card.uidMasked}</option>)}</select>
        <input aria-label="Cari pemilik" placeholder="Pemilik kartu" value={owner} onChange={(event) => { setOwner(event.target.value); setPage(1); }} />
        <label className="date-filter">Dari<input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} /></label>
        <label className="date-filter">Sampai<input type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} /></label>
      </div>
    </Panel>
    {query.isLoading ? <LoadingState /> : query.isError ? <ErrorMessage>{(query.error as Error).message}</ErrorMessage> :
      <Panel className="table-panel"><div className="table-scroll"><table><thead><tr>
        <th>WAKTU DITERIMA</th><th>PERANGKAT</th><th>UID KARTU</th><th>PEMILIK</th><th>STATUS</th><th>GAGAL</th>
      </tr></thead><tbody>{query.data?.logs.map((log) => <tr key={log.id}>
        <td>{new Date(log.receivedAt).toLocaleString('id-ID')}</td><td>{log.deviceName}</td>
        <td className="mono">{log.uidMasked ?? '—'}</td><td>{log.ownerName ?? 'Tidak dikenal'}</td>
        <td><span className={`status-pill ${log.status === 'DITERIMA' ? 'accepted' : log.status === 'DITOLAK' ? 'denied' : 'warning'}`}>{statusLabel(log.status)}</span></td>
        <td>{log.failedCount}</td>
      </tr>)}</tbody></table></div>
        {!query.data?.logs.length && <EmptyState>Tidak ada riwayat yang cocok dengan filter.</EmptyState>}
        <div className="table-pagination"><span>{query.data?.total ?? 0} catatan · Halaman {page} dari {pages}</span>
          <div><Button className="button-quiet" disabled={page <= 1} onClick={() => setPage(page - 1)}>Sebelumnya</Button>
            <Button className="button-quiet" disabled={page >= pages} onClick={() => setPage(page + 1)}>Berikutnya</Button></div></div>
      </Panel>}
  </div>;
}
function statusLabel(status: string) {
  return ({ DITERIMA: 'Diterima', DITOLAK: 'Ditolak', TERKUNCI: 'Terkunci', ALARM_LOCKOUT: 'Lockout' } as Record<string, string>)[status] ?? status;
}
