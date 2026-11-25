import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Mic, MicOff, Send, Sparkles, Volume2, VolumeX } from 'lucide-react';
import { api, type Device, type User } from '../lib/api/client';
import { Panel } from './ui';

type ChatMessage = {
  id: string;
  sender: 'user' | 'assistant';
  text: string;
  time: string;
};

type BrowserSpeechRecognition = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

type SpeechWindow = Window & {
  SpeechRecognition?: new () => BrowserSpeechRecognition;
  webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
};

function playDoorChime() {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const tones = [523.25, 659.25, 783.99];
    tones.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.08);
      gain.gain.setValueAtTime(0.08, now + idx * 0.08);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.08 + 0.25);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.08);
      osc.stop(now + idx * 0.08 + 0.26);
    });
  } catch {
    // Ignore audio context restriction
  }
}

function greetingByTime() {
  const hour = new Date().getHours();
  if (hour < 11) return 'Selamat pagi';
  if (hour < 15) return 'Selamat siang';
  if (hour < 19) return 'Selamat sore';
  return 'Selamat malam';
}

function localReply(q: string, device: Device, user: User): string {
  const doorState = device.door_state === 'open' ? 'sedang terbuka' : 'terkunci dengan aman';
  const onlineState = device.online ? 'terhubung online' : 'sedang offline';

  if (/(status|keadaan|kondisi|terkunci|terbuka|aman)/.test(q)) {
    return `Saat ini ${device.name} ${doorState} dan perangkat ${onlineState}. Sistem pengamanan siap beroperasi penuh.`;
  }
  if (/(akses|laporan|statistik|berapa|hari ini|total|aktivitas|ramai)/.test(q)) {
    return device.today.total === 0
      ? `Hari ini belum ada aktivitas akses yang tercatat di ${device.name}. Semua kondisi terpantau tenang.`
      : `Laporan hari ini untuk ${device.name}: tercatat ${device.today.total} percobaan akses, dengan ${device.today.accepted} akses berhasil dan ${device.today.denied} akses ditolak.`;
  }
  if (/(kartu|card|terdaftar|anggota|penghuni)/.test(q)) {
    return `Terdapat ${device.cardCount} kartu akses aktif yang terdaftar dan terotorisasi untuk membuka ${device.name}.`;
  }
  if (/(sinyal|wifi|online|koneksi|ip|jaringan)/.test(q)) {
    return device.online
      ? `Perangkat ${device.name} terhubung stabil secara online${device.wifi_rssi !== null ? ` dengan kekuatan sinyal Wi-Fi ${device.wifi_rssi} dBm` : ''}.`
      : `Perhatian, perangkat ${device.name} saat ini terdeteksi offline. Mohon periksa koneksi Wi-Fi atau daya perangkat.`;
  }
  if (/(halo|hai|hello|pagi|siang|sore|malam|assalamualaikum)/.test(q)) {
    return `${greetingByTime()}, ${user.username}! Senang menyapa Anda. Ada yang perlu saya bantu untuk mengelola akses ${device.name}?`;
  }
  if (/(makasih|terima kasih|thanks|mantap|bagus|keren|oke|sip)/.test(q)) {
    return 'Dengan senang hati! Keamanan dan kenyamanan akses Anda selalu menjadi prioritas saya.';
  }
  if (/(siapa kamu|kamu siapa|fitur|bantuan|help|bisa apa|perkenalan)/.test(q)) {
    return 'Saya adalah Asisten Pintar NexaGate, sistem kendali akses cerdas Anda. Saya dapat membantu membuka pintu secara instan, memantau status keamanan, memeriksa kartu aktif, kondisi jaringan, hingga membacakan laporan aktivitas harian.';
  }
  return 'Mohon maaf, saya belum menangkap maksud perintah tersebut. Anda bisa mengatakan "buka pintu", "cek status pintu", "laporan akses hari ini", atau "jumlah kartu aktif".';
}

