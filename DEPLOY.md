# Panduan Deployment BLAST TELE

## Opsi Deployment

| Opsi | Web | API + Worker | Cocok Untuk |
|------|-----|-------------|-------------|
| **A. Semua di satu server** | Server | Server | VPS/Cloud |
| **B. Semua di Android** | Termux | Termux | Personal, hemat biaya |
| **C. Split (Recommended)** | Vercel (gratis) | Android/VPS | Fleksibel, ringan |

Database dan Authentication selalu di **Supabase** (cloud) untuk semua opsi.

---

## Opsi A: Deploy di VPS/Cloud

### Prasyarat
- VPS dengan Node.js 18+ (Ubuntu/Debian recommended)
- Akun Supabase (gratis)

### Langkah

```bash
# 1. Clone project
git clone <repo-url>
cd BLAST-TELE

# 2. Install dependencies
npm install

# 3. Setup environment
cp .env.example .env
nano .env  # isi semua variable (lihat README.md)

# 4. Setup database
npm run db:generate
npm run db:push

# 5. Build production
npm run build

# 6. Jalankan
npm run start
```

### Jalankan di Background (PM2)

```bash
npm install -g pm2

# Jalankan semua service
pm2 start npm --name "blast-api" -- run start -w apps/api
pm2 start npm --name "blast-worker" -- run start -w apps/worker
pm2 start npm --name "blast-web" -- run start -w apps/web

# Auto-start saat server reboot
pm2 save
pm2 startup
```

---

## Opsi B: Deploy di Android (Termux)

### Prasyarat
- Android 7+
- Termux dari F-Droid (bukan Play Store)

### Setup Termux

```bash
# 1. Install dasar
pkg update && pkg upgrade -y
pkg install nodejs-lts git -y

# 2. Clone project
git clone <repo-url>
cd BLAST-TELE

# 3. Install dependencies
npm install

# 4. Setup environment
cp .env.example .env
nano .env  # isi semua variable

# 5. Setup Prisma
export PRISMA_ENGINES_MIRROR=https://binaries.prisma.sh
npm run db:generate
npm run db:push

# 6. Build production
npm run build

# 7. Jalankan
npm run start
```

### Jalankan di Background (tmux)

```bash
pkg install tmux -y

# Buat session
tmux new -s blast

# Di dalam tmux, jalankan server
npm run start

# Detach: tekan Ctrl+B lalu D
# Kembali: tmux attach -t blast
```

### Cegah Android Kill Proses

```bash
# Aktifkan wake lock (wajib!)
termux-wake-lock

# Matikan battery optimization untuk Termux di Settings Android:
# Settings > Apps > Termux > Battery > Unrestricted
```

### Jalankan Tanpa Web (Lebih Ringan)

Kalau RAM terbatas, jalankan API + Worker saja:

```bash
npx concurrently "npm run start -w apps/api" "npm run start -w apps/worker"
```

Akses dashboard dari browser HP/PC yang mengarah ke `http://<ip-android>:3000`.

---

## Opsi C: Split Deployment (Web di Vercel + API di Android)

Arsitektur ini memisahkan tampilan (ringan, di cloud gratis) dari mesin broadcast (di Android/VPS).

```
┌──────────────────────────┐       ┌──────────────────────────────┐
│       VERCEL (Gratis)    │       │    ANDROID / VPS             │
│                          │       │                              │
│  Next.js Web Dashboard   │──────>│  API Server (:4000)          │
│  https://app.vercel.app  │ HTTPS │  Worker (broadcast engine)   │
│                          │       │                              │
│  Diakses dari browser    │       │  Terhubung ke:               │
│  mana saja               │       │  - Supabase (database)       │
│                          │       │  - Telegram API              │
└──────────────────────────┘       └─────────────┬────────────────┘
                                                 │
                                   ┌─────────────▼────────────────┐
                                   │   NGROK / CLOUDFLARE TUNNEL  │
                                   │                              │
                                   │   localhost:4000 ──>         │
                                   │   https://xxx.ngrok-free.app │
                                   └──────────────────────────────┘
```

### Step 1: Setup Tunnel di Android/VPS

Tunnel membuat API di jaringan lokal bisa diakses dari internet.

#### Opsi A — Ngrok (Paling Gampang)

```bash
# Di Termux:
pkg install wget -y
wget https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-arm64.tgz
tar xvzf ngrok-v3-stable-linux-arm64.tgz
mv ngrok $PREFIX/bin/

# Daftar gratis di https://ngrok.com → copy authtoken
ngrok config add-authtoken <TOKEN_KAMU>

# Jalankan tunnel
ngrok http 4000
```

