# Al-Miftah Kuis Nahwu

Aplikasi web kuis nahwu untuk murid Madrasah Idadiyah, dengan sistem XP, rank, kuis harian berhadiah, toko efek, dan leaderboard. Dibuat tanpa framework: satu file HTML (vanilla JS) di sisi klien, satu Cloudflare Pages Function di sisi server, dan database Neon (PostgreSQL).

## Fitur

### Untuk murid
- **Quest Jilid 1–4**: tiap jilid punya 3 level.

  | Level  | Jumlah soal | XP maksimal |
  |--------|------------:|------------:|
  | Mudah  | 10          | 100         |
  | Sedang | 20          | 200         |
  | Sulit  | 30          | 300         |

  Sebuah level dianggap **selesai** bila benar ≥ 60%. Sebuah jilid **khatam** bila ketiga levelnya selesai.
- **Mode Tathbiq** (tanpa batas): soal acak dari semua jilid, 3 nyawa, naik tahap tiap 10 soal (Tathbiq 1–6, lalu Takhossus). Terbuka setelah keempat jilid khatam.
- **Kuis Harian**: 10 soal acak dari semua jilid, satu kesempatan per hari (mengikuti WIB). Nilai ≥ 80 memberi 1 spin hadiah gold (100–1000). Spin ke-10 sejak hadiah langka terakhir dijamin langka (≥ 300 gold).
- **Toko**: 10 efek jawaban benar (100–2800 gold) yang bisa dibeli dan dipasang.
- **Rank**: Bronze (0 XP), Silver (300), Gold (700), Platinum (1200), Diamond (1800).
- **Profil**: ganti username, avatar, efek bingkai profil, dan password. Efek bingkai terbuka bertahap seiring jilid yang khatam dan tahap Tathbiq.
- **Leaderboard**: per jilid, khusus Tathbiq, atau keseluruhan, lengkap dengan pencarian nama.

### Untuk admin
- Statistik: jumlah murid, murid aktif 7 hari, percobaan per jilid, sebaran rank.
- Kelola soal: cari, tambah, ubah, hapus, dan unggah massal dari Excel/CSV.
- Kelola murid: lihat detail dan riwayat, reset password, hapus akun.
- Semua fitur murid terbuka untuk admin (Tathbiq, semua efek, semua pencapaian).

## Cara gold dihitung

Gold **tidak disimpan** di database, selalu dihitung ulang:

```
gold = total XP rekor  +  total hadiah spin  −  total belanja di Toko
```

XP rekor adalah nilai terbaik per kombinasi (jilid, level), dijumlahkan. Untuk Tathbiq, XP adalah skor terbaik sesi tersebut.

## Teknologi

| Lapisan   | Teknologi |
|-----------|-----------|
| Frontend  | HTML, CSS, dan JavaScript murni (satu file `index.html`) |
| Backend   | Cloudflare Pages Functions (`/api/*`) |
| Database  | Neon (PostgreSQL) lewat `@neondatabase/serverless` |
| Hosting   | Cloudflare Pages, deploy otomatis dari GitHub |
| Font      | Amiri dan Plus Jakarta Sans (Google Fonts) |
| Excel     | Pustaka SheetJS, dimuat saat admin membuka menu unggah soal |

## Struktur project

```
.
├── index.html                 # seluruh antarmuka (SPA)
├── logo.png                   # logo yang tampil di halaman masuk dan header
├── favicon.png
├── functions/
│   └── api/
│       └── [[path]].js        # seluruh endpoint API
├── schema.sql                 # skema database lengkap (idempotent)
└── package.json               # dependensi: @neondatabase/serverless
```

`[[path]].js` adalah rute catch-all Cloudflare Pages: semua permintaan ke `/api/...` ditangani file ini, dan rute dibedakan lewat `METHOD + path` (misalnya `POST submit`).

## Instalasi