export function VoiceAssistant({
  device,
  user,
  onOpenDoor
}: {
  device: Device;
  user: User;
  onOpenDoor: () => Promise<{ ok: boolean; message?: string }>;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      sender: 'assistant',
      text: `Halo ${user.username}! Saya Asisten Pintar NexaGate. Ucapkan atau ketik perintah seperti "buka pintu", "status pintu", atau "akses hari ini".`,
      time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
    }
  ]);
  const [input, setInput] = useState('');
  const [listening, setListening] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const speechSupported = typeof window !== 'undefined' && Boolean((window as SpeechWindow).SpeechRecognition || (window as SpeechWindow).webkitSpeechRecognition);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  function speak(text: string) {
    if (!voiceEnabled || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'id-ID';
      utterance.rate = 1.02;
      utterance.pitch = 1.0;
      const voices = window.speechSynthesis.getVoices();
      const idVoice = voices.find((v) => v.lang.toLowerCase().startsWith('id'));
      if (idVoice) utterance.voice = idVoice;
      window.speechSynthesis.speak(utterance);
    } catch {
      // Ignore speech synthesis errors
    }
  }

  function appendMessage(sender: 'user' | 'assistant', text: string) {
    const time = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    setMessages((prev) => [...prev.slice(-14), { id: `${Date.now()}-${Math.random()}`, sender, text, time }]);
  }

  async function handleCommand(rawText: string) {
    const text = rawText.trim();
    if (!text || busy) return;
    appendMessage('user', text);
    const q = text.toLowerCase().replace(/[^\w\s]/g, ' ');

    if (/(buka|bukain|bukakan|open)\s*(pintu|pitu|pintunya|akses|door)?/.test(q) && /(pintu|pitu|akses|door)/.test(q)) {
      if (user.role === 'viewer') {
        const reply = 'Maaf, akun Viewer tidak memiliki izin untuk membuka pintu.';
        appendMessage('assistant', reply);
        speak(reply);
        return;
      }
      setBusy(true);
      const openingReply = `Baik, membuka pintu ${device.name} sekarang.`;
      appendMessage('assistant', openingReply);
      playDoorChime();
      speak(openingReply);
      try {
        const result = await onOpenDoor();
        const doneReply = result.ok
          ? `Pintu ${device.name} berhasil dibuka.`
          : result.message || `Perangkat ${device.name} tidak merespons perintah.`;
        appendMessage('assistant', doneReply);
        speak(doneReply);
      } catch (error) {
        const errReply = error instanceof Error ? error.message : 'Gagal mengirim perintah buka pintu.';
        appendMessage('assistant', errReply);
        speak(errReply);
      } finally {
        setBusy(false);
      }
      return;
    }

    let reply = '';
    try {
      const ai = await api<{ reply: string | null; provider: string }>('/assistant/chat', {
        method: 'POST',
        body: JSON.stringify({
          message: text,
          deviceContext: {
            name: device.name,
            online: device.online,
            doorState: device.door_state,
            wifiRssi: device.wifi_rssi,
            cardCount: device.cardCount,
            todayTotal: device.today.total,
            todayAccepted: device.today.accepted,
            todayDenied: device.today.denied
          }
        })
      });
      reply = ai.reply || localReply(q, device, user);
    } catch {
      reply = localReply(q, device, user);
    }

    appendMessage('assistant', reply);
    speak(reply);
  }

  function toggleListening() {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const SpeechCtor = (window as SpeechWindow).SpeechRecognition || (window as SpeechWindow).webkitSpeechRecognition;
    if (!SpeechCtor) {
      const msg = 'Browser Anda belum mendukung input mikrofon suara. Gunakan Chrome/Edge atau ketik perintah di kolom chat.';
      appendMessage('assistant', msg);
      speak(msg);
      return;
    }
    const recognition = new SpeechCtor();
    recognition.lang = 'id-ID';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript ?? '';
      if (transcript) void handleCommand(transcript);
    };
    recognition.onerror = (event) => {
      setListening(false);
      if (event.error === 'not-allowed') {
        appendMessage('assistant', 'Izin mikrofon ditolak oleh browser. Aktifkan izin mikrofon atau ketik perintah langsung.');
      }
    };
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const text = input;
    setInput('');
    void handleCommand(text);
  }

  return (
    <Panel className="voice-panel">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">ASISTEN PINTAR NEXAGATE</div>
          <h3 className="voice-title"><Sparkles size={16} /> Asisten Suara &amp; Kontrol Cepat</h3>
        </div>
        <div className="voice-toolbar">
          <button
            type="button"
            className="button button-quiet"
            onClick={() => setVoiceEnabled((v) => !v)}
            title={voiceEnabled ? 'Bisukan suara asisten' : 'Aktifkan suara asisten'}
          >
            {voiceEnabled ? <Volume2 size={15} /> : <VolumeX size={15} />}
            {voiceEnabled ? 'Suara aktif' : 'Suara bisu'}
          </button>
          <button
            type="button"
            className={`button ${listening ? 'voice-mic-active' : 'button-primary'}`}
            onClick={toggleListening}
            disabled={busy}
          >
            {listening ? <MicOff size={15} /> : <Mic size={15} />}
            {listening ? 'Mendengarkan…' : speechSupported ? 'Bicara sekarang' : 'Mic tidak didukung'}
          </button>
        </div>
      </div>

      <div className="voice-messages" ref={listRef}>
        {messages.map((msg) => (
          <div key={msg.id} className={`voice-bubble ${msg.sender}`}>
            <p>{msg.text}</p>
            <span>{msg.time}</span>
          </div>
        ))}
      </div>

      <div className="voice-quick-chips">
        {['Buka pintu', 'Status pintu', 'Akses hari ini', 'Kartu aktif'].map((cmd) => (
          <button key={cmd} type="button" className="voice-chip" disabled={busy} onClick={() => void handleCommand(cmd)}>
            {cmd}
          </button>
        ))}
      </div>

      <form className="voice-input-row" onSubmit={onSubmit}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='Ketik atau ucapkan "buka pintu", "status pintu"...'
          disabled={busy}
          maxLength={160}
        />
        <button type="submit" className="button button-primary" disabled={busy || !input.trim()}>
          <Send size={15} /> Kirim
        </button>
      </form>
    </Panel>
  );
}
