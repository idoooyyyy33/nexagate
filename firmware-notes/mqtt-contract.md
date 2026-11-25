# Kontrak MQTT ESP32 — RuangAkses

## Pengalamatan dan keamanan

Setiap perangkat memiliki `topic_prefix` unik yang dapat diatur di panel. Untuk firmware yang sudah berjalan, gunakan:

```text
ti2024j/kel3/akses
```

Topic log lama tetap `ti2024j/kel3/akses/log`. Prefix pintu lain harus berbeda. Hubungkan ESP32 hanya ke broker Mosquitto privat milik deployment, gunakan kredensial MQTT yang dikelola di luar firmware bila memungkinkan, dan validasi sertifikat CA saat memakai TLS. Jangan memakai broker publik untuk perintah pintu. Jangan memasukkan kredensial Wi-Fi/broker di repositori.

Format payload UTF-8 JSON. MQTT QoS 1 disarankan untuk log, status, perintah dan ACK; penerima tetap harus mengantisipasi duplikat. `commandId` UUID dipakai untuk korelasi dan idempotensi command.

## ESP32 → server

### `<prefix>/log`

Payload kompatibel dengan firmware lama:

```json
{"uid":"F93F8429","status":"DITERIMA","gagal":0,"t":120}
```

- `uid`: hex UID kartu. Server melakukan HMAC untuk mencocokkan kartu, mengenkripsi data kartu tersimpan, dan hanya menyimpan UID tersamarkan/HMAC di riwayat.
- `status`: `DITERIMA`, `DITOLAK`, `TERKUNCI`, atau `ALARM_LOCKOUT`.
- `gagal`: jumlah kegagalan berturut-turut yang dilaporkan firmware.
- `t`: detik sejak ESP32 menyala. **Bukan** tanggal/waktu; server mencatat waktu penerimaan sebagai `received_at`.

### `<prefix>/status`

Terbitkan tiap 15 detik dan segera setelah perubahan kondisi pintu. Heartbeat ini memperbarui status online pada server:

```json
{"state":"closed","remainingSeconds":0,"wifiRssi":-61,"ip":"192.168.1.20"}
```

`state` hanya `open` atau `closed`; `remainingSeconds` adalah sisa durasi status open. `wifiRssi` integer dBm dan `ip` alamat perangkat. API memakai waktu penerimaan untuk last-seen/online. Nilai tersebut tidak membuktikan posisi mekanis pintu tanpa sensor kontak.

### `<prefix>/ack`

Balasan wajib memuat UUID yang sama dengan command:

```json
{"commandId":"b3bce9b3-2a14-47c0-9a7e-3c88a9be4403","ok":true,"action":"open","message":"opened"}
```

Untuk enrollment:

```json
{"commandId":"b3bce9b3-2a14-47c0-9a7e-3c88a9be4403","ok":true,"action":"enroll_next","message":"card_captured","uid":"F93F8429"}
```

Balas `ok:false` dengan pesan alasan yang singkat bila tidak bisa menjalankan perintah. UID enrollment hanya dikirim untuk event enrollment dan tidak boleh diterbitkan sebagai status/log yang tidak terkait.

## Server → ESP32

### `<prefix>/perintah`

Semua command membawa `commandId`, `action`, dan harus mendapat ACK yang sesuai.

**Buka pintu** (server hanya mengirim untuk operator/admin yang berwenang):

```json
{"commandId":"b3bce9b3-2a14-47c0-9a7e-3c88a9be4403","action":"open","durationSeconds":3}
```

Jalankan relay aktif-LOW dengan durasi 1–10 detik dan kunci kembali otomatis. Cek lockout lokal perangkat sebelum bertindak. Command ulang dengan `commandId` sama tidak boleh mengulang aksi fisik.

**Daftarkan satu kartu berikutnya:**

```json
{"commandId":"b3bce9b3-2a14-47c0-9a7e-3c88a9be4403","action":"enroll_next","mode":"once"}
```

Baca satu UID, kirim UID pada ACK, lalu tunggu server menyimpan kartu dan melakukan sinkronisasi. Jangan mengizinkan UID hasil enrollment membuka pintu sebelum disimpan/diaktifkan.

**Sinkronisasi snapshot kartu penuh untuk satu pintu:**

```json
{
  "commandId":"b3bce9b3-2a14-47c0-9a7e-3c88a9be4403",
  "action":"sync_cards",
  "timezone":"Asia/Jakarta",
  "cards":[{
    "uid":"F93F8429",
    "validFrom":null,
    "validUntil":"2026-12-31T16:59:59.000Z",
    "schedules":[{"weekday":1,"startTime":"08:00","endTime":"17:00"}]
  }]
}
```

`weekday`: 0 Minggu sampai 6 Sabtu; jam lokal pintu memakai timezone perangkat dari konfigurasi panel. Firmware mendukung `Asia/Jakarta`, `Asia/Makassar`, `Asia/Jayapura`, dan `UTC`. `null` tanggal berarti tanpa batas di sisi tersebut. Snapshot adalah daftar otoritatif aktif untuk perangkat; firmware memvalidasi dan menyimpannya secara persisten sebelum ACK. Maksimum 40 kartu dan 3.000 byte per snapshot.

Command kompatibilitas tambahan:

```json
{"commandId":"...","action":"add_card","uid":"F93F8429"}
{"commandId":"...","action":"delete_card","uid":"F93F8429"}
{"commandId":"...","action":"set_duration","durationSeconds":3}
{"commandId":"...","action":"set_security_settings","maxFailures":3,"lockoutSeconds":10}
```

Panel saat ini memakai `sync_cards` sebagai mekanisme utama perubahan kartu; command `add_card`/`delete_card` dicantumkan untuk firmware yang memilih dukungan incremental.

## Persyaratan offline-first dan keselamatan

1. Firmware menyimpan snapshot kartu, jadwal, konfigurasi, dan delapan `commandId` terakhir secara persisten di NVS ESP32.
2. Firmware menegakkan daftar kartu, masa berlaku, dan jadwal secara lokal. Kartu tanpa batas waktu/jadwal tetap dapat dipakai offline; kartu dengan batas waktu/jadwal ditolak sampai waktu NTP valid.
3. Waktu untuk aturan jadwal memerlukan NTP setelah perangkat menyala. Jika internet/waktu belum tersedia, firmware gagal-secure untuk kartu yang memiliki batas waktu atau jadwal.
4. Pertahankan lockout setelah kegagalan sesuai konfigurasi lokal. Log `ALARM_LOCKOUT` setelah ambang gagal tercapai.
5. Publish ulang status setelah koneksi MQTT, perubahan relay, pembukaan otomatis selesai, dan tiap 15 detik supaya server dapat memperbarui last-seen.
6. Kehilangan ACK tidak berarti perangkat tidak menjalankan command. Server menandai timeout dan UI tidak menyatakan sukses; retry hanya aman jika command idempotent.
