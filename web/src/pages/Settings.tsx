import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Mail, Plus, RefreshCw, Save, Settings2, ShieldCheck, Unlock, Wifi, WifiOff } from 'lucide-react';
import { api, type Device } from '../lib/api/client';
import { Button, ErrorMessage, LoadingState, PageTitle, Panel } from '../components/ui';

type DeviceFull = Device & { topic_prefix: string; timezone: string; open_duration_seconds: number; failure_limit: number; lockout_seconds: number; device_ip?: string | null };
type ScannedWifi = { ssid: string; rssi: number; secure: boolean };
type AutoRecipient = { id: string; username: string; role: 'admin' | 'operator'; email: string };
type EmailStatus = {
  configured: boolean; hasPassword: boolean; sender: string;
  notifyRoles: boolean; extraRecipients: string; autoRecipients: AutoRecipient[]; recipients: string;
};
const zoneChoices = ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'];
export default function Settings() {
  const cache = useQueryClient();
  const query = useQuery({ queryKey: ['settings-devices'], queryFn: () => api<{ devices: DeviceFull[] }>('/devices') });
  const emailStatus = useQuery({ queryKey: ['email-status'], queryFn: () => api<EmailStatus>('/notifications/email-status') });
  const [error, setError] = useState('');
  const [emailNotice, setEmailNotice] = useState('');
  const [smtpOpen, setSmtpOpen] = useState(false);
  const [newDevice, setNewDevice] = useState(false);
  const [draft, setDraft] = useState({ name: '', timezone: 'Asia/Jakarta', topicPrefix: '' });
  const [emailForm, setEmailForm] = useState({ sender: '', appPassword: '', recipients: '', notifyRoles: true });

  useEffect(() => {
    if (!emailStatus.data) return;
    setEmailForm((current) => ({
      sender: emailStatus.data.sender || current.sender,
      appPassword: '',
      recipients: emailStatus.data.extraRecipients ?? '',
      notifyRoles: emailStatus.data.notifyRoles ?? true
    }));
  }, [emailStatus.data]);

  const create = useMutation({
    mutationFn: () => api('/devices', { method: 'POST', body: JSON.stringify(draft) }),
    onSuccess: async () => { setNewDevice(false); setDraft({ name: '', timezone: 'Asia/Jakarta', topicPrefix: '' }); await cache.invalidateQueries({ queryKey: ['settings-devices'] }); await cache.invalidateQueries({ queryKey: ['devices'] }); },
    onError: (reason) => setError(reason instanceof Error ? reason.message : 'Gagal menambahkan perangkat.')
  });
  const saveEmail = useMutation({
    mutationFn: () => api<EmailStatus>('/notifications/email-settings', { method: 'PUT', body: JSON.stringify(emailForm) }),
    onSuccess: async () => {
      setError(''); setEmailNotice('Pengaturan Gmail berhasil disimpan.');
      setEmailForm((current) => ({ ...current, appPassword: '' }));
      await cache.invalidateQueries({ queryKey: ['email-status'] });
    },
    onError: (reason) => { setEmailNotice(''); setError(reason instanceof Error ? reason.message : 'Gagal menyimpan pengaturan Gmail.'); }
  });
  const testEmail = useMutation({
    mutationFn: () => api('/notifications/test-email', { method: 'POST' }),
    onSuccess: () => { setError(''); setEmailNotice('Email uji coba berhasil dikirim ke Gmail penerima.'); },
    onError: (reason) => { setEmailNotice(''); setError(reason instanceof Error ? reason.message : 'Gagal mengirim email uji coba.'); }
  });
  async function update(device: DeviceFull, fields: Record<string, unknown>) {
    setError('');
    try {
      await api(`/devices/${device.id}`, { method: 'PATCH', body: JSON.stringify(fields) });
      await cache.invalidateQueries({ queryKey: ['settings-devices'] });
      await cache.invalidateQueries({ queryKey: ['devices'] });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Gagal menyimpan pengaturan.'); }
  }
  if (query.isLoading) return <LoadingState />;
  return <div className="page-stack">
    <PageTitle eyebrow="KONFIGURASI SISTEM" title="Perangkat & pengaturan" description="Atur identitas pintu, zona waktu, dan kebijakan akses."
      action={<Button className="button-primary" onClick={() => setNewDevice(!newDevice)}><Plus size={16} /> Tambah pintu</Button>} />
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {newDevice && <Panel className="form-panel"><h3>Daftarkan pintu baru</h3>
      <form className="settings-form" onSubmit={(event: FormEvent) => { event.preventDefault(); create.mutate(); }}>
        <label className="field-label">Nama pintu<input required maxLength={80} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className="field-label">Topic prefix MQTT<input required pattern="[A-Za-z0-9/_-]+" placeholder="ti2024j/kel3/akses" value={draft.topicPrefix} onChange={(event) => setDraft({ ...draft, topicPrefix: event.target.value })} /></label>
        <label className="field-label">Zona waktu<select value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })}>{zoneChoices.map((zone) => <option key={zone}>{zone}</option>)}</select></label>
        <Button type="submit" className="button-primary" loading={create.isPending}>Simpan perangkat</Button>
      </form></Panel>}
    {query.isError && <ErrorMessage>{(query.error as Error).message}</ErrorMessage>}
    {query.data?.devices.map((device) => <DeviceSettings key={device.id} device={device} onSave={update} />)}
    <Panel className="settings-device">
      <div className="settings-device-head">
        <div><div className="eyebrow">PUSAT PERINGATAN OTOMATIS</div><h3>Notifikasi Keamanan ke Gmail</h3>
          <div className="topic-caption">{emailStatus.data?.configured
            ? 'Aktif · Peringatan percobaan gagal otomatis dikirim ke semua Admin & Operator yang terdaftar.'
            : 'Belum aktif · Hubungi penyedia atau buka Pengaturan lanjutan (SMTP) untuk mengaktifkan pengirim email.'}</div></div>
        <div className="user-row-actions">
          <Button className="button-quiet" disabled={!emailStatus.data?.configured} loading={testEmail.isPending} onClick={() => testEmail.mutate()}>
            <Mail size={15} /> Kirim tes email
          </Button>
          <Button type="button" className="button-quiet" onClick={() => setSmtpOpen(!smtpOpen)}>
            {smtpOpen ? 'Tutup lanjutan' : 'Lanjutan'}
          </Button>
        </div>
      </div>

      <div className="role-recipients-box">
        <div className="role-recipients-head">
          <span className="role-recipients-title"><ShieldCheck size={15} /> Penerima Otomatis (Admin &amp; Operator)</span>
          <label className="role-toggle">
            <input type="checkbox" checked={emailForm.notifyRoles} onChange={(event) => {
              const next = event.target.checked;
              setEmailForm({ ...emailForm, notifyRoles: next });
              if (emailForm.sender) {
                void api<EmailStatus>('/notifications/email-settings', {
                  method: 'PUT',
                  body: JSON.stringify({ ...emailForm, notifyRoles: next })
                }).then(() => cache.invalidateQueries({ queryKey: ['email-status'] }));
              }
            }} />
            <span>Kirim otomatis berdasarkan role</span>
          </label>
        </div>
        {emailStatus.data?.autoRecipients.length ? (
          <div className="recipient-chips">
            {emailStatus.data.autoRecipients.map((user) => (
              <span key={user.id} className="recipient-chip">
                <strong>{user.username}</strong>
                <span className="recipient-role">{user.role}</span>
                <span className="muted">{user.email}</span>
              </span>
            ))}
          </div>
        ) : (
          <div className="muted small">Belum ada Admin atau Operator yang terdaftar dengan Gmail di menu Pengguna.</div>
        )}
      </div>

      {emailNotice && <div className="muted small">{emailNotice}</div>}

      {smtpOpen && (
        <form className="settings-form" style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid rgba(177, 205, 230, .14)' }}
          onSubmit={(event: FormEvent) => { event.preventDefault(); saveEmail.mutate(); }}>
          <label className="field-label">Akun pengirim Gmail (SMTP)
            <input required type="email" maxLength={120} placeholder="notifikasi@gmail.com" value={emailForm.sender} onChange={(event) => setEmailForm({ ...emailForm, sender: event.target.value })} />
          </label>
          <label className="field-label">Gmail App Password (16 karakter)
            <input type="password" maxLength={64} required={!emailStatus.data?.hasPassword}
              placeholder={emailStatus.data?.hasPassword ? '•••••••••••• (tersimpan — isi jika ingin ganti)' : 'aofo trlq qonj mpwn'}
              value={emailForm.appPassword} onChange={(event) => setEmailForm({ ...emailForm, appPassword: event.target.value })} />
          </label>
          <label className="field-label">Salinan email tambahan (opsional)
            <input type="text" maxLength={300} placeholder="Kosongkan — cukup gunakan Admin & Operator otomatis" value={emailForm.recipients} onChange={(event) => setEmailForm({ ...emailForm, recipients: event.target.value })} />
          </label>
          <div className="settings-save">
            <span className="muted small">Pengaturan SMTP pengirim sistem</span>
            <Button type="submit" className="button-primary" loading={saveEmail.isPending}><Save size={15} /> Simpan SMTP</Button>
          </div>
        </form>
      )}
    </Panel>
  </div>;
}

