# 🎊 Wedding Video Booth
## Panduan Deploy Lengkap — Cloudflare R2 + D1 + Cron → Google Drive

---

## Arsitektur Sistem

```
                    ┌─────────────────────────────────┐
                    │         BROWSER TAMU             │
                    │   rekam video / ambil foto       │
                    └──────────────┬──────────────────┘
                                   │ POST /api/submit
                                   ▼
                    ┌─────────────────────────────────┐
                    │     CLOUDFLARE PAGES             │
                    │   functions/[[catchall]].js      │
                    │                                  │
                    │  1. Upload file → R2             │
                    │  2. Simpan metadata → D1         │
                    │  3. Return URL R2 ke browser     │
                    └─────┬───────────────┬───────────┘
                          │               │
                   file   │               │ metadata
                          ▼               ▼
          ┌───────────────────┐  ┌────────────────────┐
          │   Cloudflare R2   │  │   Cloudflare D1    │
          │  (video/foto/vn)  │  │  (SQLite database) │
          │  dipakai frontend │  │  entries + status  │
          └───────────────────┘  └────────┬───────────┘
                                          │ setiap 5 menit
                                          ▼
                         ┌────────────────────────────┐
                         │   CLOUDFLARE WORKER CRON   │
                         │      worker-cron.js         │
                         │                             │
                         │  1. Query D1: belum arsip  │
                         │  2. Ambil file dari R2      │
                         │  3. Upload → Google Drive  │
                         │  4. Update D1: drive_id    │
                         └───────────────┬────────────┘
                                         │
                                         ▼
                          ┌──────────────────────────┐
                          │      GOOGLE DRIVE         │
                          │   (arsip permanen gratis) │
                          │   folder per tanggal      │
                          └──────────────────────────┘
```

### Prinsip Utama
- **R2** = storage aktif untuk web. Video langsung bisa diputar, latensi rendah.
- **D1** = database metadata + tracking status arsip per entry.
- **Worker Cron** = background job tiap 5 menit, tidak mempengaruhi kecepatan frontend sama sekali.
- **Google Drive** = arsip permanen. Tamu tidak berinteraksi langsung dengan Drive.

---

## Struktur File

```
wedding-booth/
├── index.html                 ← Frontend (kamera + galeri)
├── schema.sql                 ← D1 schema (jalankan sekali)
├── wrangler.toml              ← Config Worker cron
├── worker-cron.js             ← Cron job: sync R2 → Google Drive
└── functions/
    └── [[catchall]].js        ← Pages Functions API
```

---

## Prasyarat

```bash
# Node.js minimal versi 18
node -v

# Install Wrangler CLI
npm install -g wrangler

# Login ke akun Cloudflare kamu
npx wrangler login
```

---

## BAGIAN 1 — Setup Cloudflare (R2 + D1 + Pages)

### Langkah 1 — Buat D1 Database

```bash
npx wrangler d1 create wedding-booth-db
```

Simpan `database_id` dari output, contoh:
```
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

### Langkah 2 — Buat R2 Bucket

```bash
npx wrangler r2 bucket create wedding-booth-media
```

### Langkah 3 — Aktifkan R2 Public Access

Ini penting agar video bisa diputar langsung di browser tanpa proxy.

1. Buka **Cloudflare Dashboard** → **R2**
2. Klik bucket `wedding-booth-media`
3. Tab **Settings** → bagian **Public Access**
4. Klik **Allow Access** → konfirmasi
5. Salin **Public Bucket URL** (format: `https://pub-xxxxxxxx.r2.dev`)

### Langkah 4 — Inisialisasi Schema D1

```bash
# Production (remote)
npx wrangler d1 execute wedding-booth-db --remote --file=schema.sql

# Verifikasi tabel berhasil dibuat
npx wrangler d1 execute wedding-booth-db --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table'"
```

Output yang diharapkan: tabel `entries`

### Langkah 5 — Deploy Cloudflare Pages

