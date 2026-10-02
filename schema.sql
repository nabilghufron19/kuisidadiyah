-- =====================================================================
--  Al-Miftah Kuis Nahwu — SKEMA DATABASE LENGKAP (Neon / PostgreSQL)
--
--  * Disusun dari audit seluruh query di [[path]].js (71 query): setiap
--    tabel, kolom, ON CONFLICT, dan foreign key yang dipakai kode ada di sini.
--  * Idempotent: aman dijalankan di database KOSONG maupun database yang
--    sudah berjalan. Yang sudah ada tidak diubah, tidak dihapus; hanya yang
--    kurang yang ditambahkan. Data murid, soal, dan XP tidak tersentuh.
--  * Semua dalam satu transaksi: kalau ada yang gagal, tidak ada yang berubah.
--  * Skema ini DISUSUN DARI KODE, bukan dari dump database Anda. Kalau tabel
--    Anda sudah ada dengan tipe kolom berbeda, tipe itu dibiarkan.
--
--  Tabel yang dipakai aplikasi:
--    users, questions, attempts, endless_runs   -> inti kuis dan Tathbiq
--    purchases                                  -> Toko (efek yang dibeli)
--    daily                                      -> Kuis Harian + spin hadiah
--    login_attempts                             -> pembatas percobaan login
--
--  Saldo gold TIDAK disimpan; selalu dihitung:
--    gold = XP rekor (attempts) + SUM(daily.prize) - SUM(purchases.price)
--
--  Saran: uji dulu di Neon branch (Branches > Create branch), baru jalankan
--  di branch utama.
-- =====================================================================
begin;

-- ---------- 1. Pengguna ----------
create table if not exists users (
  id         serial primary key,
  username   text        not null check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  pass_hash  text        not null,
  salt       text        not null,
  role       text        not null default 'student' check (role in ('student', 'admin')),
  avatar     text        not null default 'a1'      check (avatar ~ '^a([1-9]|1[0-2])$'),
  fx         integer,                       -- efek bingkai profil: NULL = otomatis, 0 = tanpa efek, 1-11 = pilihan
  fxa        text,                          -- efek jawaban benar yang dipasang di Toko: NULL = konfeti bawaan
  created_at timestamptz not null default now()
);
alter table users add column if not exists fx  integer;
alter table users add column if not exists fxa text;

-- fx hanya boleh NULL atau 0-11 (sama dengan validasi API). NOT VALID: hanya berlaku untuk
-- data baru, jadi tidak memeriksa/menolak baris lama.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_fx_range') then
    alter table users add constraint users_fx_range check (fx is null or fx between 0 and 11) not valid;
  end if;
end $$;

-- Username tidak boleh kembar walau beda huruf besar/kecil ("Ali" = "ali").
do $$
begin
  if exists (select 1 from users group by lower(username) having count(*) > 1) then
    raise exception 'Ada username kembar (beda huruf besar/kecil). Cek dengan: select lower(username), count(*), array_agg(id) from users group by 1 having count(*) > 1; ganti nama salah satunya, lalu jalankan ulang.';
  end if;
end $$;
create unique index if not exists users_username_lower_uq on users (lower(username));

-- ---------- 2. Bank soal ----------
create table if not exists questions (
  id     serial primary key,
  jilid  integer not null check (jilid between 1 and 4),
  q      text    not null,
  a      text    not null,
  b      text    not null,
  c      text    not null,
  d      text    not null,
  answer text    not null check (answer in ('A', 'B', 'C', 'D'))
);
create index if not exists questions_jilid_idx on questions (jilid);

-- ---------- 3. Percobaan kuis & Tathbiq ----------
-- jilid = 0 dan level = 'endless' untuk mode Tathbiq (score = XP sesi itu).
-- nonce unik: mencegah satu kuis dikirim dua kali, dan menjadi target ON CONFLICT pada Tathbiq.
-- JANGAN dihapus: XP, rank, dan gold murid dihitung dari tabel ini.
create table if not exists attempts (
  id         bigserial primary key,
  user_id    integer     not null references users (id) on delete cascade,
  jilid      integer     not null check (jilid between 0 and 4),
  level      text        not null check (level in ('easy', 'medium', 'hard', 'endless')),
  total      integer     not null,
  correct    integer     not null,
  score      integer     not null,
  nonce      text        not null unique,
  created_at timestamptz not null default now()
);
-- INCLUDE: rekor terbaik per murid dibaca dari indeks saja (dipakai /me, Tathbiq, Toko, leaderboard, admin).
create index if not exists attempts_user_best_idx on attempts (user_id, jilid, level) include (correct, total, score);
-- Riwayat per murid dan "aktif terakhir" (panel admin: detail murid, daftar murid).
create index if not exists attempts_user_time_idx on attempts (user_id, created_at desc);
-- Statistik panel admin (murid aktif 7 hari terakhir).
create index if not exists attempts_created_idx on attempts (created_at);