function DeviceSettings({ device, onSave }: { device: DeviceFull; onSave: (device: DeviceFull, fields: Record<string, unknown>) => Promise<void> }) {
  const [form, setForm] = useState({
    name: device.name, timezone: device.timezone, openDurationSeconds: device.open_duration_seconds,
    failureLimit: device.failure_limit, lockoutSeconds: device.lockout_seconds
  });
  const [networks, setNetworks] = useState<ScannedWifi[]>([]);
  const [selectedSsid, setSelectedSsid] = useState('');
  const [wifiPass, setWifiPass] = useState('');
  const [mqttHost, setMqttHost] = useState('');
  const [wifiMsg, setWifiMsg] = useState('');
  const [wifiErr, setWifiErr] = useState('');

  const scanWifi = useMutation({
    mutationFn: () => api<{ ok: boolean; networks: ScannedWifi[]; message?: string }>(`/devices/${device.id}/wifi/scan`, { method: 'POST' }),
    onSuccess: (data) => {
      setWifiErr('');
      setNetworks(data.networks ?? []);
      setWifiMsg(data.networks?.length ? `Ditemukan ${data.networks.length} jaringan WiFi di sekitar perangkat.` : 'Tidak ada jaringan WiFi ditemukan.');
    },
    onError: (reason) => { setWifiMsg(''); setWifiErr(reason instanceof Error ? reason.message : 'Gagal memindai WiFi perangkat.'); }
  });

  const connectWifi = useMutation({
    mutationFn: () => api<{ ok: boolean; message?: string }>(`/devices/${device.id}/wifi/connect`, {
      method: 'POST',
      body: JSON.stringify({ ssid: selectedSsid, password: wifiPass, ...(mqttHost.trim() ? { mqttHost: mqttHost.trim() } : {}) })
    }),
    onSuccess: () => {
      setWifiErr('');
      setWifiPass('');
      setWifiMsg(`Perintah pindah WiFi ke "${selectedSsid}" terkirim. Perangkat akan menyambung ulang.`);
    },
    onError: (reason) => { setWifiMsg(''); setWifiErr(reason instanceof Error ? reason.message : 'Gagal mengirim pengaturan WiFi.'); }
  });

  return <Panel className="settings-device"><div className="settings-device-head">
    <div><div className="eyebrow">KONFIGURASI PINTU</div><h3>{device.name}</h3>
      <div className="topic-caption">{device.topic_prefix} · {device.timezone}{device.device_ip ? ` · IP ${device.device_ip}` : ''}</div></div>
    <span className={`live-badge ${device.online ? 'online' : 'offline'}`}>{device.online ? <Wifi size={14} /> : <WifiOff size={14} />}{device.online ? 'Online' : 'Offline'}</span>
  </div>
  <div className="settings-form">
    <label className="field-label">Nama pintu<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
    <label className="field-label">Zona waktu<select value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })}>{zoneChoices.map((zone) => <option key={zone}>{zone}</option>)}</select></label>
    <label className="field-label">Durasi buka (1–10 detik)<input type="number" min={1} max={10} value={form.openDurationSeconds} onChange={(event) => setForm({ ...form, openDurationSeconds: Number(event.target.value) })} /></label>
    <label className="field-label">Batas gagal sebelum lockout<input type="number" min={1} max={20} value={form.failureLimit} onChange={(event) => setForm({ ...form, failureLimit: Number(event.target.value) })} /></label>
    <label className="field-label">Durasi lockout (detik)<input type="number" min={1} max={600} value={form.lockoutSeconds} onChange={(event) => setForm({ ...form, lockoutSeconds: Number(event.target.value) })} /></label>
  </div>
  <div className="settings-save"><span className="muted small"><Settings2 size={14} /> {device.last_seen_at ? `Terakhir aktif ${new Date(device.last_seen_at).toLocaleString('id-ID')}` : 'Belum menerima status dari perangkat'}</span>
    <Button className="button-primary" onClick={() => void onSave(device, form)}><Save size={15} /> Simpan pengaturan</Button></div>

  <div className="wifi-config-box">
    <div className="settings-device-head">
      <div><div className="eyebrow">JARINGAN WIFI ESP32</div><strong>Pilih WiFi seperti di Android</strong>
        <div className="muted small">Jika pindah tempat &amp; WiFi lama tidak ada, sambungkan HP/laptop ke hotspot <b>NexaGate-Setup</b> lalu buka <b>http://192.168.4.1</b>.</div></div>
      <Button type="button" className="button-quiet" disabled={!device.online} loading={scanWifi.isPending} onClick={() => scanWifi.mutate()}>
        <RefreshCw size={15} /> Scan WiFi sekitar
      </Button>
    </div>
    {wifiErr && <ErrorMessage>{wifiErr}</ErrorMessage>}
    {wifiMsg && <div className="muted small">{wifiMsg}</div>}
    {networks.length > 0 && <div className="wifi-list">
      {networks.map((net) => <button key={net.ssid} type="button"
        className={`wifi-item ${selectedSsid === net.ssid ? 'selected' : ''}`}
        onClick={() => { setSelectedSsid(net.ssid); setWifiErr(''); }}>
        <span className="wifi-item-name"><Wifi size={15} /> {net.ssid}</span>
        <span className="wifi-item-meta">{net.rssi} dBm {net.secure ? <Lock size={13} /> : <Unlock size={13} />}</span>
      </button>)}
    </div>}
    {selectedSsid && <form className="settings-form" onSubmit={(event: FormEvent) => { event.preventDefault(); connectWifi.mutate(); }}>
      <label className="field-label">WiFi terpilih (SSID)<input required value={selectedSsid} onChange={(event) => setSelectedSsid(event.target.value)} /></label>
      <label className="field-label">Kata sandi WiFi<input type="password" maxLength={64} placeholder="Kosongkan jika tanpa password" value={wifiPass} onChange={(event) => setWifiPass(event.target.value)} /></label>
      <label className="field-label">MQTT Host baru (opsional)<input type="text" maxLength={120} placeholder="Kosongkan jika broker sama" value={mqttHost} onChange={(event) => setMqttHost(event.target.value)} /></label>
      <div className="settings-save"><span className="muted small">Tersimpan permanen di memori ESP32</span>
        <Button type="submit" className="button-primary" loading={connectWifi.isPending}>Hubungkan ke WiFi ini</Button></div>
    </form>}
  </div>
  </Panel>;
}
