# Telegram Broadcast Manager

Boilerplate full-stack untuk otomasi broadcast Telegram dengan kontrol penuh via dashboard web.

## Stack

- Backend API: Node.js + Express + Prisma
- Frontend: Next.js (App Router) + React
- Database: Supabase PostgreSQL (atau PostgreSQL biasa)
- Queue: Postgres-based run queue (tanpa Redis)
- Telegram Client: MTProto via package `telegram` (gramJS)
- Monorepo: npm workspaces

## Fitur Utama

- Dashboard login JWT
- Status akun Telegram (connected/disconnected)
- Statistik pengiriman (sent, failed, pending)
- Group manager: create, toggle active, tagging, import text/file `.txt`, import link folder `t.me/addlist/...`
- Message template manager: text/media, multi-template, spin text
- Broadcast settings: batch, random delay, delay antar batch, send mode (new/forward), parse link pesan Telegram untuk forward
- Scheduler: manual run, interval, cron-like repeat
- Worker terpisah untuk memproses run pending dari Postgres
- Anti-limit safety: limiter + random delay + auto pause untuk FloodWait/PeerFlood
- Session management: request OTP, verify OTP, encrypted session storage
- Logs monitoring + export CSV
- Security baseline: JWT, rate limit API, validation, encrypted session

## Struktur Folder

```text
.
├─ docker-compose.yml
├─ package.json
├─ tsconfig.base.json
├─ .env.example
├─ README.md
└─ apps
   ├─ api
   │  ├─ package.json
   │  ├─ tsconfig.json
   │  ├─ prisma
   │  │  └─ schema.prisma
   │  └─ src
   │     ├─ app.ts
   │     ├─ index.ts
   │     ├─ routes.ts
   │     ├─ config
   │     │  ├─ env.ts
  │     │  └─ prisma.ts
   │     ├─ middleware
   │     │  ├─ auth.ts
   │     │  ├─ error.ts
   │     │  └─ validate.ts
   │     ├─ modules
   │     │  ├─ auth
   │     │  ├─ broadcast
   │     │  ├─ dashboard
   │     │  ├─ groups
   │     │  ├─ logs
   │     │  ├─ scheduler
   │     │  ├─ settings
   │     │  ├─ telegram
   │     │  └─ templates
   │     ├─ telegram
   │     │  └─ mtproto-client.ts
   │     ├─ types
   │     │  └─ express.d.ts
   │     └─ utils
   ├─ worker
   │  ├─ package.json
   │  ├─ tsconfig.json
   │  └─ src
   │     ├─ index.ts
   │     ├─ config
   │     ├─ jobs
   │     │  ├─ broadcast.worker.ts
   │     │  └─ scheduler.worker.ts
   │     ├─ telegram
   │     │  └─ mtproto-sender.ts
   │     └─ utils
   └─ web
      ├─ package.json
      ├─ tsconfig.json
      ├─ next.config.js
      ├─ app
      │  ├─ globals.css
      │  ├─ layout.tsx
      │  ├─ page.tsx
      │  ├─ login/page.tsx
      │  └─ dashboard/page.tsx
      ├─ components
      ├─ lib
      └─ types
```

## Setup Cepat

### 1) Pilih sumber database

Jika full Supabase: skip langkah ini.

Jika local PostgreSQL: jalankan container ini:

```bash
docker compose up -d
```

### 2) Install dependencies

```bash
npm install
```

### 3) Siapkan environment

Copy `.env.example` menjadi `.env`, lalu sesuaikan nilai berikut:

