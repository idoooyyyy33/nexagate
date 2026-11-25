# RuangAkses — Sistem Pengelola Pintu RFID

Panel web berbahasa Indonesia untuk memantau dan mengelola pintu RFID berbasis ESP32. Backend menerima log MQTT, menyimpan waktu penerimaan server (field `t` tetap dianggap uptime perangkat), menyediakan API dan Socket.IO, serta memakai SQLite. Frontend adalah PWA React yang responsif.

## Jalankan dengan Docker Compose

Persyaratan: Docker Desktop yang mendukung `docker compose`.

1. Salin `.env.example` menjadi `.env` di PowerShell:

   ```powershell
   Copy-Item .env.example .env
   ```

2. Buat nilai rahasia acak. Jalankan perintah berikut dan salin output ke nilai yang sesuai di `.env` (jangan kirim atau commit output rahasia):

   ```powershell
   node -e "const c=require('node:crypto'); console.log('JWT_SECRET='+c.randomBytes(48).toString('base64url')); console.log('UID_ENCRYPTION_KEY='+c.randomBytes(32).toString('hex')); console.log('UID_HMAC_KEY='+c.randomBytes(48).toString('base64url')); console.log('BOOTSTRAP_ADMIN_PASSWORD='+c.randomBytes(18).toString('base64url')); console.log('MQTT_PASSWORD='+c.randomBytes(24).toString('base64url'))"
   ```

   Isi juga `MQTT_USERNAME` dengan nama akun broker yang Anda pilih. Nilai contoh `CHANGE_ME` sengaja ditolak backend. UID encryption key wajib berupa tepat 64 karakter hex; jangan menggantinya setelah kartu didaftarkan karena UID lama tidak dapat didekripsi. Simpan `.env` dengan aman.

3. Jalankan satu perintah:

   ```powershell
   docker compose up --build
   ```

   Buka `http://localhost:8080`, lalu masuk menggunakan `BOOTSTRAP_ADMIN_USERNAME` dan `BOOTSTRAP_ADMIN_PASSWORD` dari `.env`. Perangkat awal otomatis dibuat dengan `DEFAULT_DEVICE_TOPIC_PREFIX=ti2024j/kel3/akses`.

Docker menjalankan frontend pada port 8080, API di belakang Nginx, Mosquitto dengan autentikasi wajib, dan SQLite pada volume persisten. Port MQTT host hanya terikat ke `127.0.0.1` secara default. Untuk menghubungkan ESP32 di LAN yang sama, atur `MQTT_HOST_BIND=0.0.0.0`, batasi port dengan firewall, lalu arahkan firmware ke alamat IP mesin host, port 1883, `MQTT_USERNAME`, `MQTT_PASSWORD` dan topic perangkat. Ini mengekspos listener hanya ke jaringan yang Anda pilih, bukan menjadikannya broker publik. Untuk jaringan tidak tepercaya, gunakan TLS.

Mode demo menambahkan simulator pada broker privat:

```powershell
docker compose --profile demo up --build
```

Simulator mengirim status berkala dan log simulasi, membalas perintah, dan menghasilkan UID acak untuk enrollment. Ia tidak menguji relay/solenoid fisik. Hapus profil demo saat memakai perangkat nyata agar tidak menghasilkan trafik simulasi.

Untuk menghentikan stack, tekan `Ctrl+C`. Data bertahan pada volume Docker `rfid_data` dan `mosquitto_data`; jangan menghapus volume bila ingin mempertahankan data.

## Rahasia dan TLS MQTT

- Jangan commit `.env`, database, passfile Mosquitto, atau private key sertifikat. `.gitignore` sudah mengabaikan `.env`, database dan data runtime.
- Mosquitto menolak anonymous, menggunakan password hash di volume data, dan tidak diekspos ke internet oleh konfigurasi default.
- Untuk menambahkan listener TLS bagi ESP32: siapkan `ca.crt`, `server.crt`, dan `server.key` secara aman di `mosquitto/certs/`, atur `MOSQUITTO_CONFIG=mosquitto.tls.conf` di `.env`, lalu restart stack. Konfigurasi TLS tetap menyediakan listener lokal terautentikasi 1883 untuk API/simulator. Uji sertifikat dan verifikasi CA pada firmware sebelum deployment.
- Nginx bawaan melayani HTTP lokal. Untuk penggunaan nyata melalui jaringan, letakkan reverse proxy HTTPS di depannya, atur `WEB_ORIGIN` ke origin HTTPS yang tepat, `COOKIE_SECURE=true`, serta batasi akses host/port sesuai jaringan. Jangan gunakan HTTP melalui jaringan publik.
- Telegram opsional: isi `TELEGRAM_BOT_TOKEN` dan `TELEGRAM_CHAT_ID`. Notifikasi lokal tetap tersimpan saat Telegram tidak dikonfigurasi.

## Menjalankan tanpa Docker

Persyaratan: Node.js 22+, npm, dan Mosquitto privat lokal/terkelola yang dikonfigurasi dengan username/password serta `allow_anonymous false`. `better-sqlite3` memakai native addon; di Windows mungkin dibutuhkan Visual Studio C++ Build Tools, dan di Linux `python3`, `make`, serta compiler C++.

