# BLAST TELE — Telegram Broadcast Manager

Sistem otomasi broadcast Telegram dengan dashboard web, mendukung pengiriman pesan massal ke banyak group secara bersamaan (concurrent), dengan fitur auto-join group, crash recovery, dan monitoring real-time.

## Tech Stack

| Layer | Teknologi |
|-------|-----------|
| **Frontend** | Next.js 14 (App Router) + React 18 + Bootstrap 5 |
| **API** | Node.js + Express + Prisma ORM |
| **Worker** | Node.js (polling-based, concurrent) |
| **Database** | PostgreSQL via Supabase (cloud) |
| **Auth** | Supabase Auth (email/password) |
| **Telegram** | MTProto via GramJS (`telegram` package) |
| **Monorepo** | npm workspaces |

## Fitur

### Broadcast
- **Direct Message** — kirim teks langsung ke semua group
- **Forward Link** — forward pesan dari channel/group sumber
- **Batch Interval** — kirim berulang selama X jam, setiap Y menit
- **Concurrent** — jalankan beberapa broadcast sekaligus (paralel)
- **Nama Broadcast** — beri label untuk identifikasi di monitoring

### Group Management
- **Satu input** — paste link group, @username, link invite private, atau link addlist
- **Auto-join** — akun Telegram otomatis join ke group yang ditambahkan
- Format: `@username`, `t.me/group`, `t.me/+hash`, `t.me/joinchat/hash`, `t.me/addlist/slug`
- Pencarian & pagination di daftar group

### Monitoring
- **Live dashboard** — kartu monitoring per broadcast aktif (Sent/Failed/Pending/Progress)
- **Auto-refresh** — data update otomatis setiap 5-60 detik (configurable)
- **Run History** — riwayat lengkap dengan nama, mode, pesan/link, status
- **Send Logs** — detail error per group dengan penjelasan bahasa Indonesia
- **Filter** — status (ALL/FAILED/SUCCESS) + rentang tanggal
- **Pagination** — semua tabel mendukung pagination (5/10/20/50 per halaman)
- **Export CSV** — download log pengiriman

### Safety & Recovery
- **Crash recovery** — jika server mati, broadcast otomatis dilanjutkan dari terakhir dikirim
- **Graceful shutdown** — SIGINT/SIGTERM/crash ditangani, run tidak stuck
- **SendLog deduplication** — group yang sudah terkirim tidak dikirim ulang saat resume
- **FloodWait auto-pause** — otomatis pause & resume saat rate limit Telegram
- **PeerFlood detection** — pause otomatis saat terdeteksi spam
- **Delay & randomization** — delay antar pesan, antar batch, urutan group acak

### Lainnya
- Login via Supabase Auth (email/password, auto-refresh token)
- Template manager (text, media URL, spin text)
- Scheduler (manual, interval, cron)
- Session Telegram terenkripsi (AES-256-GCM)
- Dark mode
- Responsive (mobile-friendly)

## Struktur Project

```
BLAST-TELE/
├── .env.example              # Template environment variables
├── package.json              # Root monorepo config
├── tsconfig.base.json        # Shared TypeScript config
│
├── apps/
│   ├── api/                  # REST API Server (Express)
│   │   ├── prisma/
│   │   │   └── schema.prisma # Database schema
│   │   └── src/
│   │       ├── index.ts      # Entry point (:4000)
│   │       ├── app.ts        # Express app setup
│   │       ├── routes.ts     # Route registration
│   │       ├── config/       # env, prisma client
│   │       ├── middleware/    # auth, error, validate
│   │       ├── modules/      # Fitur per modul:
│   │       │   ├── auth/         # Login JWT
│   │       │   ├── broadcast/    # Create & manage runs
│   │       │   ├── dashboard/    # Overview stats
│   │       │   ├── groups/       # Group CRUD + auto-join
│   │       │   ├── logs/         # Send logs + activity
│   │       │   ├── scheduler/    # Cron/interval schedules
│   │       │   ├── settings/     # Broadcast settings
│   │       │   ├── telegram/     # OTP, session management
│   │       │   └── templates/    # Message templates
│   │       ├── telegram/     # MTProto client
│   │       └── utils/        # Helpers, crypto, link parser
│   │
│   ├── worker/               # Background Worker
│   │   └── src/
│   │       ├── index.ts      # Entry point + graceful shutdown
│   │       ├── jobs/
│   │       │   ├── broadcast.worker.ts  # Concurrent broadcast engine
│   │       │   └── scheduler.worker.ts  # Schedule polling
│   │       ├── telegram/     # MTProto sender
│   │       └── utils/        # Logger, sleep, random
│   │
│   └── web/                  # Frontend Dashboard (Next.js)
│       ├── app/
│       │   ├── login/        # Halaman login
│       │   └── dashboard/    # Dashboard utama (semua fitur)
│       ├── lib/              # API fetch helper
│       └── types/            # TypeScript types
```

## Alur Kerja Broadcast