Output:
```
Forwarding  https://abc123.ngrok-free.app → http://localhost:4000
```

Catat URL `https://abc123.ngrok-free.app` — ini URL API kamu.

#### Opsi B — Cloudflare Tunnel (URL Tetap, Lebih Stabil)

```bash
# Di Termux:
pkg install cloudflared -y

# Login (perlu domain di Cloudflare)
cloudflared tunnel login
cloudflared tunnel create blast-api
cloudflared tunnel route dns blast-api api.domainmu.com

# Jalankan
cloudflared tunnel --url http://localhost:4000 run blast-api
```

Hasilnya: `https://api.domainmu.com` → API kamu.

#### Perbandingan

| | Ngrok (Gratis) | Cloudflare Tunnel |
|---|---|---|
| Setup | 2 menit | 10 menit |
| URL | Random, berubah tiap restart | Custom domain tetap |
| Limit | 20 koneksi/menit (free) | Unlimited |
| Harga | Gratis (limit) / $8/bln | Gratis (perlu domain) |
| Stabilitas | Kadang putus | Sangat stabil |

### Step 2: Jalankan API + Worker di Android

```bash
cd BLAST-TELE

# Build (sekali saja)
npm run build -w apps/api -w apps/worker

# Jalankan di tmux
tmux new -s blast
npx concurrently "npm run start -w apps/api" "npm run start -w apps/worker"
# Ctrl+B lalu D untuk detach
```

Di tab/tmux session lain, jalankan tunnel:

```bash
tmux new -s tunnel
ngrok http 4000
# Ctrl+B lalu D untuk detach
```

### Step 3: Deploy Web ke Vercel

1. **Push project ke GitHub**

2. **Buka [vercel.com](https://vercel.com)** → Sign up (gratis) → "Add New Project" → Import repo GitHub

3. **Konfigurasi di Vercel:**

   | Setting | Value |
   |---------|-------|
   | Framework Preset | Next.js |
   | Root Directory | `apps/web` |
   | Build Command | `cd ../.. && npm install && npm run build -w apps/web` |
   | Output Directory | `apps/web/.next` |

4. **Environment Variables** di Vercel dashboard:

   ```
   NEXT_PUBLIC_API_URL = https://abc123.ngrok-free.app
   NEXT_PUBLIC_SUPABASE_URL = https://your-project.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY = your-anon-key
   ```

   (Ganti URL tunnel dari Step 1, dan Supabase keys dari dashboard Supabase)

5. **Deploy** → Vercel memberikan URL gratis, misal: `https://blast-tele.vercel.app`

### Step 4: Akses

Buka `https://blast-tele.vercel.app` dari browser mana saja:

```
Browser (PC/HP)
  → https://blast-tele.vercel.app    (Web di Vercel)
  → Login
  → Dashboard tampil
  → Klik "Mulai Broadcast"
  → POST https://abc123.ngrok-free.app/api/broadcast/run  (API di Android)
  → Ngrok forward ke localhost:4000
  → API simpan ke Supabase
  → Worker di Android kirim via Telegram
  → Auto-refresh, lihat progress real-time
```

### Update URL Tunnel

Jika pakai Ngrok gratis, URL berubah setiap restart. Setelah restart ngrok:

1. Catat URL baru dari output ngrok
2. Buka Vercel dashboard → Settings → Environment Variables
3. Update `NEXT_PUBLIC_API_URL` dengan URL baru
4. Redeploy (atau tunggu auto-deploy jika ada push)

Untuk menghindari ini, gunakan Cloudflare Tunnel atau Ngrok berbayar (URL tetap).

---

## Tips Umum

### Cek Semua Service Berjalan

```bash
# API
curl http://localhost:4000/api/auth/me
# Harus return 401 (belum login) — artinya API hidup

# Web
curl http://localhost:3000
# Harus return HTML
```

### Troubleshooting

| Masalah | Solusi |
|---------|--------|
| `EPERM: operation not permitted` saat prisma generate | Stop server dulu, baru jalankan `npm run db:generate` |
| `The column X does not exist` | Jalankan `npm run db:push` untuk sync schema |
| Broadcast stuck di RUNNING | Worker otomatis recover setelah 5 menit, atau restart worker |
| FloodWait dari Telegram | Otomatis pause & resume. Tingkatkan delay di Broadcast Setting |
| Ngrok URL berubah | Update `NEXT_PUBLIC_API_URL` di Vercel, lalu redeploy |
| Android kill Termux | Jalankan `termux-wake-lock` dan matikan battery optimization |
