-- =====================================================================
--  Al-Miftah Kuis Nahwu — SKEMA DATABASE LENGKAP (Neon / PostgreSQL)
--
--  * Idempotent: aman dijalankan di database KOSONG maupun database yang
--    sudah berjalan. Tabel/kolom/indeks yang sudah ada tidak diubah atau
--    dihapus, hanya yang kurang yang ditambahkan.
--  * Menggantikan migrasi-username.sql, migrasi-efek.sql, migrasi-performa.sql.
--  * Skema ini DISUSUN DARI KODE ([[path]].js), bukan dari dump database Anda.
--    Kalau tabel Anda sudah ada dengan tipe kolom berbeda, tipe itu dibiarkan.
--  * Semua dalam satu transaksi: kalau ada yang gagal, tidak ada yang berubah.
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
  fx         integer,                       -- pilihan efek bingkai: NULL = otomatis, 0 = tanpa efek, 1-11 = pilihan
  created_at timestamptz not null default now()
);
alter table users add column if not exists fx integer;

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
-- jilid = 0 dan level = 'endless' untuk mode Tathbiq.
-- nonce unik: mencegah satu kuis dikirim dua kali (dan dipakai ON CONFLICT pada Tathbiq).
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
-- INCLUDE: rekor terbaik per murid dibaca dari indeks saja (dipakai /me, Tathbiq, leaderboard, admin).
create index if not exists attempts_user_best_idx on attempts (user_id, jilid, level) include (correct, total, score);

-- ---------- 4. Jawaban per soal dalam satu sesi kuis (anti-curang) ----------
-- Tanpa foreign key ke questions, supaya admin bisa menghapus/mengganti soal kapan saja.
create table if not exists quiz_answers (
  nonce      text    not null,
  qid        integer not null,
  ok         boolean not null,
  created_at timestamptz not null default now(),
  primary key (nonce, qid)
);
alter table quiz_answers add column if not exists created_at timestamptz not null default now();

-- ---------- 5. Sesi Mode Tathbiq ----------
create table if not exists endless_runs (
  id         serial primary key,
  user_id    integer     not null references users (id) on delete cascade,
  asked      integer[]   not null default '{}',   -- id soal yang sudah keluar (tanpa ulang)
  n          integer     not null default 1,      -- nomor soal saat ini
  cur        integer,                             -- id soal saat ini (NULL bila sesi selesai)
  lives      integer     not null default 3,
  score      integer     not null default 0,
  correct    integer     not null default 0,
  done       boolean     not null default false,
  created_at timestamptz not null default now()
);
create index if not exists endless_runs_user_idx on endless_runs (user_id) include (n);

-- ---------- 6. Statistik untuk perencana query ----------
analyze users;
analyze questions;
analyze attempts;
analyze quiz_answers;
analyze endless_runs;

commit;

-- =====================================================================
--  LANGKAH MANUAL (jalankan sendiri, satu per satu, bila perlu)
-- =====================================================================

-- A) Menjadikan akun admin. Daftar dulu lewat aplikasi (jadi "student"), lalu:
--    update users set role = 'admin' where lower(username) = lower('NAMA_ADMIN');

-- B) Perawatan berkala (opsional): sesi kuis kedaluwarsa dalam 2 jam, jadi catatan
--    jawaban yang lebih tua dari sehari aman dihapus agar tabel tidak menumpuk.
--    delete from quiz_answers where created_at < now() - interval '1 day';

-- C) Cek hasil: daftar tabel dan kolom yang sekarang ada.
--    select table_name, column_name, data_type, is_nullable
--    from information_schema.columns
--    where table_schema = 'public'
--      and table_name in ('users','questions','attempts','quiz_answers','endless_runs')
--    order by table_name, ordinal_position;
