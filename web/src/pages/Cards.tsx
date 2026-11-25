import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgePlus, CalendarClock, CreditCard, LoaderCircle, Pencil, Plus, Radio, Trash2 } from 'lucide-react';
import { api, type User } from '../lib/api/client';
import { useDevices } from '../lib/api/hooks';
import { socket } from '../lib/api/socket';
import { Button, EmptyState, ErrorMessage, LoadingState, PageTitle, Panel } from '../components/ui';
import { ConfirmDialog } from '../components/ConfirmDialog';

type CardItem = { id: string; ownerName: string; uidMasked: string; notes: string; active: number; deviceId: string; validFrom: string | null; validUntil: string | null; enabled: number; syncedAt: string | null; schedules: Slot[] };
type Slot = { weekday: number; startTime: string; endTime: string };
const weekdays = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const initialForm = { uid: '', ownerName: '', notes: '', deviceId: '', validFrom: '', validUntil: '', enabled: true };

export default function Cards({ user }: { user: User }) {
  const cache = useQueryClient();
  const devicesQuery = useDevices();
  const devices = devicesQuery.data?.devices ?? [];
  const [deviceId, setDeviceId] = useState('');
  const [editing, setEditing] = useState<CardItem | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(initialForm);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [error, setError] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const [enrollError, setEnrollError] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<CardItem | null>(null);
  const query = useQuery({
    queryKey: ['cards', deviceId],
    queryFn: () => api<{ cards: CardItem[] }>(`/cards?deviceId=${deviceId}`),
    enabled: Boolean(deviceId)
  });
  useEffect(() => {
    if (!deviceId && devices[0]) { setDeviceId(devices[0].id); setForm((value) => ({ ...value, deviceId: devices[0].id })); }
  }, [deviceId, devices]);
  useEffect(() => {
    const captured = (event: { uidForAdmin: string }) => {
      setForm((value) => ({ ...value, uid: event.uidForAdmin }));
      setEnrolling(false); setEnrollError('');
    };
    const failed = (event: { ok: boolean; message?: string }) => {
      if (!event.ok) { setEnrolling(false); setEnrollError(event.message ?? 'Pendaftaran kartu gagal.'); }
    };
    socket.on('enrollment:captured', captured);
    const refreshCards = () => { void cache.invalidateQueries({ queryKey: ['cards'] }); };
    socket.on('command:result', failed);
    socket.on('command:result', refreshCards);
    return () => { socket.off('enrollment:captured', captured); socket.off('command:result', failed); socket.off('command:result', refreshCards); };
  }, [cache]);

  function startCreate() {
    setEditing(null); setShowCreate(true); setForm({ ...initialForm, deviceId: deviceId || devices[0]?.id || '' }); setSlots([]); setError('');
  }
  function startEdit(card: CardItem) {
    setEditing(card); setShowCreate(false);
    setForm({ uid: '', ownerName: card.ownerName, notes: card.notes, deviceId: card.deviceId,
      validFrom: card.validFrom?.slice(0, 16) ?? '', validUntil: card.validUntil?.slice(0, 16) ?? '', enabled: Boolean(card.enabled) });
    setSlots(card.schedules ?? []); setError('');
  }
  async function startEnroll() {
    if (!form.deviceId) return;
    setEnrolling(true); setEnrollError('');
    try {
      const result = await api<{ uid?: string }>(`/devices/${form.deviceId}/enrollment`, { method: 'POST', body: '{}' });
      const capturedUid = result.uid;
      if (capturedUid) setForm((value) => ({ ...value, uid: capturedUid.toUpperCase() }));
      setEnrolling(false);
      setEnrollError(result.uid ? 'UID berhasil ditangkap dari perangkat.' : 'Perangkat menerima perintah pendaftaran.');
    } catch (reason) { setEnrolling(false); setEnrollError(reason instanceof Error ? reason.message : 'Tidak dapat mengirim perintah.'); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (editing) {
        await api(`/cards/${editing.id}`, { method: 'PATCH', body: JSON.stringify({
          ownerName: form.ownerName, notes: form.notes, enabled: form.enabled,
          validFrom: form.validFrom ? new Date(form.validFrom).toISOString() : null,
          validUntil: form.validUntil ? new Date(form.validUntil).toISOString() : null, schedules: slots
        }) });
      } else {
        await api('/cards', { method: 'POST', body: JSON.stringify({
          uid: form.uid, ownerName: form.ownerName, notes: form.notes, deviceId: form.deviceId,
          validFrom: form.validFrom ? new Date(form.validFrom).toISOString() : null,
          validUntil: form.validUntil ? new Date(form.validUntil).toISOString() : null, schedules: slots
        }) });
      }
      setEditing(null); setShowCreate(false); await cache.invalidateQueries({ queryKey: ['cards'] });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Gagal menyimpan kartu.'); }
    finally { setBusy(false); }
  }
  async function toggleActive(card: CardItem) {
    try { await api(`/cards/${card.id}`, { method: 'PATCH', body: JSON.stringify({ active: !card.active }) }); await cache.invalidateQueries({ queryKey: ['cards'] }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Gagal memperbarui kartu.'); }
  }
  async function confirmDelete() {
    if (!deleting) return;
    try { await api(`/cards/${deleting.id}`, { method: 'DELETE' }); await cache.invalidateQueries({ queryKey: ['cards'] }); setDeleting(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Gagal menghapus kartu.'); }
  }
  const cards = query.data?.cards ?? [];
  if (devicesQuery.isLoading || query.isLoading) return <LoadingState />;
  return <div className="page-stack">
    <PageTitle eyebrow="KELOLA KREDENSIAL" title="Kartu akses" description="Daftarkan kartu, kelola masa berlaku, dan atur jadwal akses."
      action={<div className="page-action-row">{devices.length > 1 && <select value={deviceId} onChange={(event) => setDeviceId(event.target.value)}>
        {devices.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}</select>}
        {user.role === 'admin' && <Button className="button-primary" onClick={startCreate}><Plus size={16} /> Tambah kartu</Button>}</div>} />
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {query.isError && <ErrorMessage>{(query.error as Error).message}</ErrorMessage>}
    {editing && <Panel className="form-panel"><div className="panel-heading"><div><div className="eyebrow">EDIT DATA</div><h3>Perbarui kartu</h3></div>
      <button className="text-button" onClick={() => setEditing(null)}>Tutup</button></div>
      <CardForm {...{ form, setForm, slots, setSlots, editing, devices, submit, busy, error, enrolling, enrollError, startEnroll }} /></Panel>}
    {user.role === 'admin' && showCreate && <Panel className="form-panel new-card-panel"><div className="panel-heading"><div><div className="eyebrow">KARTU BARU</div><h3>Tambah atau daftarkan kartu</h3></div>
      <span className="subtle-chip"><Radio size={14} /> Enrollment satu kali</span></div>
      <CardForm {...{ form, setForm, slots, setSlots, editing: null, devices, submit, busy, error, enrolling, enrollError, startEnroll }} /></Panel>}
    {!cards.length ? <Panel><EmptyState>Belum ada kartu untuk perangkat ini.</EmptyState></Panel> :
      <div className="cards-grid">{cards.map((card) => <Panel key={card.id} className={`card-tile ${!card.active || !card.enabled ? 'card-disabled' : ''}`}>
        <div className="card-tile-top"><div className="card-chip"><CreditCard size={21} /></div>
          <span className={`status-pill ${card.active && card.enabled ? 'accepted' : 'inactive'}`}>{card.active && card.enabled ? 'Aktif' : 'Nonaktif'}</span></div>
        <h3>{card.ownerName}</h3><div className="card-uid">{card.uidMasked}</div>
        {card.notes && <p className="card-note">{card.notes}</p>}
        <div className="card-validity"><CalendarClock size={14} /> {card.validUntil ? `Berlaku s.d. ${new Date(card.validUntil).toLocaleDateString('id-ID')}` : 'Tanpa batas waktu'}</div>
        <div className={`sync-state ${card.syncedAt ? 'synced' : 'sync-pending'}`}>{card.syncedAt ? 'Tersinkron ke perangkat' : 'Menunggu sinkronisasi perangkat'}</div>
        <div className="card-actions">{user.role === 'admin' ? <>
          <Button className="button-quiet" onClick={() => void toggleActive(card)}>{card.active ? 'Nonaktifkan' : 'Aktifkan'}</Button>
          <button className="icon-button" aria-label="Edit kartu" onClick={() => startEdit(card)}><Pencil size={16} /></button>
          <button className="icon-button danger-icon" aria-label="Hapus kartu" onClick={() => setDeleting(card)}><Trash2 size={16} /></button>
        </> : <span className="muted small">Hanya lihat</span>}</div>
      </Panel>)}</div>}
    {deleting && <ConfirmDialog title="Hapus kartu?" onCancel={() => setDeleting(null)} onConfirm={() => void confirmDelete()}>
      Kartu milik <strong>{deleting.ownerName}</strong> akan dihapus dari daftar.
    </ConfirmDialog>}
  </div>;
}

function CardForm({ form, setForm, slots, setSlots, editing, devices, submit, busy, error, enrolling, enrollError, startEnroll }: {
  form: typeof initialForm; setForm: React.Dispatch<React.SetStateAction<typeof initialForm>>;
  slots: Slot[]; setSlots: React.Dispatch<React.SetStateAction<Slot[]>>; editing: CardItem | null;
  devices: { id: string; name: string }[]; submit: (event: FormEvent) => void; busy: boolean;
  error: string; enrolling: boolean; enrollError: string; startEnroll: () => void;
}) {
  return <form className="card-form" onSubmit={submit}>
    {!editing && <div className="form-row uid-row"><label className="field-label">UID kartu
      <input value={form.uid} onChange={(event) => setForm((value) => ({ ...value, uid: event.target.value.toUpperCase() }))}
        required pattern="[A-Fa-f0-9]{4,32}" maxLength={32} placeholder="Contoh: F93F8429" />
    </label><Button type="button" className="button-quiet enroll-button" disabled={!form.deviceId || enrolling} onClick={startEnroll}>
      {enrolling ? <LoaderCircle className="spin" size={16} /> : <BadgePlus size={16} />} {enrolling ? 'Menunggu kartu…' : 'Daftarkan kartu'}
    </Button></div>}
    {!editing && enrollError && <p className="muted small" role="status">{enrollError}</p>}
    <div className="form-row"><label className="field-label">Nama pemilik<input value={form.ownerName} onChange={(event) => setForm((value) => ({ ...value, ownerName: event.target.value }))} required maxLength={100} /></label>
      <label className="field-label">Perangkat<select value={form.deviceId} disabled={Boolean(editing)} onChange={(event) => setForm((value) => ({ ...value, deviceId: event.target.value }))}>
        {devices.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}</select></label></div>
    <label className="field-label">Catatan<textarea rows={2} maxLength={500} value={form.notes} onChange={(event) => setForm((value) => ({ ...value, notes: event.target.value }))} /></label>
    <div className="form-row"><label className="field-label">Mulai berlaku<input type="datetime-local" value={form.validFrom} onChange={(event) => setForm((value) => ({ ...value, validFrom: event.target.value }))} /></label>
      <label className="field-label">Kedaluwarsa<input type="datetime-local" value={form.validUntil} onChange={(event) => setForm((value) => ({ ...value, validUntil: event.target.value }))} /></label></div>
    <div className="schedule-box"><div className="schedule-title"><CalendarClock size={15} /> Jadwal akses <span className="muted small">Kosong = setiap saat</span></div>
      {slots.map((slot, index) => <div className="schedule-row" key={`${slot.weekday}-${index}`}>
        <select aria-label="Hari" value={slot.weekday} onChange={(event) => setSlots((old) => old.map((item, i) => i === index ? { ...item, weekday: Number(event.target.value) } : item))}>
          {weekdays.map((day, value) => <option value={value} key={day}>{day}</option>)}</select>
        <input aria-label="Jam mulai" type="time" value={slot.startTime} onChange={(event) => setSlots((old) => old.map((item, i) => i === index ? { ...item, startTime: event.target.value } : item))} />
        <span className="muted">sampai</span>
        <input aria-label="Jam selesai" type="time" value={slot.endTime} onChange={(event) => setSlots((old) => old.map((item, i) => i === index ? { ...item, endTime: event.target.value } : item))} />
        <button className="text-button danger-text" type="button" onClick={() => setSlots((old) => old.filter((_, i) => i !== index))}>Hapus</button>
      </div>)}
      <button className="text-button add-slot" type="button" onClick={() => setSlots((old) => [...old, { weekday: 1, startTime: '08:00', endTime: '17:00' }])}><Plus size={14} /> Tambah rentang waktu</button>
    </div>
    {error && <ErrorMessage>{error}</ErrorMessage>}
    <div className="form-actions"><Button type="submit" className="button-primary" loading={busy}>{editing ? 'Simpan perubahan' : 'Simpan kartu'}</Button></div>
  </form>;
}
