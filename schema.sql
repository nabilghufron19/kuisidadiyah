-- =====================================================================
--  Al-Miftah Kuis Nahwu — SKEMA DATABASE LENGKAP (Neon / PostgreSQL)
--  Versi: 3 Oktober 2026 (sudah memuat bab soal, laporan soal, gaya nama,
--  tampil di leaderboard untuk admin, dan fungsi gold_bonus)
--
--  * Disusun dari audit seluruh query di functions/api/[[path]].js:
--    setiap tabel, kolom, ON CONFLICT, dan foreign key yang dipakai kode ada di sini.
--  * Idempotent: aman dijalankan di database KOSONG maupun database yang
--    sudah berjalan. Yang sudah ada tidak diubah dan tidak dihapus; hanya yang
--    kurang yang ditambahkan. Data murid, soal, dan XP tidak tersentuh.
--  * Semua dalam satu transaksi: kalau ada yang gagal, tidak ada yang berubah.
--  * Skema ini DISUSUN DARI KODE, bukan dari dump database Anda. Kalau tabel
--    Anda sudah ada dengan tipe kolom berbeda, tipe itu dibiarkan.
--
--  Tabel yang dipakai aplikasi:
--    users, questions, attempts, endless_runs   -> inti kuis dan Tathbiq
--    purchases                                  -> Toko (efek dan gaya nama yang dibeli)
--    daily                                      -> Kuis Harian + spin hadiah
--    login_attempts                             -> pembatas percobaan login
--    question_reports                           -> laporan soal salah dari murid
--
--  Saldo gold TIDAK disimpan; selalu dihitung:
--    gold = XP rekor (attempts) + gold_bonus(user) - SUM(purchases.price)
--    gold_bonus(user) = jumlah hadiah spin harian (daily.prize yang sudah di-spin)
--
--  Cara pakai: Neon Console > SQL Editor > tempel seluruh isi file ini > Run.
--  Saran: kalau database sudah berisi data murid, uji dulu di Neon branch
--  (Branches > Create branch), baru jalankan di branch utama.
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
  fxn        text,                          -- gaya nama di leaderboard yang dipasang di Toko (kunci diawali n_): NULL = biasa
  on_board   boolean     not null default false,  -- khusus admin: true = akun admin ikut tampil di leaderboard
  created_at timestamptz not null default now()
);
alter table users add column if not exists fx       integer;
alter table users add column if not exists fxa      text;
alter table users add column if not exists fxn      text;
alter table users add column if not exists on_board boolean not null default false;

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
-- bab boleh kosong (NULL). Kuis memprioritaskan soal ber-bab dan mengambilnya bergiliran per bab;
-- kekurangannya diisi soal tanpa bab secara acak. Penulisan bab tidak peka huruf besar/kecil.
create table if not exists questions (
  id     serial primary key,
  jilid  integer not null check (jilid between 1 and 4),
  bab    text,                              -- batas panjang 1-60 dijaga oleh constraint questions_bab_len di bawah
  q      text    not null,
  a      text    not null,
  b      text    not null,
  c      text    not null,
  d      text    not null,
  answer text    not null check (answer in ('A', 'B', 'C', 'D'))
);
alter table questions add column if not exists bab text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'questions_bab_len') then
    alter table questions add constraint questions_bab_len check (bab is null or char_length(bab) between 1 and 60);
  end if;
end $$;
create index if not exists questions_jilid_idx     on questions (jilid);
create index if not exists questions_jilid_bab_idx on questions (jilid, lower(bab));

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
-- Rumus XP membagi dengan total; total 0 pada kuis biasa akan merusak perhitungan semua murid, jadi ditolak.
-- (Tathbiq memakai score, bukan total, sehingga dikecualikan.) NOT VALID: tidak memeriksa baris lama.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'attempts_total_pos') then
    alter table attempts add constraint attempts_total_pos check (level = 'endless' or total > 0) not valid;
  end if;
end $$;
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

-- ---------- 5. Toko: efek jawaban dan gaya nama yang sudah dibeli ----------
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
-- spun/prize = hasil spin hadiah (gold); prize dijumlahkan ke saldo gold lewat gold_bonus().
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

