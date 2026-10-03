# Al-Miftah Kuis Nahwu

Aplikasi kuis nahwu untuk murid Madrasah Idadiyah Al-Miftah: 4 jilid, 3 tingkat kesulitan, Kuis Harian + spin hadiah, mode Tathbiq, Toko efek, leaderboard, laporan soal salah, dan Panel Admin (unggah soal dari Excel).

Tiga bagian, semuanya bisa memakai paket gratis untuk mulai:

```
Peramban murid ──►  Cloudflare Pages          ──►  Neon PostgreSQL
                    • index.html (halaman)         • semua data murid, soal, XP
                    • functions/api/[[path]].js    • dibuat dari schema.sql
                      (API, jalan di Cloudflare)
                          ▲
                       GitHub (setiap push = deploy otomatis)
```

Hanya ada **dua variabel lingkungan** yang wajib diisi di Cloudflare: `DATABASE_URL` dan `JWT_SECRET` (lihat bagian 5.3).

---

## 1. Isi repositori

Susunan yang disarankan:

```
repo/
├─ public/                      ← folder yang disajikan ke publik (Build output directory)
│  ├─ index.html
│  ├─ logo.png
│  ├─ favicon.png
│  └─ rank/
│     ├─ bronze.webp
│     ├─ silver.webp
│     ├─ gold.webp
│     ├─ platinum.webp
│     ├─ diamond.webp
│     └─ legend.webp
├─ functions/
│  └─ api/
│     └─ [[path]].js            ← berkas API (dua kurung siku persis seperti itu)
├─ package.json
├─ schema.sql
└─ README.md
```

Catatan penting:

* Di unduhan, berkas API bernama `__path__.js` karena kurung siku tidak bisa diunggah. **Ganti namanya menjadi `[[path]].js`** dan taruh di `functions/api/`. Dengan nama itu, semua alamat `/api/...` otomatis ditangani berkas tersebut.
* `schema.sql`, `package.json`, dan `README.md` sengaja berada **di luar** `public/`, supaya tidak bisa diunduh orang lewat alamat situs.
* Tata letak lain juga boleh (misalnya `index.html` langsung di akar repo). Syaratnya hanya: folder `functions/` ada di akar repo, dan "Build output directory" di Cloudflare diarahkan ke folder tempat `index.html` berada. Kalau `index.html` di akar, berkas seperti `schema.sql` ikut bisa diunduh publik, jadi pindahkan ke `public/` bila bisa.

---

## 2. Yang perlu disiapkan

Tiga akun (semuanya punya paket gratis; cek batas pemakaian masing-masing di dashboard):

1. **GitHub**: https://github.com
2. **Neon**: https://neon.com (database PostgreSQL)
3. **Cloudflare**: https://dash.cloudflare.com (Pages)

---

## 3. Neon (database)

### 3.1 Buat proyek
1. Masuk ke Neon Console, klik **Create project**.
2. Beri nama (mis. `al-miftah`). Pilih region yang paling dekat dengan pengguna; untuk Indonesia, pilih **Asia Pacific (Singapore)**.
3. Klik **Create**.

### 3.2 Buat tabel
1. Di proyek tadi buka **SQL Editor**.
2. Buka `schema.sql`, salin **seluruh isinya**, tempel ke editor, lalu klik **Run**.
3. Pesan sukses berarti semua tabel, indeks, dan fungsi `gold_bonus` sudah dibuat.

`schema.sql` aman dijalankan berulang kali, dan aman di database yang sudah berisi data (tidak menghapus atau mengubah apa pun yang sudah ada). Kalau database Anda sudah berisi data murid, uji dulu di **Branches → Create branch**, baru jalankan di branch utama.

### 3.3 Salin connection string
1. Di **Dashboard** proyek, klik **Connect**.
2. Pilih branch `main`, database `neondb`, dan role bawaan.
3. Nyalakan **Connection pooling** (alamatnya mengandung `-pooler`) dan salin **connection string** yang tampil. Bentuknya:

```
postgresql://NAMA_ROLE:PASSWORD@ep-xxxx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
```

Simpan di tempat aman. Ini nilai untuk `DATABASE_URL` di Cloudflare. **Jangan** menaruhnya di GitHub atau kode.

---

## 4. GitHub

1. Klik **New repository**, beri nama (mis. `kuisidadiyah`), pilih **Private**, lalu **Create repository**.
2. Unggah berkas sesuai susunan di bagian 1:
   * Lewat web: **Add file → Upload files** untuk `public/`, `package.json`, `schema.sql`, `README.md`.
   * Untuk API: **Add file → Create new file**, ketik namanya `functions/api/[[path]].js` (garis miring otomatis membuat folder), lalu tempel isi `__path__.js`.
3. Atau lewat terminal:

```bash
git init
git add .
git commit -m "Instalasi awal"
git branch -M main
git remote add origin https://github.com/USERNAME/NAMA_REPO.git
git push -u origin main
```

Tambahkan juga berkas `.gitignore` berisi:

```
node_modules/
.dev.vars
.env
.wrangler/
```