-- ---------- 4. Sesi Mode Tathbiq ----------
-- asked = id soal yang sudah dikirim ke klien, BERURUTAN (server memetakan jawaban ke urutan ini).
-- JANGAN dihapus: tahap tertinggi Tathbiq murid dihitung dari max(n) tabel ini.
create table if not exists endless_runs (
  id         serial primary key,
  user_id    integer     not null references users (id) on delete cascade,
  asked      integer[]   not null default '{}',
  n          integer     not null default 1,      -- nomor soal berikutnya yang harus dijawab
  cur        integer,                             -- tidak dipakai lagi (selalu NULL); dibiarkan agar kompatibel
  lives      integer     not null default 3,
  score      integer     not null default 0,
  correct    integer     not null default 0,
  done       boolean     not null default false,
  created_at timestamptz not null default now()
);
create index if not exists endless_runs_user_idx on endless_runs (user_id) include (n);

-- ---------- 5. Toko: efek jawaban benar yang sudah dibeli ----------
-- price disimpan saat pembelian, jadi perubahan harga di kode tidak mengubah riwayat.
create table if not exists purchases (
  user_id    integer     not null references users (id) on delete cascade,
  item       text        not null,
  price      integer     not null check (price >= 0),
  created_at timestamptz not null default now(),
  primary key (user_id, item)
);

-- ---------- 6. Kuis harian + spin hadiah ----------
-- Satu baris per murid per hari (hari mengikuti WIB, Asia/Jakarta).
-- Baris dibuat saat kuis DIMULAI = kesempatan hari itu terpakai (tidak bisa diulang).
-- spun/prize = hasil spin hadiah (gold); prize dijumlahkan ke saldo gold.
create table if not exists daily (
  user_id    integer     not null references users (id) on delete cascade,
  day        date        not null,
  done       boolean     not null default false,
  correct    integer,
  score      integer     check (score between 0 and 100),
  spun       boolean     not null default false,
  prize      integer     check (prize >= 0),
  created_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- ---------- 7. Pembatas percobaan login ----------
-- key = kunci pembatas (mis. 'u:<username huruf kecil>'); n = jumlah gagal; reset_at = kapan hitungan direset.
create table if not exists login_attempts (
  key      text        primary key,
  n        integer     not null default 0,
  reset_at timestamptz not null
);

-- ---------- 8. Statistik untuk perencana query ----------
analyze users;
analyze questions;
analyze attempts;
analyze endless_runs;
analyze purchases;
analyze daily;
analyze login_attempts;

commit;

-- =====================================================================
--  LANGKAH MANUAL (jalankan sendiri, satu per satu, bila perlu)
-- =====================================================================

-- A) Menjadikan akun admin. Daftar dulu lewat aplikasi (jadi "student"), lalu:
--    update users set role = 'admin' where lower(username) = lower('NAMA_ADMIN');

-- B) Cek gold seorang murid (harus sama dengan angka di Beranda/Toko):
--    select
--      (select coalesce(sum(xp), 0) from (
--         select max(case when a.level = 'endless' then a.score::numeric
--           else round((case a.level when 'easy' then 100 when 'medium' then 200 else 300 end) * a.correct::numeric / a.total) end) xp
--         from attempts a join users u on u.id = a.user_id
--         where lower(u.username) = lower('NAMA_USER') group by a.jilid, a.level) b) as xp_rekor,
--      (select coalesce(sum(d.prize), 0) from daily d join users u on u.id = d.user_id
--         where lower(u.username) = lower('NAMA_USER') and d.spun) as hadiah_spin,
--      (select coalesce(sum(p.price), 0) from purchases p join users u on u.id = p.user_id
--         where lower(u.username) = lower('NAMA_USER')) as belanja;
--    gold = xp_rekor + hadiah_spin - belanja

-- C) Mengulang kuis harian untuk TES tanpa menghilangkan hadiah spin yang sudah didapat
--    (memindahkan baris hari ini ke tanggal lampau; JANGAN pakai delete, hadiahnya ikut hilang):
--    update daily set day = day - (30 + (random() * 3000)::int)
--    where user_id = (select id from users where lower(username) = lower('NAMA_USER'))
--      and day = (now() at time zone 'Asia/Jakarta')::date;

-- D) Perawatan berkala (opsional): catatan percobaan login yang sudah lewat masa kunci aman dihapus.
--    delete from login_attempts where reset_at < now() - interval '1 day';

-- E) Tabel lama yang tidak dipakai lagi (opsional). quiz_answers dulu dipakai saat tiap jawaban
--    dicek ke server; sekarang pengecekan dilakukan di perangkat murid. Jika masih ada di database
--    Anda dan ingin merapikan, hapus manual:
--    drop table if exists quiz_answers;

-- F) Cek hasil: daftar tabel dan kolom yang sekarang ada.
--    select table_name, column_name, data_type, is_nullable
--    from information_schema.columns
--    where table_schema = 'public'
--      and table_name in ('users','questions','attempts','endless_runs','purchases','daily','login_attempts')
--    order by table_name, ordinal_position;