### 1. Siapkan database Neon
1. Buat project di [Neon](https://neon.tech).
2. Buka SQL Editor dan jalankan seluruh isi `schema.sql`.
   - Skema ini aman dijalankan di database kosong maupun yang sudah berjalan, dan semuanya dalam satu transaksi.
   - Disarankan menguji dulu di Neon Branch sebelum menjalankannya di branch utama.
3. Salin connection string database.

### 2. Deploy ke Cloudflare Pages
1. Push project ke GitHub, lalu hubungkan repositori di Cloudflare Pages.
2. Tidak perlu perintah build; direktori output adalah root project.
3. Tambahkan **environment variables** (Settings → Variables and Secrets):

   | Nama           | Isi |
   |----------------|-----|
   | `DATABASE_URL` | Connection string Neon |
   | `JWT_SECRET`   | String acak panjang untuk menandatangani token. Jaga kerahasiaannya |

4. Pastikan dependensi terpasang. Contoh `package.json` minimal:

   ```json
   {
     "dependencies": {
       "@neondatabase/serverless": "^0.10.0"
     }
   }
   ```

### 3. Buat akun admin
1. Daftar lewat aplikasi (akun baru otomatis berperan `student`).
2. Jadikan admin lewat SQL Editor Neon:

   ```sql
   update users set role = 'admin' where lower(username) = lower('NAMA_ADMIN');
   ```

### 4. Isi bank soal
Masuk sebagai admin, buka menu Admin → Soal, lalu unggah file Excel/CSV dengan kolom:

| jilid | pertanyaan | A | B | C | D | jawaban |
|-------|------------|---|---|---|---|---------|
| 1     | Contoh pertanyaan? | Opsi 1 | Opsi 2 | Opsi 3 | Opsi 4 | A |

- `jilid` berisi 1–4 dan `jawaban` berisi huruf A–D. Semua kolom wajib diisi.
- Maksimal 2000 baris per unggahan.
- Centang "Ganti soal lama pada jilid yang ada di file" bila ingin menimpa soal lama.
- Template bisa diunduh langsung dari halaman tersebut.
- Kuis harian butuh minimal 10 soal di bank soal.

## Skema database

| Tabel             | Fungsi |
|-------------------|--------|
| `users`           | Akun, peran (`student`/`admin`), avatar, efek bingkai, efek jawaban terpasang |
| `questions`       | Bank soal (jilid 1–4, empat opsi, kunci jawaban) |
| `attempts`        | Percobaan kuis dan Tathbiq. Dasar perhitungan XP, rank, dan gold. **Jangan dihapus** |
| `endless_runs`    | Sesi Tathbiq (nyawa, skor, urutan soal). Tahap tertinggi dihitung dari sini |
| `purchases`       | Efek Toko yang sudah dibeli, dengan harga saat pembelian |
| `daily`           | Kuis harian per murid per hari, plus hasil spin hadiah |
| `login_attempts`  | Pembatas percobaan login |

## Daftar endpoint API

Semua di bawah `/api/`. Selain `login` dan `register`, semua membutuhkan header `Authorization: Bearer <token>`.

| Metode & rute | Fungsi |
|---------------|--------|
| `POST register`, `POST login` | Daftar dan masuk, mengembalikan token |
| `GET me` | Profil, XP rekor, pencapaian, status Tathbiq |
| `GET quiz?jilid=&level=` | Mulai kuis jilid |
| `POST submit` | Kirim jawaban kuis, nilai dihitung ulang di server |
| `POST endless/start`, `endless/more`, `endless/sync`, `endless/stop` | Siklus mode Tathbiq |
| `GET daily`, `POST daily/start`, `daily/submit`, `daily/spin` | Kuis harian dan spin hadiah |
| `GET shop`, `POST shop/buy`, `shop/equip` | Toko |
| `POST profile`, `POST password` | Ubah profil dan password |
| `GET leaderboard?jilid=&q=` | Papan peringkat (cache 10 detik per isolate) |
| `GET admin/stats`, `admin/users`, `admin/user`, `admin/questions` | Data admin |
| `POST admin/questions`, `admin/question-save`, `admin/question-delete`, `admin/reset-password`, `admin/delete-user` | Aksi admin |

## Keamanan dan anti-curang

- Password di-hash dengan PBKDF2 (SHA-256, 100.000 iterasi) dan salt acak. Panjang password dibatasi 6–128 karakter.
- Token berupa HMAC-SHA256 yang ditandatangani dengan `JWT_SECRET`, berlaku 7 hari.
- Login dibatasi 8 kali gagal per username dalam 15 menit. Waktu respons dibuat sama walau username tidak ada.
- Skor selalu **dihitung ulang di server** terhadap kunci jawaban di database.
- Setiap kuis punya `nonce` unik sehingga tidak bisa dikirim dua kali.
- Pengiriman yang lebih cepat dari 1 detik per soal ditolak.
- Pembelian di Toko memakai advisory lock agar dua permintaan bersamaan tidak bisa melewati saldo.
- Kuis harian dibuat saat dimulai, sehingga tidak bisa diulang dengan menutup halaman.

**Catatan:** kunci jawaban ikut dikirim ke browser saat kuis dimulai (agar jawaban bisa dicek tanpa request per soal). Nilai tetap dihitung ulang di server, tetapi murid yang membuka DevTools bisa melihat jawaban yang benar.

## Perawatan

Perintah SQL berikut tersedia di bagian bawah `schema.sql`:

- Cek gold seorang murid (harus sama dengan angka di Beranda/Toko).
- Mengulang kuis harian untuk keperluan tes, tanpa menghilangkan hadiah spin.
- Membersihkan catatan `login_attempts` yang sudah lewat masa kunci.
- Menghapus tabel lama `quiz_answers` bila masih ada.

## Mengubah aturan permainan

Konstanta ada di bagian atas `functions/api/[[path]].js`:

| Konstanta | Fungsi |
|-----------|--------|
| `SHOP` | Daftar dan harga efek di Toko |
| `PRIZES`, `RARE`, `PITY` | Hadiah spin, batas hadiah langka, dan jumlah spin sampai hadiah langka dijamin |
| `DAILY_N`, `DAILY_PASS` | Jumlah soal dan nilai lulus kuis harian |
| `PASS_PCT` | Persentase benar agar sebuah quest dianggap selesai |
| `LOGIN_MAX`, `LOGIN_MIN` | Batas dan masa kunci percobaan login |

Batas rank (300/700/1200/1800) didefinisikan di dua tempat dan **harus sama**: `RANKS` di `index.html` dan query `admin/stats` di backend.

## Lisensi

Tentukan sesuai kebutuhan (belum ditentukan).