```bash
npx wrangler pages deploy . --project-name wedding-booth
```

Setelah deploy, buka Cloudflare Dashboard → **Pages** → `wedding-booth`
→ **Settings** → **Environment Variables** → tambahkan:

| Variable | Value |
|---|---|
| `PUBLIC_URL` | `https://pub-xxxxxxxx.r2.dev` (dari Langkah 3) |

### Langkah 6 — Tambahkan Binding D1 dan R2 ke Pages

Di Cloudflare Dashboard → **Pages** → `wedding-booth`
→ **Settings** → **Functions**:

**D1 Database Bindings:**
| Variable name | D1 database |
|---|---|
| `DB` | `wedding-booth-db` |

**R2 Bucket Bindings:**
| Variable name | R2 bucket |
|---|---|
| `MEDIA_BUCKET` | `wedding-booth-media` |

Klik **Save** lalu **Redeploy** agar binding aktif.

### Langkah 7 — Verifikasi Pages API

```bash
curl https://wedding-booth.pages.dev/api/health
```

Output yang diharapkan:
```json
{"db": true, "r2": true, "ts": "2024-06-15T..."}
```

---

## BAGIAN 2 — Setup Google Drive (untuk arsip)

### Langkah 8 — Buat Google Cloud Project

1. Buka https://console.cloud.google.com
2. Klik **New Project** → beri nama `wedding-booth`
3. Pilih project yang baru dibuat

### Langkah 9 — Aktifkan Google Drive API

1. Di GCP Console → **APIs & Services** → **Library**
2. Cari **Google Drive API** → klik **Enable**

### Langkah 10 — Buat Service Account

1. **APIs & Services** → **Credentials**
2. Klik **Create Credentials** → **Service Account**
3. Nama: `wedding-booth-archiver` → klik **Done**
4. Klik service account yang baru → tab **Keys**
5. **Add Key** → **Create new key** → pilih **JSON** → **Create**
6. File JSON ter-download otomatis — **simpan dengan aman**

Dari file JSON tersebut ambil dua nilai:
- `client_email` → ini adalah `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `private_key`  → ini adalah `GOOGLE_PRIVATE_KEY`

### Langkah 11 — Buat Folder Drive dan Beri Akses

1. Buka **Google Drive** (akun Google pribadi kamu)
2. Buat folder baru, contoh: `Wedding Booth Arsip`
3. Klik kanan folder → **Share**
4. Masukkan email service account dari Langkah 10
5. Ubah role menjadi **Editor** → klik **Send**
6. Salin **Folder ID** dari URL:
   ```
   https://drive.google.com/drive/folders/FOLDER_ID_ADA_DI_SINI
   ```

---

## BAGIAN 3 — Deploy Worker Cron

### Langkah 12 — Update wrangler.toml

Buka `wrangler.toml`, ganti placeholder:
```toml
database_id = "GANTI_DENGAN_ID_D1_KAMU"   # dari Langkah 1
```

### Langkah 13 — Set Secrets Worker

```bash
# Email service account Google
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
# → paste: wedding-booth-archiver@project-id.iam.gserviceaccount.com

# Private key (paste SELURUH key termasuk -----BEGIN/END PRIVATE KEY-----)
npx wrangler secret put GOOGLE_PRIVATE_KEY
# → paste seluruh nilai private_key dari file JSON

# ID folder Drive tujuan arsip
npx wrangler secret put GOOGLE_DRIVE_FOLDER_ID
# → paste Folder ID dari Langkah 11
```

### Langkah 14 — Deploy Worker Cron

```bash
npx wrangler deploy
```

Verifikasi cron terdaftar:
```bash
npx wrangler deployments list
```

### Langkah 15 — Test Cron Secara Manual

```bash
# Trigger satu siklus archiving sekarang (tanpa harus menunggu 5 menit)
curl -X POST https://wedding-booth-cron.<subdomain>.workers.dev/run
```

Output sukses (jika belum ada entry):
```json
{
  "started_at": "2024-06-15T10:00:00.000Z",
  "processed": 0,
  "succeeded": 0,
  "failed": 0,
  "finished_at": "2024-06-15T10:00:01.000Z"
}
```

---

## Verifikasi End-to-End

### 1. Test upload lewat browser
1. Buka `https://wedding-booth.pages.dev`
2. Rekam video pendek → isi nama → klik Kirim
3. Video harus langsung muncul di galeri

