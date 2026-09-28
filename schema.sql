-- Jalankan sekali di Neon SQL Editor
create table users (
  id serial primary key,
  username text not null,
  pass_hash text not null,
  salt text not null,
  role text not null default 'student',
  created_at timestamptz default now()
);
create unique index users_username_ci on users (lower(username));

create table questions (
  id serial primary key,
  jilid int not null check (jilid between 1 and 4),
  q text not null, a text not null, b text not null, c text not null, d text not null,
  answer text not null check (answer in ('A','B','C','D'))
);
create index on questions (jilid);

create table attempts (
  id serial primary key,
  user_id int not null references users(id) on delete cascade,
  jilid int not null,
  level text not null,
  total int not null,
  correct int not null,
  score int not null,
  nonce text not null unique,
  created_at timestamptz default now()
);
create index on attempts (user_id, jilid);

-- Jadikan akun admin (daftar dulu lewat web, lalu jalankan):
-- update users set role = 'admin' where lower(username) = lower('NAMA_ADMIN');