---

## 5. Cloudflare Pages

### 5.1 Hubungkan repositori
1. Di Cloudflare Dashboard buka **Workers & Pages → Create application → Pages → Connect to Git**. (Nama menu bisa sedikit berbeda antar versi dashboard.)
2. Izinkan Cloudflare membaca GitHub Anda, lalu pilih repositori tadi dan klik **Begin setup**.

### 5.2 Pengaturan build

| Kolom | Isi |
|---|---|
| Project name | bebas (menjadi alamat `nama.pages.dev`) |
| Production branch | `main` |
| Framework preset | **None** |
| Build command | *npm install* |
| Build output directory | **`public`** (atau folder tempat `index.html` berada) |
| Root directory | *(kosongkan)* |

Tidak ada langkah build: halaman disajikan apa adanya, dan Cloudflare memasang dependensi dari `package.json` untuk berkas API.

### 5.3 Variabel lingkungan (yang harus diisi)

Isi di bagian **Environment variables** pada layar setup, atau nanti di **Settings → Variables and Secrets** proyek. Pilih tipe **Secret** (Encrypt) untuk keduanya.

| Nama | Wajib | Isi | Keterangan |
|---|---|---|---|
| `DATABASE_URL` | Ya | connection string Neon dari 3.3 | Tanpa ini semua API gagal. |
| `JWT_SECRET` | Ya | teks acak panjang, minimal 32 karakter | Kunci penanda tangan token login (masa berlaku 7 hari). Buat dengan `openssl rand -base64 48`, atau ketik acak 40+ karakter. |
| `NODE_VERSION` | Tidak | `22` | Hanya bila build gagal karena versi Node terlalu lama. |

Catatan:
* Hanya dua variabel itu yang dibaca kode (`env.DATABASE_URL` dan `env.JWT_SECRET`). Tidak ada variabel lain.
* Kalau `JWT_SECRET` kosong, login dan daftar akan gagal dengan error server.
* **Mengganti `JWT_SECRET` mengeluarkan semua murid dari akun mereka** (token lama tidak berlaku). Mereka tinggal masuk lagi; data tidak hilang.
* Cloudflare punya dua lingkungan, **Production** dan **Preview** (untuk branch/PR). Kalau memakai Preview, isi variabelnya di sana juga. Sebaiknya Preview memakai database Neon branch terpisah.
* Perubahan variabel baru berlaku pada **deploy berikutnya**. Setelah mengubahnya, jalankan ulang deploy (Deployments → deploy terakhir → Retry deployment) atau push satu commit.

### 5.4 Deploy
Klik **Save and Deploy**. Setelah selesai, situs aktif di `https://NAMA_PROYEK.pages.dev`. Setiap `git push` ke `main` otomatis men-deploy ulang.

### 5.5 Domain sendiri (opsional)
Proyek Pages → **Custom domains → Set up a custom domain**, lalu ikuti petunjuknya.

---

## 6. Setelah deploy: langkah pertama

1. Buka situs, klik daftar. Username 3–20 karakter (huruf, angka, garis bawah), password minimal 6 karakter.
2. Jadikan akun itu admin lewat Neon SQL Editor:
   ```sql
   update users set role = 'admin' where lower(username) = lower('NAMA_ADMIN');
   ```
   Muat ulang situs; menu **Panel Admin** akan muncul.
3. Buka **Panel Admin → Kelola soal**, unduh template Excel, isi, lalu unggah (format di bagian 7).
4. Coba satu kuis dari akun murid biasa untuk memastikan soal muncul, dan coba tombol 🚩 Lapor, lalu cek tab **Laporan** di akun admin.

---

## 7. Format Excel bank soal

Kolom (baris pertama adalah judul; nama kolom tidak peka huruf besar/kecil):

| jilid | bab | pertanyaan | A | B | C | D | jawaban |
|---|---|---|---|---|---|---|---|
| 1 | Bab 1 | Contoh pertanyaan? | Opsi 1 | Opsi 2 | Opsi 3 | Opsi 4 | A |

* `jilid` wajib 1–4; `jawaban` wajib huruf A–D; semua kolom lain kecuali `bab` wajib terisi.
* `bab` **boleh kosong atau kolomnya dihapus**. Soal tanpa bab tetap dipakai sebagai cadangan acak. Soal ber-bab diprioritaskan, diambil bergiliran per bab supaya semua bab tercakup.
* Maksimal 2000 baris per unggahan. Satu baris salah menggagalkan seluruh unggahan (pesan menyebut nomor barisnya).
* Centang **Ganti soal lama pada jilid yang ada di file** bila ingin menimpa; kalau tidak, soal ditambahkan ke yang sudah ada (mengunggah file yang sama dua kali membuat soal ganda).
* Sebelum menimpa, klik **Unduh semua soal** sebagai cadangan.

---

## 8. Memperbarui aplikasi