### 2. Cek D1 setelah upload (archived_at masih kosong = normal)
```bash
npx wrangler d1 execute wedding-booth-db --remote \
  --command "SELECT id, name, archived_at, drive_id FROM entries ORDER BY id DESC LIMIT 5"
```

### 3. Trigger cron manual
```bash
curl -X POST https://wedding-booth-cron.<subdomain>.workers.dev/run
```

### 4. Cek Drive — file harus sudah muncul di folder arsip

### 5. Cek D1 setelah cron (archived_at harus terisi)
```bash
npx wrangler d1 execute wedding-booth-db --remote \
  --command "SELECT id, name, archived_at, drive_id FROM entries ORDER BY id DESC LIMIT 5"
```

### 6. Cek statistik via API
```bash
curl https://wedding-booth.pages.dev/api/stats
```

---

## Monitoring & Operasional

### Query D1 Berguna

```bash
# Statistik ringkas
npx wrangler d1 execute wedding-booth-db --remote \
  --command "SELECT * FROM stats"

# Entry yang gagal diarsip
npx wrangler d1 execute wedding-booth-db --remote \
  --command "SELECT id, name, archive_attempts, archive_error FROM entries WHERE archive_attempts >= 5"

# Reset retry untuk entry tertentu setelah masalah diperbaiki
npx wrangler d1 execute wedding-booth-db --remote \
  --command "UPDATE entries SET archive_attempts = 0, archive_error = '' WHERE id = 5"

# Backup database
npx wrangler d1 export wedding-booth-db --remote --output=backup-$(date +%Y%m%d).sql
```

### Log Real-time

```bash
# Log Worker cron
npx wrangler tail wedding-booth-cron

# Log Pages Functions
npx wrangler pages deployment tail --project-name wedding-booth
```

---

## Free Tier Limits — Ringkasan

| Layanan | Limit Gratis | Estimasi Kapasitas |
|---|---|---|
| **R2 Storage** | 10 GB | ~300 video @ 30 MB |
| **R2 Egress** | Gratis selamanya | Tidak ada biaya streaming |
| **D1 Reads** | 25 juta/hari | Sangat cukup |
| **D1 Writes** | 100 ribu/hari | Sangat cukup |
| **Workers Requests** | 100 ribu/hari | Cron 5 menit = 288 req/hari |
| **Google Drive** | 15 GB | ~500 video @ 30 MB |
| **Pages** | Gratis selamanya | Unlimited |

---

## Troubleshooting

**Video tidak bisa diputar di galeri**
→ R2 Public Access belum aktif, atau `PUBLIC_URL` belum diset di Pages env variables.

**`/api/health` mengembalikan `db: false`**
→ Binding D1 di Pages belum disimpan. Cek Settings → Functions → D1 bindings → Redeploy.

**Cron berjalan tapi tidak ada file di Drive**
→ Jalankan `npx wrangler tail wedding-booth-cron` lalu trigger manual. Pesan error akan muncul.
→ Paling sering: format `GOOGLE_PRIVATE_KEY` salah. Pastikan paste seluruh key termasuk header/footer PEM.

**`archive_attempts` terus naik, tidak pernah sukses**
```bash
npx wrangler d1 execute wedding-booth-db --remote \
  --command "SELECT id, archive_error FROM entries WHERE archived_at = ''"
```

**Upload gagal error 413**
→ File terlalu besar (batas 150 MB). Kurangi durasi atau kualitas rekaman.
