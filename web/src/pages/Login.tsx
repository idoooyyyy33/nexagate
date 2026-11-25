import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, CheckCircle2, Cloud, DoorOpen, Eye, EyeOff, Fingerprint, LockKeyhole, ShieldCheck, UserPlus } from 'lucide-react';
import { api, type User } from '../lib/api/client';
import { Button, ErrorMessage } from '../components/ui';

const googleErrors: Record<string, string> = {
  google_unregistered: 'Email Google Anda belum terdaftar atau akun dinonaktifkan oleh admin.',
  google_unverified: 'Email Google Anda belum terverifikasi.',
  google_state: 'Sesi login Google kedaluwarsa. Silakan coba lagi.',
  google_failed: 'Gagal masuk menggunakan Google. Silakan coba lagi.',
  google_disabled: 'Login Google belum dikonfigurasi di server.'
};

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const providers = useQuery({ queryKey: ['auth-providers'], queryFn: () => api<{ google: boolean }>('/auth/providers') });
  const [otpChallenge, setOtpChallenge] = useState<{ otpToken: string; email: string } | null>(() => {
    const token = searchParams.get('otpToken');
    const email = searchParams.get('email');
    return token && email ? { otpToken: token, email } : null;
  });
  const [otpCode, setOtpCode] = useState('');
  const [otpInfo, setOtpInfo] = useState('');
  const oauthError = googleErrors[searchParams.get('error') ?? ''] ?? '';
  const registeredState = searchParams.get('registered');
  const registeredNotice = registeredState === '1'
    ? 'Pendaftaran via Google berhasil! Silakan tunggu Admin mengaktifkan akun & menetapkan peran Anda.'
    : registeredState === 'pending'
      ? 'Akun Google Anda sudah terdaftar dan masih menunggu persetujuan Admin.'
      : '';
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const result = await api<{ user?: User; otpRequired?: boolean; otpToken?: string; email?: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });
      if (result.otpRequired && result.otpToken && result.email) {
        setOtpChallenge({ otpToken: result.otpToken, email: result.email });
        setOtpCode('');
        setOtpInfo('');
        return;
      }
      if (result.user) {
        cache.setQueryData(['session'], { user: result.user });
        navigate('/', { replace: true });
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Tidak dapat masuk');
    } finally { setBusy(false); }
  }
  async function submitOtp(event: FormEvent) {
    event.preventDefault();
    if (!otpChallenge) return;
    setBusy(true); setError(''); setOtpInfo('');
    try {
      const session = await api<{ user: User }>('/auth/verify-login-otp', {
        method: 'POST',
        body: JSON.stringify({ otpToken: otpChallenge.otpToken, code: otpCode })
      });
      cache.setQueryData(['session'], session);
      navigate('/', { replace: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Kode OTP tidak valid');
    } finally { setBusy(false); }
  }
  async function resendOtp() {
    if (!otpChallenge) return;
    setBusy(true); setError(''); setOtpInfo('');
    try {
      const next = await api<{ otpToken: string; email: string }>('/auth/resend-login-otp', {
        method: 'POST',
        body: JSON.stringify({ otpToken: otpChallenge.otpToken })
      });
      setOtpChallenge({ otpToken: next.otpToken, email: next.email });
      setOtpInfo(`Kode OTP baru telah dikirim ke ${next.email}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Gagal mengirim ulang OTP');
    } finally { setBusy(false); }
  }
  return <main className="login-page">
    <div className="login-glow glow-a" /><div className="login-glow glow-b" />
    <div className="login-visual">
      <div className="login-brand"><span className="brand-mark"><DoorOpen size={23} /></span><span>Nexa<b>Gate</b></span></div>
      <div className="login-visual-copy"><div className="eyebrow">SMART ENTRY CONTROL</div>
        <h1>Akses yang aman,<br /><span>di bawah kendali.</span></h1>
        <p>Pantau setiap pintu. Ketahui setiap akses. Tetap terhubung, bahkan saat jaringan tidak.</p>
        <div className="visual-chip"><span className="status-pulse" /> Sistem siap digunakan</div>
        <div className="login-features">
          <div className="login-feature">
            <ShieldCheck size={16} />
            <div><strong>Kontrol Real-Time</strong><span>Pantau &amp; buka pintu instan dari panel</span></div>
          </div>
          <div className="login-feature">
            <Cloud size={16} />
            <div><strong>Offline-First + Cloud Sync</strong><span>Tetap jalan tanpa internet, sync otomatis</span></div>
          </div>
          <div className="login-feature">
            <BellRing size={16} />
            <div><strong>Notifikasi Keamanan Gmail</strong><span>Peringatan gagal akses langsung ke Admin</span></div>
          </div>
        </div>
      </div>
      <div className="login-visual-foot"><Fingerprint size={16} /> RFID ACCESS MANAGEMENT <span>·</span> OFFLINE-FIRST</div>
    </div>
    <section className="login-form-wrap">
      {otpChallenge ? (
        <form className="login-card glass-panel" onSubmit={(event) => void submitOtp(event)}>
          <div className="login-icon"><ShieldCheck size={21} /></div>
          <div className="eyebrow">VERIFIKASI KEAMANAN PENGGUNA BARU</div><h2>Masukkan Kode OTP</h2>
          <p className="muted">Akun Anda baru diaktifkan oleh Admin. Masukkan kode OTP 6 digit yang telah dikirim ke <b>{otpChallenge.email}</b>.</p>
          {error && <ErrorMessage>{error}</ErrorMessage>}
          {otpInfo && <div className="login-notice"><CheckCircle2 size={16} /><span>{otpInfo}</span></div>}
          <label className="field-label" htmlFor="otp-code">Kode OTP (6 digit)</label>
          <input id="otp-code" inputMode="numeric" pattern="\d{6}" maxLength={6} placeholder="123456"
            value={otpCode} onChange={(event) => setOtpCode(event.target.value)} required autoFocus />
          <Button type="submit" className="button-primary login-submit" loading={busy}>Verifikasi &amp; Masuk <span>→</span></Button>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" className="button button-quiet" style={{ flex: 1 }} disabled={busy} onClick={() => void resendOtp()}>
              Kirim ulang OTP
            </button>
            <button type="button" className="button button-quiet" style={{ flex: 1 }} disabled={busy}
              onClick={() => { setOtpChallenge(null); setError(''); setOtpInfo(''); setSearchParams({}); }}>
              Kembali
            </button>
          </div>
          <div className="login-safety"><LockKeyhole size={14} /> Verifikasi satu kali untuk keamanan akun baru.</div>
        </form>
      ) : (
      <form className="login-card glass-panel" onSubmit={(event) => void submit(event)}>
        <div className="login-icon"><LockKeyhole size={21} /></div>
        <div className="eyebrow">SELAMAT DATANG KEMBALI</div><h2>Masuk ke panel</h2>
        <p className="muted">Gunakan akun Anda untuk melanjutkan.</p>
        {error && <ErrorMessage>{error}</ErrorMessage>}
        {!error && oauthError && <ErrorMessage>{oauthError}</ErrorMessage>}
        {registeredNotice && <div className="login-notice"><CheckCircle2 size={16} /><span>{registeredNotice}</span></div>}
        <label className="field-label" htmlFor="username">Nama pengguna</label>
        <input id="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required maxLength={40} />
        <label className="field-label" htmlFor="password">Kata sandi</label>
        <div className="password-field"><input id="password" type={visible ? 'text' : 'password'} autoComplete="current-password"
          value={password} onChange={(event) => setPassword(event.target.value)} required maxLength={200} />
          <button type="button" className="password-toggle" aria-label={visible ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'} onClick={() => setVisible(!visible)}>
            {visible ? <EyeOff size={17} /> : <Eye size={17} />}
          </button></div>
        <Button type="submit" className="button-primary login-submit" loading={busy}>Masuk ke dashboard <span>→</span></Button>
        {providers.data?.google && <>
          <div className="login-divider"><span>atau lanjutkan dengan</span></div>
          <a className="button login-google" href="/api/auth/google">
            <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"/>
              <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"/>
              <path fill="#FBBC05" d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"/>
              <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"/>
            </svg>
            Masuk dengan Google (Gmail)
          </a>
          <a className="button button-quiet login-google-register" href="/api/auth/google/register">
            <UserPlus size={15} /> Daftar akun baru dengan Google
          </a>
        </>}
        <div className="login-safety"><LockKeyhole size={14} /> Koneksi terenkripsi dan sesi terlindungi.</div>
      </form>
      )}
    </section>
  </main>;
}