1. Salin `.env.example` ke `.env`, generate rahasia seperti pada langkah Docker, lalu ubah:
   - `WEB_ORIGIN=http://localhost:5173`
   - `MQTT_URL=mqtt://localhost:1883`
   - `DB_PATH=./data/rfid.sqlite`
2. Pasang dependency dan jalankan frontend serta API dalam mode pengembangan:

   ```powershell
   npm install
   npm run dev
   ```

3. Buka `http://localhost:5173`. Jalankan simulator pada terminal kedua bila diperlukan:

   ```powershell
   npm run simulator
   ```

Untuk build:

```powershell
npm run build
npm test
```

API produksi dapat dijalankan dengan `npm --workspace server start`; frontend hasil build berada di `web/dist` dan perlu disajikan oleh web server yang mem-proxy `/api` dan `/socket.io` ke API.

## Fitur dan akses

- Peran: admin mengelola pintu, kartu, pengguna dan pengaturan; operator membuka pintu dan melihat riwayat; viewer hanya melihat. Hak akses dicek di API, bukan hanya disembunyikan di UI.
- Login memakai Argon2id dan JWT di cookie `httpOnly`, `SameSite=Strict`, batas percobaan masuk, rate limit API dan pemeriksaan origin.
- UID kartu disimpan terenkripsi AES-256-GCM; HMAC dipakai untuk pencarian; UID pada log ditampilkan tersamarkan. Backup database harus disimpan bersama pengelolaan kunci yang aman.
- Kalender jadwal dan masa berlaku disinkronkan bersama kartu. Server menyediakan evaluasi jadwal untuk validasi/test; firmware **wajib** menegakkan jadwal dan tanggal saat offline.
- Kontrol buka menunggu ACK dengan timeout; perintah dan tindakan admin dicatat pada audit.
- Dashboard menerima status/log realtime lewat Socket.IO. Status online bergantung pada `last_seen_at`; MQTT log maupun status menandai perangkat terlihat.
- Ekspor CSV menampilkan UID tersamarkan dan melakukan escaping untuk mencegah formula injection.
- PWA menyimpan shell/aset statis untuk membuka aplikasi saat offline; API, login, telemetry dan perintah tetap memerlukan server/jaringan.

## API utama

Semua endpoint di bawah berprefix `/api`; semua endpoint selain login/logout membutuhkan sesi kecuali `/health`:

| Kelompok | Endpoint |
|---|---|
| Auth | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` |
| Dashboard | `GET /dashboard/summary`, `GET /dashboard/charts?deviceId=...&range=today\|7d\|30d` |
| Perangkat | `GET/POST /devices`, `PATCH/DELETE /devices/:id` (tulis admin) |
| Kartu | `GET/POST /cards`, `PATCH/DELETE /cards/:id` (tulis admin), `POST /devices/:id/enrollment` |
| Buka pintu | `POST /devices/:id/commands/open` dengan body `{"confirm":true}` (operator/admin) |
| Riwayat | `GET /access-logs`, `GET /access-logs.csv` |
| Audit/notifikasi | `GET /audit-logs` (admin), `GET /notifications`, `PATCH /notifications/:id/read`, `POST /notifications/read-all` |
| Pengguna | `GET/POST /users`, `PATCH/DELETE /users/:id` (admin) |

Filter riwayat API mendukung `from`, `to`, `status`, `deviceId`, `cardId`, `owner`, `search`, `page`, dan `limit`.

## Uji otomatis

`npm test` mencakup hashing/token autentikasi, hari/jam/zona waktu dan masa berlaku jadwal, serta penerimaan dan validasi payload MQTT termasuk pencatatan waktu penerimaan server. `npm run build` memeriksa kompilasi TypeScript frontend dan backend.

## Asumsi dan batasan keamanan perangkat

- Firmware saat ini hanya dijamin menerbitkan log lama. Topic status/perintah/ACK, enrollment, `commandId`, setelan remote, sinkronisasi dan enforcement jadwal merupakan kontrak firmware tambahan di [`firmware-notes/mqtt-contract.md`](./firmware-notes/mqtt-contract.md). Jika firmware tidak mengirim ACK, API melaporkan timeout dan tidak menyatakan perintah berhasil.
- Perangkat harus memiliki sumber waktu yang dapat dipercaya (misalnya RTC yang tetap valid ketika offline) untuk menerapkan jadwal/kedaluwarsa konsisten setelah offline/restart. Tanpa sumber waktu, pencabutan akses terjadwal tidak dapat dijamin.
- UID kartu murah dapat disalin/diemulasikan; UID bukan rahasia kriptografis dan sistem ini tidak mengatasi kloning kartu. Gunakan media autentikasi yang memiliki cryptographic challenge-response bila ancaman tersebut relevan.
- Tanpa sensor kontak pintu, status open/closed hanya status aktuator yang dilaporkan, bukan bukti fisik pintu tertutup/terbuka.
- Broker dan API pada compose tidak otomatis mendapat sertifikat HTTPS. Lindungi deployment non-lokal dengan TLS, firewall dan backup; `.env` serta backup kunci tidak boleh dibagikan.
- Simulator adalah alat demonstrasi protokol, bukan validasi keselamatan perangkat keras atau pengganti pengujian firmware di pintu sebenarnya.