- `DATABASE_URL`
- `DIRECT_URL`
- `JWT_SECRET`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `SESSION_ENCRYPTION_KEY` (minimal 32 karakter)
- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`
- `RUN_POLL_INTERVAL_MS` (opsional)
- `SCHEDULE_POLL_INTERVAL_MS` (opsional)

### Pakai Supabase (Recommended untuk VPS/Cloud)

1. Buat project di Supabase.
2. Buka menu Database > Connection string.
3. Ambil 2 URL:
  - Transaction Pooler (port 6543) untuk `DATABASE_URL`
  - Direct connection (port 5432) untuk `DIRECT_URL`
4. Isi `.env`:

```env
DATABASE_URL=postgresql://postgres.<project-ref>:<db-password>@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1&sslmode=require
DIRECT_URL=postgresql://postgres.<project-ref>:<db-password>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require
```

Catatan:
- `DATABASE_URL` dipakai API/Worker runtime agar koneksi stabil lewat pooler.
- `DIRECT_URL` dipakai Prisma migrate/db push agar operasi schema lebih aman.
- Jika host direct `db.<project-ref>.supabase.co` tidak bisa di-resolve dari jaringan lokal, pakai session pooler port 5432 seperti contoh di atas.
- Redis tidak dibutuhkan.

### 4) Sinkronkan schema database

Untuk Supabase (paling aman dan cepat):

```bash
npm run db:generate
npm run db:push
```

Penting:
- Jika pakai Supabase, hindari `npm run db:migrate` dari mesin lokal karena bisa hang/timeout saat koneksi pooler.
- Gunakan `npm run db:push` untuk sinkronisasi schema.

Untuk local development dengan migration history:

```bash
npm run db:generate
npm run db:migrate
```

### 5) Jalankan seluruh aplikasi

```bash
npm run dev
```

Service default:

- API: http://localhost:4000
- Web: http://localhost:3000

## Contoh Endpoint API

### Auth

- `POST /api/auth/login`
- `GET /api/auth/me`

### Dashboard

- `GET /api/dashboard/overview`

### Group Manager

- `GET /api/groups`
- `POST /api/groups`
- `PATCH /api/groups/:id`
- `DELETE /api/groups/:id`
- `POST /api/groups/import/text`
- `POST /api/groups/import/folder-link`
- `POST /api/groups/import/file` (multipart form-data, field: `file`)

Contoh payload import text:

```json
{
  "content": "@groupA;crypto,jualan\n-1001234567890;promo",
  "defaultTags": ["campaign-april"]
}
```

Contoh payload import folder link:

```json
{
  "link": "https://t.me/addlist/HKNL_5Qp3wQxNGRl",
  "defaultTags": ["folder-april"],
  "accountId": "optional-account-id"
}
```

### Template

- `GET /api/templates`
- `POST /api/templates`
- `PATCH /api/templates/:id`
- `DELETE /api/templates/:id`

Contoh spin text:

```text
Halo {bro|sis|teman}, cek {promo|diskon|deal} terbaru hari ini.
```

### Broadcast

- `POST /api/broadcast/run`
- `GET /api/broadcast/runs`
- `POST /api/broadcast/runs/:id/pause`
- `POST /api/broadcast/runs/:id/resume`

Contoh setting mode forward (via endpoint settings):

```json
{
  "name": "Forward Channel Promo",
  "isActive": true,
  "batchSizeMin": 10,
  "batchSizeMax": 25,
  "messageDelayMinSec": 20,
  "messageDelayMaxSec": 75,
  "batchDelayMinMin": 20,
  "batchDelayMaxMin": 120,
  "sendMode": "FORWARD",
  "forwardMessageLink": "https://t.me/putrabttstore/70",
  "randomizeGroups": true,
  "autoPauseOnLimit": true
}
```

### Scheduler

- `GET /api/scheduler`
- `POST /api/scheduler`
- `POST /api/scheduler/:id/toggle`
- `POST /api/scheduler/:id/trigger`

### Telegram Session

- `GET /api/telegram/accounts`
- `POST /api/telegram/request-otp`
- `POST /api/telegram/verify-otp`
- `POST /api/telegram/accounts/:id/disconnect`
- `GET /api/telegram/accounts/:id/test`

### Logs

- `GET /api/logs/send`
- `GET /api/logs/activity`
- `GET /api/logs/send/export`

## Worker Flow (Ringkas)

- API membuat `BroadcastRun` dengan status `PENDING`.
- Worker polling Postgres untuk run `PENDING` lalu memproses run dengan batching berdasarkan setting.
- Worker polling schedule aktif (`INTERVAL`/`CRON`) untuk membuat run otomatis.
- Antar pesan memakai random delay + minimum spacing (`MIN_SPACING_MS`).
- Antar batch memakai random delay (menit).
- Jika error `FLOOD_WAIT_xx`:
  - Run otomatis `PAUSED`
  - simpan `pausedUntil`
  - worker auto-resume saat `pausedUntil` terlewati
- Jika `PEER_FLOOD`:
  - Run otomatis `PAUSED`
  - menunggu tindakan operator (resume manual)

## Security Baseline

- JWT auth untuk endpoint dashboard
- API rate limiter (`/api`)
- Input validation dengan Zod
- Session Telegram disimpan dalam bentuk terenkripsi AES-256-GCM
- Worker terpisah dari API process

## Catatan Pengembangan Lanjut

- Tambahkan RBAC user multi-role
- Tambahkan upload media ke object storage (S3/MinIO)
- Tambahkan retry policy per error code
- Tambahkan alerting (Telegram internal/admin email)
- Tambahkan observability (Prometheus + Grafana)

## UI Template Attribution

Frontend dashboard dan halaman login menggunakan aset dari:

- TailAdmin Free Tailwind Dashboard Template: https://github.com/TailAdmin/tailadmin-free-tailwind-dashboard-template
- License: MIT

Salinan aset UI berada di:

- apps/web/public/tailadmin/style.css
- apps/web/public/tailadmin/src/images
- apps/web/public/tailadmin/LICENSE
#   t e l e - p r o  
 