import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { KeyRound, Mail, Trash2, UserPlus, UserRound } from 'lucide-react';
import { api, type User } from '../lib/api/client';
import { Button, EmptyState, ErrorMessage, LoadingState, PageTitle, Panel } from '../components/ui';
import { ConfirmDialog } from '../components/ConfirmDialog';

type UserRow = { id: string; username: string; email: string | null; role: 'admin' | 'operator' | 'viewer'; active: number; createdAt: string };
export default function Users() {
  const cache = useQueryClient();
  const [searchParams] = useSearchParams();
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({ username: '', email: '', password: '', role: 'operator', otpCode: '', createToken: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [deleting, setDeleting] = useState<UserRow | null>(null);
  const [otpFlow, setOtpFlow] = useState<{ userId: string; email: string; code: string; sent: boolean } | null>(null);
  const session = useQuery({ queryKey: ['session'], queryFn: () => api<{ user: User }>('/auth/me') });
  const query = useQuery({ queryKey: ['users'], queryFn: () => api<{ users: UserRow[] }>('/users') });
  const requestCreateOtp = useMutation({
    mutationFn: () => api<{ ok: boolean; createToken: string }>('/users/create-otp/request', {
      method: 'POST',
      body: JSON.stringify({ username: form.username, email: form.email })
    }),
    onSuccess: (data) => {
      setError('');
      setForm((cur) => ({ ...cur, createToken: data.createToken, otpCode: '' }));
      setNotice(`Kode OTP 6 digit telah dikirim ke ${form.email}. Masukkan OTP untuk menyelesaikan pembuatan akun.`);
    },
    onError: (reason) => { setNotice(''); setError(reason instanceof Error ? reason.message : 'Gagal mengirim OTP.'); }
  });
  const add = useMutation({
    mutationFn: () => api('/users', {
      method: 'POST',
      body: JSON.stringify({
        username: form.username,
        email: form.email,
        password: form.password,
        role: form.role,
        createToken: form.createToken,
        otpCode: form.otpCode
      })
    }),
    onSuccess: async () => {
      setError('');
      setNotice('Pengguna baru berhasil dibuat, Gmail terverifikasi OTP, dan email welcome telah dikirim!');
      setFormOpen(false);
      setForm({ username: '', email: '', password: '', role: 'operator', otpCode: '', createToken: '' });
      await cache.invalidateQueries({ queryKey: ['users'] });
      await cache.invalidateQueries({ queryKey: ['email-status'] });
    },
    onError: (reason) => { setNotice(''); setError(reason instanceof Error ? reason.message : 'Gagal membuat pengguna.'); }
  });
  const requestOtp = useMutation({
    mutationFn: (payload: { userId: string; email: string }) =>
      api(`/users/${payload.userId}/email-otp/request`, { method: 'POST', body: JSON.stringify({ email: payload.email }) }),
    onSuccess: () => {
      setError('');
      setOtpFlow((cur) => (cur ? { ...cur, sent: true } : cur));
      setNotice('Kode OTP 6 digit telah dikirim ke Gmail tersebut. Masukkan kodenya untuk memverifikasi.');
    },
    onError: (reason) => { setNotice(''); setError(reason instanceof Error ? reason.message : 'Gagal mengirim OTP.'); }
  });
  const verifyOtp = useMutation({
    mutationFn: (payload: { userId: string; email: string; code: string }) =>
      api(`/users/${payload.userId}/email-otp/verify`, { method: 'POST', body: JSON.stringify({ email: payload.email, code: payload.code }) }),
    onSuccess: async () => {
      setError(''); setOtpFlow(null);
      setNotice('Gmail berhasil diverifikasi dan ditautkan!');
      await cache.invalidateQueries({ queryKey: ['users'] });
      await cache.invalidateQueries({ queryKey: ['email-status'] });
    },
    onError: (reason) => { setNotice(''); setError(reason instanceof Error ? reason.message : 'Kode OTP tidak valid.'); }
  });
  async function update(user: UserRow, patch: Record<string, unknown>) {
    setError('');
    try { await api(`/users/${user.id}`, { method: 'PATCH', body: JSON.stringify(patch) }); await cache.invalidateQueries({ queryKey: ['users'] }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Gagal memperbarui pengguna.'); }
  }
  async function deleteUser() {
    if (!deleting) return;
    try { await api(`/users/${deleting.id}`, { method: 'DELETE' }); setDeleting(null); await cache.invalidateQueries({ queryKey: ['users'] }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Gagal menghapus pengguna.'); }
  }
  if (query.isLoading) return <LoadingState />;
  return <div className="page-stack">
    <PageTitle eyebrow="AKSES PANEL" title="Pengguna & peran" description="Atur siapa yang dapat melihat, mengoperasikan, dan mengelola perangkat."
      action={<Button className="button-primary" onClick={() => setFormOpen(!formOpen)}><UserPlus size={16} /> Pengguna baru</Button>} />
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {notice && <div className="visual-chip" style={{ marginTop: 0 }}>{notice}</div>}
    {searchParams.get('googleError') === 'email_used' && <ErrorMessage>Gmail tersebut sudah tertaut ke pengguna lain.</ErrorMessage>}
    {searchParams.get('googleAdded') === '1' && <div className="visual-chip" style={{ marginTop: 0 }}>Pengguna baru berhasil didaftarkan lewat Google dan langsung aktif!</div>}
    {formOpen && <Panel className="form-panel"><h3>Buat pengguna baru</h3>
      <p className="muted small">Pembuatan akun wajib verifikasi <b>OTP 6 digit</b> ke Gmail pengguna (atau gunakan <b>Daftar via Google</b>). Pengguna berperan <b>Admin &amp; Operator</b> otomatis menerima peringatan pintu.</p>
      <form className="settings-form" onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (!form.createToken) requestCreateOtp.mutate();
        else add.mutate();
      }}>
        <label className="field-label">Nama pengguna<input required disabled={Boolean(form.createToken)} minLength={3} maxLength={40} pattern="[A-Za-z0-9_.-]+" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} /></label>
        <label className="field-label">Email Gmail<input required disabled={Boolean(form.createToken)} type="email" maxLength={120} placeholder="nama@gmail.com" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
        <label className="field-label">Kata sandi awal<input required type="password" minLength={12} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>
        <label className="field-label">Peran<select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
          <option value="admin">Admin</option><option value="operator">Operator</option><option value="viewer">Viewer</option></select></label>
        {form.createToken && (
          <label className="field-label">Kode OTP Gmail (6 digit)<input required pattern="\d{6}" maxLength={6} placeholder="123456" value={form.otpCode} onChange={(event) => setForm({ ...form, otpCode: event.target.value })} /></label>
        )}
        <div className="user-row-actions">
          <Button type="submit" className="button-primary" loading={requestCreateOtp.isPending || add.isPending}>
            {form.createToken ? 'Verifikasi OTP & Buat Akun' : 'Kirim OTP & Buat Akun'}
          </Button>
          {form.createToken && (
            <Button type="button" className="button-quiet" onClick={() => setForm({ ...form, createToken: '', otpCode: '' })}>Ubah data</Button>
          )}
          <a className="button button-quiet" style={{ textDecoration: 'none' }} href={`/api/auth/google/admin-add?role=${encodeURIComponent(form.role)}`}>
            <Mail size={15} /> Daftar via Google ({form.role})
          </a>
        </div>
      </form></Panel>}
    {query.isError && <ErrorMessage>{(query.error as Error).message}</ErrorMessage>}
    <Panel className="table-panel"><div className="table-scroll"><table><thead><tr><th>PENGGUNA</th><th>EMAIL GMAIL TERVERIFIKASI</th><th>PERAN</th><th>DIBUAT</th><th>STATUS</th><th>AKSI</th></tr></thead>
      <tbody>{query.data?.users.map((user) => <tr key={user.id}>
        <td><span className="user-table-name"><span className="avatar small-avatar"><UserRound size={15} /></span>{user.username}</span></td>
        <td>{otpFlow?.userId === user.id
          ? <form className="user-row-actions" onSubmit={(event) => {
              event.preventDefault();
              if (!otpFlow.sent) requestOtp.mutate({ userId: user.id, email: otpFlow.email });
              else verifyOtp.mutate({ userId: user.id, email: otpFlow.email, code: otpFlow.code });
            }}>
              <input type="email" required disabled={otpFlow.sent} maxLength={120} placeholder="nama@gmail.com"
                value={otpFlow.email} onChange={(event) => setOtpFlow({ ...otpFlow, email: event.target.value })} />
              {otpFlow.sent && (
                <input type="text" required pattern="\d{6}" maxLength={6} placeholder="Kode OTP 6 digit" style={{ width: 130 }}
                  value={otpFlow.code} onChange={(event) => setOtpFlow({ ...otpFlow, code: event.target.value })} />
              )}
              <Button type="submit" className="button-primary" loading={requestOtp.isPending || verifyOtp.isPending}>
                {otpFlow.sent ? 'Verifikasi OTP' : 'Kirim OTP'}
              </Button>
              <Button type="button" className="button-quiet" onClick={() => setOtpFlow(null)}>Batal</Button>
            </form>
          : user.email
            ? <span className="user-row-actions"><Mail size={14} /> {user.email}
                <Button className="button-quiet" onClick={() => void update(user, { email: null })}>Putus</Button></span>
            : <div className="user-row-actions">
                {session.data?.user.id === user.id && (
                  <a className="button button-quiet" style={{ textDecoration: 'none' }} href="/api/auth/google/link?returnTo=/users">
                    <Mail size={14} /> Tautkan via Google
                  </a>
                )}
                <button type="button" className="button button-quiet" onClick={() => { setError(''); setNotice(''); setOtpFlow({ userId: user.id, email: '', code: '', sent: false }); }}>
                  <KeyRound size={14} /> Verifikasi via OTP
                </button>
              </div>}</td>
        <td><select value={user.role} onChange={(event) => void update(user, { role: event.target.value })}>
          <option value="admin">Admin</option><option value="operator">Operator</option><option value="viewer">Viewer</option></select></td>
        <td>{new Date(user.createdAt).toLocaleDateString('id-ID')}</td><td><span className={`status-pill ${user.active ? 'accepted' : 'inactive'}`}>{user.active ? 'Aktif' : 'Nonaktif'}</span></td>
        <td><div className="user-row-actions"><Button className="button-quiet" onClick={() => void update(user, { active: !user.active })}>{user.active ? 'Nonaktifkan' : 'Aktifkan'}</Button>
          <button className="icon-button danger-icon" aria-label={`Hapus ${user.username}`} onClick={() => setDeleting(user)}><Trash2 size={15} /></button></div></td>
      </tr>)}</tbody></table></div>
      {!query.data?.users.length && <EmptyState>Belum ada pengguna.</EmptyState>}
    </Panel>
    {deleting && <ConfirmDialog title="Hapus pengguna?" onCancel={() => setDeleting(null)} onConfirm={() => void deleteUser()}>
      Akun <strong>{deleting.username}</strong> tidak dapat digunakan lagi. Tindakan yang sudah tercatat di audit tetap dipertahankan.
    </ConfirmDialog>}
  </div>;
}