```
Dashboard                API                    Database              Worker
   │                      │                       │                     │
   │  POST /broadcast/run │                       │                     │
   │─────────────────────>│                       │                     │
   │                      │  Create BroadcastRun  │                     │
   │                      │  status: PENDING      │                     │
   │                      │──────────────────────>│                     │
   │                      │                       │                     │
   │                      │                       │  Poll setiap 3 detik│
   │                      │                       │<────────────────────│
   │                      │                       │                     │
   │                      │                       │  Claim: PENDING→RUNNING
   │                      │                       │<────────────────────│
   │                      │                       │                     │
   │                      │                       │  Kirim ke group 1..N│
   │                      │                       │  (concurrent runs)  │
   │                      │                       │<────────────────────│
   │                      │                       │                     │
   │  Auto-refresh data   │  GET /broadcast/runs  │                     │
   │─────────────────────>│──────────────────────>│                     │
   │  Live monitoring     │                       │                     │
   │<─────────────────────│                       │                     │
   │                      │                       │  RUNNING→COMPLETED  │
   │                      │                       │<────────────────────│
```

## Setup

### 1. Clone & Install

```bash
git clone <repo-url>
cd BLAST-TELE
npm install
```

### 2. Environment Variables

Copy `.env.example` ke `.env` dan isi:

```bash
cp .env.example .env
```

**Wajib diisi:**

| Variable | Keterangan |
|----------|------------|
| `DATABASE_URL` | PostgreSQL connection string (pooler, port 6543 untuk Supabase) |
| `DIRECT_URL` | PostgreSQL direct connection (port 5432, untuk prisma push) |
| `SUPABASE_URL` | URL project Supabase (contoh: `https://xxx.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key dari Supabase dashboard |
| `NEXT_PUBLIC_SUPABASE_URL` | Sama dengan `SUPABASE_URL` (untuk frontend) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key dari Supabase dashboard (untuk frontend) |
| `TELEGRAM_API_ID` | Dari https://my.telegram.org |
| `TELEGRAM_API_HASH` | Dari https://my.telegram.org |
| `SESSION_ENCRYPTION_KEY` | 32 karakter untuk enkripsi session Telegram |

**Opsional:**

| Variable | Default | Keterangan |
|----------|---------|------------|
| `API_PORT` | `4000` | Port API server |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | URL API untuk frontend |
| `MIN_SPACING_MS` | `5000` | Minimum delay antar pesan (ms) |
| `RUN_POLL_INTERVAL_MS` | `3000` | Interval polling worker (ms) |
| `SCHEDULE_POLL_INTERVAL_MS` | `30000` | Interval polling scheduler (ms) |

### 3. Setup Database

```bash
# Generate Prisma client
npm run db:generate

# Push schema ke database
npm run db:push
```

### 4. Buat User Login di Supabase

1. Buka [Supabase Dashboard](https://supabase.com/dashboard) → pilih project
2. Buka menu **Authentication** → **Users**
3. Klik **Add User** → **Create New User**
4. Isi email dan password → klik **Create User**
5. Centang **Auto Confirm User** atau konfirmasi manual

User ini yang akan dipakai login ke dashboard BLAST TELE.

### 5. Jalankan

**Development:**

```bash
npm run dev
```

**Production:**

```bash
npm run build
npm run start
```

**Service:**

| Service | URL | Port |
|---------|-----|------|
| Web Dashboard | http://localhost:3000 | 3000 |
| API Server | http://localhost:4000 | 4000 |
| Worker | (background process) | - |

### 6. Login & Mulai

1. Buka http://localhost:3000
2. Login dengan email/password yang dibuat di Supabase (Step 4)
3. **Session Telegram** — Request OTP → Verify OTP
4. **Manage Group** — Paste link group → auto-join
5. **Broadcast** — Pilih mode, isi pesan, jalankan

## API Endpoints

### Auth
| Method | Path | Keterangan |
|--------|------|------------|
| POST | `/api/auth/login` | Login, return JWT |
| GET | `/api/auth/me` | Cek user aktif |

### Groups
| Method | Path | Keterangan |
|--------|------|------------|
| GET | `/api/groups` | List groups (search, tag filter) |
| POST | `/api/groups` | Create group manual |
| POST | `/api/groups/add-by-link` | **Tambah + auto-join** (link/username/addlist) |
| PATCH | `/api/groups/:id` | Update group |
| DELETE | `/api/groups/:id` | Hapus group |

### Broadcast
| Method | Path | Keterangan |
|--------|------|------------|
| POST | `/api/broadcast/run` | Buat broadcast baru (label, mode, pesan/link, durasi) |
| GET | `/api/broadcast/runs` | List semua runs |
| POST | `/api/broadcast/runs/:id/pause` | Pause broadcast |
| POST | `/api/broadcast/runs/:id/resume` | Resume broadcast |

### Telegram Session
| Method | Path | Keterangan |
|--------|------|------------|
| GET | `/api/telegram/accounts` | List akun |
| POST | `/api/telegram/request-otp` | Kirim OTP |
| POST | `/api/telegram/verify-otp` | Verifikasi OTP |

### Templates, Settings, Scheduler, Logs
| Method | Path |
|--------|------|
| GET/POST/PATCH/DELETE | `/api/templates`, `/api/templates/:id` |
| GET/POST | `/api/settings` |
| GET/POST | `/api/scheduler`, `/api/scheduler/:id/toggle`, `/api/scheduler/:id/trigger` |
| GET | `/api/logs/send`, `/api/logs/activity`, `/api/logs/send/export` |
| GET | `/api/dashboard/overview` |

## Deployment

Lihat [DEPLOY.md](./DEPLOY.md) untuk panduan lengkap deployment termasuk:
- Deploy di VPS/Cloud (standard)
- Deploy di Android (Termux)
- Split deployment: Web di Vercel + API di Android via tunnel

## License

Private project.