* Ubah berkas di GitHub (atau `git push`), Cloudflare men-deploy otomatis dalam beberapa menit.
* Kalau pembaruan menambah kolom atau tabel, jalankan `schema.sql` terbaru di Neon **sebelum** meng-deploy kode barunya. Aman untuk kode lama karena hanya menambah.
* Kualitas efek Toko: di Profil ada pilihan Otomatis / Tinggi / Sedang / Rendah. Untuk mengukur kelancaran, buka situs dengan `/?fps` di ujung alamat.

Pengaturan yang bisa diubah di kode `functions/api/[[path]].js` (bukan di variabel lingkungan):

| Konstanta | Nilai sekarang | Arti |
|---|---|---|
| `GOLD_RATE` | 1 | Gold per XP rekor |
| `PASS_PCT` | 60 | Persen benar agar sebuah quest dianggap selesai |
| `DAILY_N` / `DAILY_PASS` | 10 / 80 | Jumlah soal Kuis Harian / nilai minimal untuk dapat spin |
| `RARE` / `PITY` | 300 / 10 | Batas hadiah langka / spin ke-10 dijamin langka |
| `LOGIN_MAX` / `LOGIN_MIN` | 8 / 15 | Maksimal gagal login per username / dalam berapa menit |
| `REPORT_DAY` | 30 | Maksimal laporan soal per murid per hari |
| `SHOP`, `NSHOP` | harga 100–2800 | Harga efek jawaban dan gaya nama |

---

## 9. Pemecahan masalah

| Gejala | Penyebab umum | Solusi |
|---|---|---|
| Halaman tampil, tapi daftar/masuk gagal atau error server | `DATABASE_URL` atau `JWT_SECRET` belum diisi / salah | Periksa 5.3, lalu deploy ulang. Lihat log di proyek Pages (tab Functions → Real-time logs; nama menu bisa berbeda). |
| `/api/...` menghasilkan 404 | Berkas API salah nama atau salah folder | Harus `functions/api/[[path]].js`, di akar repo. |
| Error `function gold_bonus does not exist` atau `column "fxn"/"on_board"/"bab" does not exist` | `schema.sql` belum dijalankan | Jalankan `schema.sql` di Neon SQL Editor. |
| Logo atau gambar rank tidak muncul | `logo.png`, `favicon.png`, `rank/*.webp` tidak ada di folder output | Pastikan berkas ada di `public/` dan Build output directory = `public`. |
| Variabel sudah diubah tapi tidak berpengaruh | Belum deploy ulang | Retry deployment atau push commit. |
| Semua murid tiba-tiba keluar akun | `JWT_SECRET` diganti | Normal; murid masuk lagi. |
| Build gagal di langkah install | Versi Node atau lockfile | Tambahkan variabel `NODE_VERSION` = `22`; bila perlu jalankan `npm install` sekali di komputer ber-Node.js lalu commit `package-lock.json`. |
| "Terlalu banyak percobaan gagal" saat login | 8 kali salah dalam 15 menit | Tunggu 15 menit, atau hapus catatannya: `delete from login_attempts where key = 'u:namauser';` (huruf kecil semua). |
| Permintaan pertama setelah lama sepi terasa lambat | Database Neon tidur saat tidak dipakai | Normal pada paket gratis; berikutnya cepat kembali. |
| Efek jawaban patah-patah di HP | Perangkat lemah | Profil → Kualitas efek jawaban → pilih Rendah (Otomatis biasanya menurunkannya sendiri). |

---

## 10. Keamanan dan cadangan

* Jangan pernah menaruh `DATABASE_URL` atau `JWT_SECRET` di GitHub, kode, atau tangkapan layar. Kalau terlanjur bocor: di Neon ganti password role (Roles → Reset password) lalu perbarui `DATABASE_URL`; ganti juga `JWT_SECRET`.
* Password murid disimpan sebagai hash PBKDF2 (100.000 iterasi) dengan salt; admin tidak bisa melihat password, hanya mereset.
* Cadangan soal: **Panel Admin → Unduh semua soal** (Excel).
* Cadangan database: gunakan fitur Neon (Branches dan riwayat pemulihan; cek lama penyimpanannya di paket Anda), atau ekspor tabel penting dari SQL Editor secara berkala.

---

## Lampiran: tabel database

| Tabel | Isi |
|---|---|
| `users` | akun murid dan admin; foto, efek profil, efek jawaban (`fxa`), gaya nama (`fxn`), `on_board` untuk admin |
| `questions` | bank soal per jilid, kolom `bab` opsional |
| `attempts` | hasil kuis dan Tathbiq; dasar perhitungan XP, rank, gold |
| `endless_runs` | sesi Mode Tathbiq (nyawa, skor, urutan soal) |
| `purchases` | efek dan gaya nama yang dibeli beserta harganya |
| `daily` | Kuis Harian per murid per hari (WIB) dan hasil spin hadiah |
| `login_attempts` | pembatas percobaan login |
| `question_reports` | laporan soal salah dari murid beserta statusnya |
| fungsi `gold_bonus(user)` | total hadiah spin harian seorang murid |

Gold tidak disimpan: `gold = XP rekor + gold_bonus − total belanja`.