-- ---------- 8. Laporan soal salah dari murid ----------
-- kind: kunci = kunci jawaban salah, ketik = salah ketik/pilihan keliru, ambigu = soal ambigu, lain = lainnya.
-- status: open = belum diperiksa, done = sudah ditangani admin.
-- Satu murid hanya punya satu laporan TERBUKA per soal. Soal dihapus = laporannya ikut terhapus.
create table if not exists question_reports (
  id          bigserial   primary key,
  question_id integer     not null references questions (id) on delete cascade,
  user_id     integer     not null references users (id) on delete cascade,
  kind        text        not null check (kind in ('kunci', 'ketik', 'ambigu', 'lain')),
  note        text        check (note is null or char_length(note) <= 200),
  status      text        not null default 'open' check (status in ('open', 'done')),
  created_at  timestamptz not null default now()
);
create unique index if not exists question_reports_open_uq     on question_reports (question_id, user_id) where status = 'open';
create index        if not exists question_reports_status_idx   on question_reports (status, created_at desc);
create index        if not exists question_reports_user_idx     on question_reports (user_id, created_at desc);
create index        if not exists question_reports_question_idx on question_reports (question_id);

-- ---------- 9. Fungsi gold_bonus ----------
-- Dipakai /me, /shop, dan pembelian di Toko: total hadiah spin harian seorang murid (gold).
-- Dibuat HANYA bila belum ada. Kalau di database Anda fungsi ini sudah ada, isinya tidak diubah.
-- Mengembalikan integer (bukan bigint) supaya driver Neon memberi angka biasa ke JavaScript.
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'gold_bonus'
  ) then
    create function public.gold_bonus(p_user integer) returns integer
    language sql stable
    as $f$ select coalesce(sum(prize), 0)::integer from daily where user_id = p_user and spun $f$;
  end if;
end $$;

-- ---------- 10. Statistik untuk perencana query ----------
analyze users;
analyze questions;
analyze attempts;
analyze endless_runs;
analyze purchases;
analyze daily;
analyze login_attempts;
analyze question_reports;

commit;

-- =====================================================================
--  LANGKAH MANUAL (jalankan sendiri, satu per satu, bila perlu)
-- =====================================================================

-- A) Menjadikan akun admin. Daftar dulu lewat aplikasi (jadi "student"), lalu:
--    update users set role = 'admin' where lower(username) = lower('NAMA_ADMIN');
--    (Akun admin otomatis memiliki semua item Toko dan tidak tampil di leaderboard
--     kecuali dicentang di Profil.)

-- B) Cek gold seorang murid (harus sama dengan angka di Beranda/Toko):
--    select
--      (select coalesce(sum(xp), 0) from (
--         select max(case when a.level = 'endless' then a.score::numeric
--           else round((case a.level when 'easy' then 100 when 'medium' then 200 else 300 end) * a.correct::numeric / a.total) end) xp
--         from attempts a join users u on u.id = a.user_id
--         where lower(u.username) = lower('NAMA_USER') group by a.jilid, a.level) b) as xp_rekor,
--      (select gold_bonus(u.id) from users u where lower(u.username) = lower('NAMA_USER')) as hadiah_spin,
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
--    Laporan soal yang sudah ditangani juga boleh dirapikan:
--    delete from question_reports where status = 'done' and created_at < now() - interval '90 days';

-- E) Tabel lama yang tidak dipakai lagi (opsional). quiz_answers dulu dipakai saat tiap jawaban
--    dicek ke server; sekarang pengecekan dilakukan di perangkat murid. Jika masih ada di database
--    Anda dan ingin merapikan, hapus manual:
--    drop table if exists quiz_answers;

-- F) Melihat isi fungsi gold_bonus yang sedang dipakai (bila sudah ada sebelum skema ini dijalankan):
--    select pg_get_functiondef('public.gold_bonus(integer)'::regprocedure);

-- G) Cek hasil: daftar tabel dan kolom yang sekarang ada.
--    select table_name, column_name, data_type, is_nullable
--    from information_schema.columns
--    where table_schema = 'public'
--      and table_name in ('users','questions','attempts','endless_runs','purchases','daily','login_attempts','question_reports')
--    order by table_name, ordinal_position;
