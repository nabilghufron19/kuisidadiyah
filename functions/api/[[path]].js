import { neon } from '@neondatabase/serverless';

const enc = new TextEncoder();
const b64 = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const bad = (m, s = 400) => J({ error: m }, s);
// Toko: harga efek jawaban benar (gold). 'confetti' bawaan dan gratis. Gold = XP rekor x GOLD_RATE, dikurangi total belanja.
const GOLD_RATE = 1;
// Gold tambahan di luar XP rekor dan hadiah spin. Dicatat di tabel gold_grants (satu baris per pemberian) dan ikut dihitung lewat gold_total_bonus().
const STARTER_GOLD = 500;                          // Gold awal untuk murid yang baru mendaftar
const RANK_MIN = [0, 300, 700, 1200, 1800, 3000];  // batas XP tiap rank (harus sama dengan RANKS di index.html dan admin/stats)
const RANK_PAY = [50, 100, 150, 200, 250, 300];    // Gold harian per rank: Bronze, Silver, Gold, Platinum, Diamond, Legend
const GRANTED = new Map();                         // uid -> hari (WIB) bonus rank sudah diperiksa; menghemat satu query per /me
const wibDay = () => new Date(Date.now() + 7 * 36e5).toISOString().slice(0, 10);
const SHOP = { stars: 100, bubbles: 200, petals: 300, tear: 250, coins: 450, fireworks: 600, bricks: 500, fire: 900, ice: 1100, glass: 1000, blast: 1300, lightning: 1500, comet: 2000, dust: 1800, galaxy: 2800, hole: 3200 };
// Toko: gaya nama di leaderboard (kunci diawali n_). Disimpan di purchases seperti efek jawaban; yang terpasang ada di users.fxn.
const NSHOP = { n_mint: 100, n_ocean: 150, n_grape: 300, n_sunset: 400, n_shimmer: 600, n_neon: 800, n_blaze: 1100, n_frost: 1300, n_glitch: 2000, n_rainbow: 2500 };
const PRICES = { ...SHOP, ...NSHOP };
// Kuis harian: 10 soal acak semua jilid; nilai >= DAILY_PASS memberi 1 spin. Hadiah = [gold, bobot]. Spin ke-PITY sejak hadiah >= RARE terakhir dijamin langka.
const DAILY_N = 10, DAILY_PASS = 80, RARE = 300, PITY = 10;
const PRIZES = [[100, 49], [150, 24], [200, 12], [300, 8], [500, 4], [750, 2], [1000, 1]]; // hadiah minimal 100 gold
const PASS_PCT = 60, XPMAX = { easy: 100, medium: 200, hard: 300 }; // PASS_PCT = persen benar agar sebuah quest dianggap selesai
const keyCache = new Map(); // CryptoKey cukup dibuat sekali per isolate, bukan tiap request
const hmacKey = s => keyCache.get(s) || (keyCache.set(s, crypto.subtle.importKey('raw', enc.encode(s), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])), keyCache.get(s));
const LB = new Map(), LB_TTL = 10000; // cache leaderboard per isolate (hasilnya sama untuk semua pengguna)
const REPORT_DAY = 30;                   // maksimal laporan soal per murid per hari
const REPORT_KINDS = ['kunci', 'ketik', 'ambigu', 'lain'];
const babOf = x => String(x ?? '').trim().replace(/\s+/g, ' ');
const PW_MAX = 128;                       // batas panjang password (mencegah PBKDF2 pada input raksasa)
const LOGIN_MAX = 8, LOGIN_MIN = 15;      // maksimal 8 kali gagal per username dalam 15 menit
const DUMMY_SALT = new Uint8Array(16);    // dipakai bila username tidak ada, supaya waktu respons sama
const safeEq = (a, b) => { // bandingkan string dengan waktu konstan
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

async function sign(obj, secret) {
  const p = b64(enc.encode(JSON.stringify(obj)));
  return p + '.' + b64(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(p)));
}
async function verify(tok, secret) {
  try {
    const [p, s] = tok.split('.');
    if (!(await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64(s), enc.encode(p)))) return null;
    const o = JSON.parse(new TextDecoder().decode(unb64(p)));
    return o.exp > Date.now() ? o : null;
  } catch { return null; }
}
async function hash(pw, salt) {
  const k = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, k, 256));
}

export async function onRequest({ request, env, params }) {
  const sql = neon(env.DATABASE_URL), S = env.JWT_SECRET, url = new URL(request.url);
  const route = request.method + ' ' + [].concat(params.path || []).join('/');
  const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
  const authToken = id => sign({ k: 'auth', uid: id, exp: Date.now() + 6048e5 }, S);
  // Pembatas percobaan login. locked() mengembalikan query (bisa dimasukkan ke sql.transaction).
  const locked = k => sql`select 1 from login_attempts where key = ${k} and reset_at > now() and n >= ${LOGIN_MAX}`;
  const failLogin = k => sql`insert into login_attempts (key, n, reset_at) values (${k}, 1, now() + make_interval(mins => ${LOGIN_MIN}::int))
    on conflict (key) do update set
      n = case when login_attempts.reset_at > now() then login_attempts.n + 1 else 1 end,
      reset_at = case when login_attempts.reset_at > now() then login_attempts.reset_at else now() + make_interval(mins => ${LOGIN_MIN}::int) end`;
  const tooMany = () => bad('Terlalu banyak percobaan gagal. Coba lagi dalam ' + LOGIN_MIN + ' menit.', 429);
  const bestOf = uid => sql`select jilid, level, max(case when level = 'endless' then score::numeric else round((case level when 'easy' then 100 when 'medium' then 200 else 300 end) * correct::numeric / total) end)::int xp
    from attempts where user_id = ${uid} group by jilid, level`;
  // [jilid1, jilid2, jilid3, jilid4] -> true bila ketiga level jilid itu selesai
  const jilidDone = rows => {
    const b = {}; for (const r of rows) b[r.jilid + ':' + r.level] = r.xp;
    return [1, 2, 3, 4].map(j => Object.entries(XPMAX).every(([l, x]) => (b[j + ':' + l] || 0) >= x * PASS_PCT / 100));
  };

  // Pemilihan soal: soal ber-bab diprioritaskan dan diambil bergiliran per (jilid, bab) supaya semua bab tercakup;
  // kekurangannya diisi soal tanpa bab secara acak. Urutan akhir diacak. j = 0 berarti semua jilid; excl = id yang dilewati.
  const pickQs = (j, n, excl = []) => sql`select id, q, a, b, c, d, answer from (
      select id, q, a, b, c, d, answer from (
        select id, q, a, b, c, d, answer, bab is null as nb,
          case when bab is null then 0 else row_number() over (partition by jilid, lower(bab) order by random()) end as rk
        from questions where (${j}::int = 0 or jilid = ${j}::int) and id <> all(${excl}::int[])) t
      order by nb, rk, random() limit ${n}) s order by random()`;

  try {
    // ---------- Daftar & masuk ----------
    if (route === 'POST register') {
      const un = String(body.username || ''), pw = String(body.password || '');
      if (!/^[A-Za-z0-9_]{3,20}$/.test(un)) return bad('Username 3–20 karakter: huruf, angka, atau _');
      if (pw.length < 6 || pw.length > PW_MAX) return bad('Password 6–' + PW_MAX + ' karakter');
      if ((await sql`select 1 from users where lower(username) = lower(${un}) limit 1`).length) return bad('Username sudah dipakai', 409);
      const salt = crypto.getRandomValues(new Uint8Array(16));
      try {
        const [u] = await sql`with u as (insert into users (username, pass_hash, salt) values (${un}, ${await hash(pw, salt)}, ${b64(salt)}) returning id),
          g as (insert into gold_grants (user_id, kind, day, amount) select id, 'starter', (now() at time zone 'Asia/Jakarta')::date, ${STARTER_GOLD}::int from u)
        select id from u`;
        return J({ token: await authToken(u.id) });
      } catch (e) {
        if (e.code === '23505') return bad('Username sudah dipakai', 409);
        throw e;
      }
    }
    if (route === 'POST login') {
      const un = String(body.username || ''), pw = String(body.password || '');
      const lk = 'u:' + un.toLowerCase().slice(0, 40);
      const [[lock], [u]] = await sql.transaction([locked(lk), sql`select id, pass_hash, salt from users where lower(username) = lower(${un})`]);
      if (lock) return tooMany();
      // selalu hitung hash (walau username tidak ada) agar waktu respons tidak membocorkan username yang terdaftar
      const h = pw.length <= PW_MAX ? await hash(pw, u ? unb64(u.salt) : DUMMY_SALT) : '';
      if (!u || !h || !safeEq(h, u.pass_hash)) { await failLogin(lk); return bad('Username atau password salah', 401); }
      await sql`delete from login_attempts where key = ${lk}`;
      return J({ token: await authToken(u.id) });
    }

    // ---------- Wajib masuk ----------
    // Token bertanda tangan sudah cukup untuk tahu siapa pemanggilnya (uid). Data user dari DB
    // (getUser) hanya diambil di rute yang memerlukannya: profil dan admin.
    const claim = await verify((request.headers.get('Authorization') || '').slice(7), S);
    const uid = claim && claim.k === 'auth' ? +claim.uid : 0;
    if (!uid) return bad('Silakan masuk dulu', 401);
    let cachedUser;
    const getUser = async () => cachedUser ||= (await sql`select id, username, role, avatar, fx, on_board from users where id = ${uid}`)[0] || null;

    if (route === 'GET me') {
      // Bonus Gold harian sesuai rank: sekali sehari (WIB), otomatis saat murid membuka aplikasi. Gagal di sini tidak boleh menggagalkan /me.
      let got = 0;
      try {
        if (GRANTED.get(uid) !== wibDay()) {
          const gr = await sql`with best as (
              select max(case when level = 'endless' then score::numeric else round((case level when 'easy' then 100 when 'medium' then 200 else 300 end) * correct::numeric / total) end) xp
              from attempts where user_id = ${uid}::int group by jilid, level),
            tot as (select coalesce(sum(xp), 0) t from best),
            rk as (select greatest((select count(*) from unnest(${RANK_MIN}::int[]) as m(v) where m.v <= tot.t), 1)::int i from tot)
            insert into gold_grants (user_id, kind, day, amount)
            select ${uid}::int, 'rank', (now() at time zone 'Asia/Jakarta')::date, (${RANK_PAY}::int[])[rk.i] from rk
            where not exists (select 1 from gold_grants where user_id = ${uid}::int and kind = 'rank' and day = (now() at time zone 'Asia/Jakarta')::date)
              and exists (select 1 from users where id = ${uid}::int and role <> 'admin')
            on conflict do nothing returning amount`;
          got = gr.length ? gr[0].amount : 0;
          if (GRANTED.size > 5000) GRANTED.clear();
          GRANTED.set(uid, wibDay());
        }
      } catch (e) { got = 0; }
      // satu round trip untuk tiga query
      const [[usr], best, [t], [sp], [bn], [rq]] = await sql.transaction([
        sql`select username, role, avatar, fx, fxa, fxn, on_board from users where id = ${uid}`,
        bestOf(uid),
        sql`select least(ceil(coalesce(max(n), 0) / 10.0), 7)::int as s from endless_runs where user_id = ${uid}`,
        sql`select coalesce(sum(price), 0)::int s from purchases where user_id = ${uid}`,
        sql`select gold_total_bonus(${uid}::int) s`,
        sql`select case when (select role from users where id = ${uid}) = 'admin' then (select count(distinct question_id) from question_reports where status = 'open') else 0 end::int n`]);
      if (!usr) return bad('Silakan masuk dulu', 401);
      const ach = jilidDone(best);
      const xpTot = best.reduce((a, r) => a + r.xp, 0), ri = Math.max(0, RANK_MIN.filter(m => m <= xpTot).length - 1);
      return J({ rankGot: got, rankPay: usr.role === 'admin' ? 0 : RANK_PAY[ri], pays: RANK_PAY, starter: STARTER_GOLD, reports: rq.n, username: usr.username, role: usr.role, avatar: usr.avatar, fxp: usr.fx, fxa: usr.fxa, fxn: usr.fxn, board: usr.on_board, spent: sp.s, bonus: bn.s, rate: GOLD_RATE, tstage: t.s, pass: PASS_PCT, ach, tathbiq: usr.role === 'admin' || ach.every(Boolean), best: Object.fromEntries(best.map(r => [r.jilid + ':' + r.level, r.xp])) });
    }

    if (route === 'GET quiz') {
      const j = +url.searchParams.get('jilid'), l = url.searchParams.get('level');
      const n = { easy: 10, medium: 20, hard: 30 }[l];
      if (!(j >= 1 && j <= 4) || !n) return bad('Pilihan tidak valid');
      // Soal + kunci dikirim sekaligus: klien memeriksa jawaban sendiri (tanpa request per soal). Nilai tetap dihitung ulang di server saat submit.
      const qs = await pickQs(j, n);
      if (!qs.length) return bad('Belum ada soal untuk jilid ini');
      const token = await sign({ k: 'quiz', uid, j, l, ids: qs.map(x => x.id), nonce: crypto.randomUUID(), t0: Date.now(), exp: Date.now() + 72e5 }, S);
      return J({ questions: qs, token });
    }

    if (route === 'POST submit') {
      const t = await verify(String(body.token || ''), S);
      if (!t || t.k !== 'quiz' || t.uid !== uid) return bad('Sesi kuis tidak valid atau kedaluwarsa');
      const total = t.ids.length, XP = { easy: 100, medium: 200, hard: 300 };
      if (Date.now() - (t.t0 || 0) < total * 1000) return bad('Terlalu cepat. Baca soal dengan teliti, lalu kirim lagi.', 429); // batas wajar anti-curang
      const an = body.answers && typeof body.answers === 'object' ? body.answers : {};
      const ids = t.ids.filter(id => /^[ABCD]$/.test(an[id])), ls = ids.map(id => an[id]);
      let row;
      try {
        // jawaban klien dicocokkan dengan kunci di database, lalu percobaan disimpan
        [row] = await sql`with c as (select count(*)::int n from unnest(${ids}::int[], ${ls}::text[]) as a(id, l) join questions q on q.id = a.id and q.answer = a.l)
          insert into attempts (user_id, jilid, level, total, correct, score, nonce)
          select ${uid}::int, ${t.j}::int, ${t.l}::text, ${total}::int, c.n, round(c.n * 100.0 / ${total}::int)::int, ${t.nonce}::text from c
          returning correct, score`;
      } catch (e) {
        if (e.code === '23505') return bad('Kuis ini sudah pernah dikirim', 409);
        throw e;
      }
      LB.clear();
      return J({ correct: row.correct, total, score: row.score, xp: Math.round(XP[t.l] * row.correct / total) });
    }

    if (route === 'POST endless/start') {
      const [[usr], best] = await sql.transaction([sql`select role from users where id = ${uid}`, bestOf(uid)]);
      if (!usr) return bad('Silakan masuk dulu', 401);
      if (usr.role !== 'admin' && !jilidDone(best).every(Boolean)) return bad('Mode Tathbiq terbuka setelah semua quest Jilid 1–4 selesai', 403);
      // Tathbiq dimuat per paket 30 soal (lengkap dengan kunci). Urutan asked = urutan soal yang dikirim ke klien.
      const qs = await pickQs(0, 30);
      if (!qs.length) return bad('Belum ada soal');
      const [, [r]] = await sql.transaction([
        sql`update endless_runs set done = true, cur = null where user_id = ${uid} and not done`,
        sql`insert into endless_runs (user_id, asked, n) values (${uid}, ${qs.map(x => x.id)}::int[], 1) returning id`]);
      return J({ run: r.id, questions: qs });
    }

    if (route === 'POST endless/more') {
      const [r] = await sql`select id, asked, done from endless_runs where id = ${+body.run || 0} and user_id = ${uid}`;
      if (!r || r.done) return bad('Sesi endless sudah berakhir', 409);
      const qs = await pickQs(0, 30, r.asked);
      if (qs.length) await sql`update endless_runs set asked = asked || ${qs.map(x => x.id)}::int[] where id = ${r.id} and not done`;
      return J({ questions: qs });
    }

    if (route === 'POST endless/sync') {
      // Klien mengirim urutan huruf jawaban sejak titik "from"; server memutar ulang nyawa, skor, dan tahap terhadap kunci di database.
      let ch = Array.isArray(body.choices) ? body.choices.slice(0, 300) : [];
      if (!ch.every(c => /^[ABCD]$/.test(c))) return bad('Jawaban tidak valid');
      const [r] = await sql`select id, lives, score, correct, n, asked, done from endless_runs where id = ${+body.run || 0} and user_id = ${uid}`;
      if (!r || r.done) return bad('Sesi endless sudah berakhir', 409);
      const off = r.n - 1 - (+body.from || 0); // kiriman ulang: buang jawaban yang sudah diproses
      if (off < 0 || off > ch.length) return bad('Jawaban tidak valid');
      ch = ch.slice(off);
      const ids = r.asked.slice(r.n - 1, r.n - 1 + ch.length);
      if (ids.length < ch.length) return bad('Jawaban tidak valid');
      const key = Object.fromEntries((await sql`select id, answer from questions where id = any(${ids}::int[])`).map(k => [k.id, k.answer]));
      let { lives, score, correct, n } = r, over = false;
      for (let i = 0; i < ch.length; i++) {
        if (key[ids[i]]) { // soal yang dihapus admin dilewati
          if (key[ids[i]] === ch[i]) { score += 10 * Math.ceil(n / 10); correct++; }
          else if (--lives <= 0) { over = true; break; }
        }
        n++;
      }
      const done = over || body.end === true;
      const qs = [sql`update endless_runs set lives = ${lives}, score = ${score}, correct = ${correct}, n = ${n}, done = ${done}, cur = null
        where id = ${r.id} and n = ${r.n} and not done returning id`];
      if (n > 1) qs.push(sql`insert into attempts (user_id, jilid, level, total, correct, score, nonce)
        select user_id, 0, 'endless', case when lives <= 0 then n else n - 1 end, correct, score, 'endless-' || id
        from endless_runs where id = ${r.id}
        on conflict (nonce) do update set total = excluded.total, correct = excluded.correct, score = excluded.score`);
      const [upd] = await sql.transaction(qs);
      if (!upd.length) return bad('Jawaban ini sudah dikirim', 409);
      LB.clear();
      return J({ lives, score, correct, over: done });
    }

    if (route === 'POST password') {
      const oldPw = String(body.old || ''), np = String(body.password || '');
      if (np.length < 6 || np.length > PW_MAX) return bad('Password baru 6–' + PW_MAX + ' karakter');
      const [usr] = await sql`select username, pass_hash, salt from users where id = ${uid}`;
      if (!usr) return bad('Silakan masuk dulu', 401);
      const lk = 'u:' + usr.username.toLowerCase();
      const [lock] = await locked(lk);
      if (lock) return tooMany();
      // 403 (bukan 401) supaya klien tidak mengira token habis lalu mengeluarkan pengguna
      if (oldPw.length > PW_MAX || !safeEq(await hash(oldPw, unb64(usr.salt)), usr.pass_hash)) { await failLogin(lk); return bad('Password lama salah', 403); }
      const salt = crypto.getRandomValues(new Uint8Array(16));
      await sql.transaction([
        sql`update users set pass_hash = ${await hash(np, salt)}, salt = ${b64(salt)} where id = ${uid}`,
        sql`delete from login_attempts where key = ${lk}`]);
      return J({ ok: true });
    }

    if (route === 'POST endless/stop') {
      // tombol "Berhenti": tutup sesi agar tidak menggantung. Skor sudah tersimpan di attempts sejak jawaban terakhir.
      await sql`update endless_runs set done = true, cur = null where id = ${+body.run || 0} and user_id = ${uid} and not done`;
      return J({ ok: true });
    }

    if (route === 'POST profile') {
      const u = await getUser();
      if (!u) return bad('Silakan masuk dulu', 401);
      const un = String(body.username ?? u.username).trim(), av = String(body.avatar ?? u.avatar);
      if (!/^[A-Za-z0-9_]{3,20}$/.test(un)) return bad('Username 3–20 karakter: huruf, angka, atau _');
      if (!/^a([1-9]|1[0-2])$/.test(av)) return bad('Foto tidak valid');
      let fx = u.fx;
      if (body.fx === null) fx = null;
      else if (body.fx !== undefined) {
        const n = +body.fx;
        if (!Number.isInteger(n) || n < 0 || n > 11) return bad('Efek tidak valid');
        fx = n;
      }
      // hanya admin yang boleh memilih tampil/tidak di leaderboard; murid selalu tampil
      const ob = u.role === 'admin' && typeof body.board === 'boolean' ? body.board : u.on_board;
      const needFx = fx > 0 && u.role !== 'admin' && fx !== u.fx; // admin bebas; efek yang sudah dipakai tak perlu dicek ulang
      const qs = [sql`select 1 from users where lower(username) = lower(${un}) and id <> ${u.id} limit 1`];
      if (needFx) qs.push(bestOf(u.id), sql`select least(ceil(coalesce(max(n), 0) / 10.0), 7)::int as s from endless_runs where user_id = ${u.id}`);
      const [dup, best, st] = await sql.transaction(qs);
      if (dup.length) return bad('Username sudah dipakai', 409);
      if (needFx && fx > jilidDone(best).filter(Boolean).length + st[0].s) return bad('Efek ini belum terbuka', 403);
      try { await sql`update users set username = ${un}, avatar = ${av}, fx = ${fx}, on_board = ${ob} where id = ${u.id}`; }
      catch (e) { if (e.code === '23505') return bad('Username sudah dipakai', 409); throw e; }
      LB.clear();
      return J({ username: un, avatar: av, fx, board: ob });
    }

    // ---------- Laporan soal salah (murid -> admin) ----------
    if (route === 'POST report') {
      const qid = +body.question, kind = String(body.kind || ''), note = String(body.note || '').trim().slice(0, 200);
      if (!Number.isInteger(qid) || qid < 1) return bad('Soal tidak valid');
      if (!REPORT_KINDS.includes(kind)) return bad('Pilih jenis masalahnya');
      if (kind === 'lain' && !note) return bad('Tulis singkat masalahnya');
      const [[ex], [cnt]] = await sql.transaction([
        sql`select 1 from questions where id = ${qid}`,
        sql`select count(*)::int n from question_reports where user_id = ${uid} and created_at > now() - interval '1 day'`]);
      if (!ex) return bad('Soal ini sudah tidak ada', 404);
      if (cnt.n >= REPORT_DAY) return bad('Batas laporan hari ini sudah tercapai. Terima kasih!', 429);
      const ins = await sql`insert into question_reports (question_id, user_id, kind, note) values (${qid}, ${uid}, ${kind}, ${note || null})
        on conflict (question_id, user_id) where status = 'open' do nothing returning id`;
      if (!ins.length) return bad('Kamu sudah melaporkan soal ini. Admin akan memeriksanya.', 409);
      return J({ ok: true });
    }

    // ---------- Toko ----------
    const shopState = async () => {
      const [best, own, [u], [bn]] = await sql.transaction([bestOf(uid), sql`select item, price from purchases where user_id = ${uid}`, sql`select fxa, fxn, role from users where id = ${uid}`, sql`select gold_total_bonus(${uid}::int) s`]);
      const earned = best.reduce((a, r) => a + r.xp, 0) * GOLD_RATE, spent = own.reduce((a, r) => a + r.price, 0), admin = !!u && u.role === 'admin';
      return { gold: earned + bn.s - spent, earned, bonus: bn.s, spent, admin, owned: admin ? Object.keys(PRICES) : own.map(r => r.item), equipped: u ? u.fxa : null, equippedName: u ? u.fxn : null, prices: PRICES };
    };
    if (route === 'GET shop') return J(await shopState());
    if (route === 'POST shop/buy') {
      const item = String(body.item || '');
      if (!Object.hasOwn(PRICES, item)) return bad('Item tidak ditemukan', 404);
      const price = PRICES[item];
      // kunci per pengguna: dua pembelian bersamaan tidak bisa melewati saldo
      const [, ins] = await sql.transaction([
        sql`select pg_advisory_xact_lock(${uid}::int)`,
        sql`with best as (select max(case when level = 'endless' then score::numeric else round((case level when 'easy' then 100 when 'medium' then 200 else 300 end) * correct::numeric / total) end) xp from attempts where user_id = ${uid} group by jilid, level),
            bal as (select coalesce((select sum(xp) from best), 0) * ${GOLD_RATE}::numeric + coalesce(gold_total_bonus(${uid}::int), 0) - coalesce((select sum(price) from purchases where user_id = ${uid}), 0) g)
          insert into purchases (user_id, item, price) select ${uid}::int, ${item}::text, ${price}::int from bal where g >= ${price}::int on conflict do nothing returning item`]);
      if (!ins.length) {
        const [own] = await sql`select 1 from purchases where user_id = ${uid} and item = ${item}`;
        return own ? bad('Item ini sudah kamu miliki', 409) : bad('Gold belum cukup', 402);
      }
      return J(await shopState());
    }
    if (route === 'POST shop/equip') {
      const item = String(body.item || 'confetti');
      if (item === 'n_none') { // lepas gaya nama
        await sql`update users set fxn = null where id = ${uid}`; LB.clear();
        return J(await shopState());
      }
      if (item !== 'confetti' && !Object.hasOwn(PRICES, item)) return bad('Item tidak ditemukan', 404);
      const st = await shopState();
      if (item !== 'confetti' && !st.owned.includes(item)) return bad('Beli dulu item ini', 403);
      if (item.startsWith('n_')) { // gaya nama -> users.fxn
        await sql`update users set fxn = ${item} where id = ${uid}`; LB.clear();
        return J({ ...st, equippedName: item });
      }
      const fx = item === 'confetti' ? null : item; // efek jawaban benar -> users.fxa
      await sql`update users set fxa = ${fx} where id = ${uid}`;
      return J({ ...st, equipped: fx });
    }

    // ---------- Kuis harian (hari mengikuti WIB) ----------
    const dailyPity = () => sql`select count(*)::int n from daily where user_id = ${uid} and spun and day > coalesce((select max(day) from daily where user_id = ${uid} and prize >= ${RARE}), date '1970-01-01')`;
    if (route === 'GET daily') {
      const [[t], [p], [y]] = await sql.transaction([
        sql`select done, correct, score, spun, prize from daily where user_id = ${uid} and day = (now() at time zone 'Asia/Jakarta')::date`,
        sql`select count(*)::int n from daily where user_id = ${uid} and done and score >= ${DAILY_PASS} and not spun`,
        dailyPity()]);
      return J({ today: t || null, pending: p.n, pity: y.n, need: PITY, rare: RARE, prizes: PRIZES });
    }
    if (route === 'POST daily/start') {
      const qs = await pickQs(0, DAILY_N);
      if (qs.length < DAILY_N) return bad('Soal belum cukup untuk kuis harian (minimal ' + DAILY_N + ' soal)');
      // baris dibuat saat mulai: satu kesempatan per hari, tidak bisa diulang walau halaman ditutup
      const [r] = await sql`insert into daily (user_id, day) values (${uid}, (now() at time zone 'Asia/Jakarta')::date) on conflict do nothing returning day::text as d`;
      if (!r) return bad('Kuis harian hari ini sudah kamu ambil. Kembali lagi besok!', 409);
      const token = await sign({ k: 'daily', uid, day: r.d, ids: qs.map(x => x.id), t0: Date.now(), exp: Date.now() + 36e5 }, S);
      return J({ questions: qs, token });
    }
    if (route === 'POST daily/submit') {
      const t = await verify(String(body.token || ''), S);
      if (!t || t.k !== 'daily' || t.uid !== uid) return bad('Sesi kuis harian tidak valid atau kedaluwarsa');
      const total = t.ids.length;
      if (Date.now() - t.t0 < total * 1000) return bad('Terlalu cepat. Baca soal dengan teliti.', 429);
      const an = body.answers && typeof body.answers === 'object' ? body.answers : {};
      const ids = t.ids.filter(id => /^[ABCD]$/.test(an[id])), ls = ids.map(id => an[id]);
      const [row] = await sql`with c as (select count(*)::int n from unnest(${ids}::int[], ${ls}::text[]) as a(id, l) join questions q on q.id = a.id and q.answer = a.l)
        update daily set done = true, correct = c.n, score = round(c.n * 100.0 / ${total}::int)::int from c
        where user_id = ${uid} and day = ${t.day}::date and not done returning correct, score`;
      if (!row) return bad('Kuis harian ini sudah diselesaikan', 409);
      return J({ correct: row.correct, total, score: row.score, pass: row.score >= DAILY_PASS });
    }
    if (route === 'POST daily/spin') {
      const [[row], [y]] = await sql.transaction([
        sql`select day::text d from daily where user_id = ${uid} and done and score >= ${DAILY_PASS} and not spun order by day desc limit 1`,
        dailyPity()]);
      if (!row) return bad('Kamu belum punya kesempatan spin', 409);
      const pool = y.n + 1 >= PITY ? PRIZES.filter(p => p[0] >= RARE) : PRIZES;
      let x = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 * pool.reduce((a, p) => a + p[1], 0), prize = pool[pool.length - 1][0];
      for (const [g, w] of pool) { if ((x -= w) < 0) { prize = g; break; } }
      const [u] = await sql`update daily set spun = true, prize = ${prize} where user_id = ${uid} and day = ${row.d}::date and done and score >= ${DAILY_PASS} and not spun returning prize`;
      if (!u) return bad('Spin sudah dipakai', 409);
      return J({ prize, rare: prize >= RARE, pity: prize >= RARE ? 0 : y.n + 1 });
    }

    if (route === 'GET leaderboard') {
      const j = +url.searchParams.get('jilid') || 0;
      const q = (url.searchParams.get('q') || '').trim().slice(0, 30);
      const ck = j + '|' + q.toLowerCase(), hit = LB.get(ck);
      if (hit && hit.t > Date.now()) return J(hit.v);
      const rows = await sql`
        with best as (
          select user_id, jilid, level,
                 max(case when level = 'endless' then score::numeric else round((case level when 'easy' then 100 when 'medium' then 200 else 300 end) * correct::numeric / total) end)::int xp
          from attempts where case when ${j}::int = 0 then true when ${j}::int = 5 then level = 'endless' else jilid = ${j}::int end group by 1, 2, 3),
        ranked as (
          select rank() over (order by sum(xp) desc)::int as rank, u.id, u.username, u.avatar, u.role, u.fx as pick, u.fxn as nm,
                 sum(xp)::int as total, (count(distinct jilid) filter (where jilid > 0))::int as jilids
          from best join users u on u.id = best.user_id where u.role <> 'admin' or u.on_board group by u.id, u.username, u.avatar, u.role, u.fx, u.fxn)
        select * from ranked
        where ${q}::text = '' or strpos(lower(username), lower(${q}::text)) > 0
        order by rank, username limit 100`;
      // level efek foto = jumlah jilid khatam + tahap Tathbiq (sama seperti di /me)
      const ids = rows.map(r => r.id), by = {}, st = {};
      if (ids.length) {
        const [bs, ts] = await Promise.all([
          sql`select user_id, jilid, level, max(round((case level when 'easy' then 100 when 'medium' then 200 else 300 end) * correct::numeric / total))::int xp
            from attempts where user_id = any(${ids}::int[]) and jilid between 1 and 4 group by 1, 2, 3`,
          sql`select user_id, least(ceil(coalesce(max(n), 0) / 10.0), 7)::int s from endless_runs where user_id = any(${ids}::int[]) group by user_id`]);
        for (const r of bs) (by[r.user_id] ||= []).push(r);
        for (const r of ts) st[r.user_id] = r.s;
      }
      for (const r of rows) { const mx = r.role === 'admin' ? 11 : jilidDone(by[r.id] || []).filter(Boolean).length + (st[r.id] || 0); r.fx = r.pick == null ? mx : Math.min(r.pick, mx); delete r.id; delete r.role; delete r.pick; }
      const out = { rows };
      if (LB.size > 60) LB.clear();
      LB.set(ck, { t: Date.now() + LB_TTL, v: out });
      return J(out);
    }

    // ---------- Profil pemain (dibuka dari leaderboard) ----------
    // Hanya data publik: XP, pencapaian, efek foto, dan koleksi item. Gold, riwayat percobaan, dan data akun TIDAK dikirim.
    if (route === 'GET player') {
      const un = (url.searchParams.get('u') || '').trim().slice(0, 30);
      const [t] = un ? await sql`select id, username, role, avatar, fx, fxa, fxn, on_board, created_at from users where lower(username) = lower(${un})` : [];
      if (!t || (t.role === 'admin' && !t.on_board)) return bad('Pemain tidak ditemukan', 404);
      const [best, [en], own] = await sql.transaction([
        bestOf(t.id),
        sql`select least(ceil(coalesce(max(n), 0) / 10.0), 7)::int s from endless_runs where user_id = ${t.id}`,
        sql`select item from purchases where user_id = ${t.id}`]);
      const admin = t.role === 'admin', ach = admin ? [true, true, true, true] : jilidDone(best);
      const mx = admin ? 11 : ach.filter(Boolean).length + en.s;
      return J({
        username: t.username, admin, avatar: t.avatar, since: t.created_at,
        fx: t.fx == null ? mx : Math.min(t.fx, mx),
        total: best.reduce((a, r) => a + r.xp, 0), best: Object.fromEntries(best.map(r => [r.jilid + ':' + r.level, r.xp])),
        ach, tstage: admin ? 7 : en.s, owned: admin ? Object.keys(PRICES) : own.map(r => r.item), equipped: t.fxa, nm: t.fxn
      });
    }

    // ---------- Khusus admin ----------
    const u = await getUser();
    if (!u) return bad('Silakan masuk dulu', 401);
    if (u.role !== 'admin') return bad('Khusus admin', 403);

    if (route === 'GET admin/stats') {
      // statistik hanya menghitung murid (bukan admin). Batas rank harus sama dengan RANKS di index.html: 300/700/1200/1800/3000 (Legend).
      const [q, [c], bj, [rk], [rp], bb] = await sql.transaction([
        sql`select jilid, count(*)::int n from questions group by jilid`,
        sql`select (select count(*) from users where role = 'student')::int users,
          (select count(*) from users where role = 'student' and created_at > now() - interval '7 days')::int new7,
          (select count(*) from attempts a join users u on u.id = a.user_id and u.role = 'student')::int attempts,
          (select count(distinct a.user_id) from attempts a join users u on u.id = a.user_id and u.role = 'student' where a.created_at > now() - interval '7 days')::int active7`,
        sql`select a.jilid, count(*)::int attempts, count(distinct a.user_id)::int students, coalesce(round(avg(a.score)), 0)::int avg
          from attempts a join users u on u.id = a.user_id and u.role = 'student' where a.jilid between 1 and 4 group by a.jilid`,
        sql`with best as (select user_id, max(case when level = 'endless' then score::numeric else round((case level when 'easy' then 100 when 'medium' then 200 else 300 end) * correct::numeric / total) end) xp from attempts group by user_id, jilid, level),
          tot as (select u.id, coalesce(sum(b.xp), 0)::int t from users u left join best b on b.user_id = u.id where u.role = 'student' group by u.id)
          select count(*) filter (where t < 300)::int r0, count(*) filter (where t >= 300 and t < 700)::int r1, count(*) filter (where t >= 700 and t < 1200)::int r2,
            count(*) filter (where t >= 1200 and t < 1800)::int r3, count(*) filter (where t >= 1800 and t < 3000)::int r4, count(*) filter (where t >= 3000)::int r5 from tot`,
        sql`select count(distinct question_id)::int n from question_reports where status = 'open'`,
        sql`select jilid, min(bab) bab, count(*)::int n from questions where bab is not null group by jilid, lower(bab) order by jilid, min(bab)`]);
      const babs = {}; for (const r of bb) (babs[r.jilid] ||= []).push({ bab: r.bab, n: r.n });
      return J({ q: Object.fromEntries(q.map(r => [r.jilid, r.n])), ...c, byJilid: Object.fromEntries(bj.map(r => [r.jilid, r])), ranks: [rk.r0, rk.r1, rk.r2, rk.r3, rk.r4, rk.r5], reports: rp.n, babs });
    }

    if (route === 'POST admin/questions') {
      const rows = body.rows;
      if (!Array.isArray(rows) || !rows.length || rows.length > 2000) return bad('Data soal kosong atau lebih dari 2000 baris');
      for (const [i, r] of rows.entries()) {
        const ok = [1, 2, 3, 4].includes(r.jilid) && [r.q, r.a, r.b, r.c, r.d].every(x => typeof x === 'string' && x) &&
          typeof r.answer === 'string' && /^[ABCD]$/.test(r.answer) && babOf(r.bab).length <= 60;
        if (!ok) return bad(`Baris ${i + 2} tidak valid (jilid 1–4, soal dan pilihan terisi, jawaban A–D, bab maksimal 60 karakter)`);
      }
      const ins = sql`insert into questions (jilid, bab, q, a, b, c, d, answer)
        select * from unnest(${rows.map(r => r.jilid)}::int[], ${rows.map(r => babOf(r.bab) || null)}::text[], ${rows.map(r => r.q)}::text[], ${rows.map(r => r.a)}::text[],
          ${rows.map(r => r.b)}::text[], ${rows.map(r => r.c)}::text[], ${rows.map(r => r.d)}::text[], ${rows.map(r => r.answer)}::text[])`;
      if (body.replace) await sql.transaction([sql`delete from questions where jilid = any(${[...new Set(rows.map(r => r.jilid))]})`, ins]);
      else await ins;
      return J({ added: rows.length });
    }

    if (route === 'GET admin/questions') {
      const j = +url.searchParams.get('jilid') || 0, q = (url.searchParams.get('q') || '').trim().slice(0, 60);
      const off = Math.max(0, +url.searchParams.get('offset') || 0), like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
      const rows = await sql`select id, jilid, bab, q, a, b, c, d, answer from questions
        where (${j}::int = 0 or jilid = ${j}::int) and (${q}::text = '' or q ilike ${like} or bab ilike ${like})
        order by jilid, id limit 30 offset ${off}`;
      const [{ n }] = await sql`select count(*)::int n from questions where (${j}::int = 0 or jilid = ${j}::int) and (${q}::text = '' or q ilike ${like} or bab ilike ${like})`;
      return J({ rows, total: n });
    }

    // Unduh seluruh bank soal (format kolom sama dengan template unggah, jadi bisa dipakai sebagai backup/restore).
    if (route === 'GET admin/questions-export') {
      const rows = await sql`select jilid, bab, q, a, b, c, d, answer from questions order by jilid, id`;
      return J({ rows });
    }

    // Hapus SELURUH bank soal. Wajib kirim confirm: 'HAPUS' supaya tidak terpicu tanpa sengaja.
    // Data murid (attempts, XP, gold, daily, purchases) tidak disentuh; sesi yang sedang berjalan melewati soal yang sudah hilang.
    if (route === 'POST admin/questions-clear') {
      if (body.confirm !== 'HAPUS') return bad('Konfirmasi tidak valid');
      let n;
      try { [{ n }] = await sql`with d as (delete from questions returning 1) select count(*)::int n from d`; }
      catch (e) { if (e.code === '23503') return bad('Soal masih terhubung ke data lain', 409); throw e; }
      return J({ deleted: n });
    }

    if (route === 'POST admin/question-save') {
      const id = +body.id || 0, j = +body.jilid, f = ['q', 'a', 'b', 'c', 'd'].map(k => String(body[k] ?? '').trim()), ans = String(body.answer || '').toUpperCase();
      const bab = babOf(body.bab);
      if (![1, 2, 3, 4].includes(j) || f.some(x => !x) || !/^[ABCD]$/.test(ans)) return bad('Jilid 1–4, semua kolom terisi, jawaban A–D');
      if (bab.length > 60) return bad('Bab maksimal 60 karakter');
      if (id) {
        const r = await sql`update questions set jilid = ${j}, bab = ${bab || null}, q = ${f[0]}, a = ${f[1]}, b = ${f[2]}, c = ${f[3]}, d = ${f[4]}, answer = ${ans} where id = ${id} returning id`;
        if (!r.length) return bad('Soal tidak ditemukan', 404);
      } else await sql`insert into questions (jilid, bab, q, a, b, c, d, answer) values (${j}, ${bab || null}, ${f[0]}, ${f[1]}, ${f[2]}, ${f[3]}, ${f[4]}, ${ans})`;
      return J({ ok: true });
    }

    if (route === 'POST admin/question-delete') {
      const ids = [].concat(body.ids ?? body.id ?? []).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 500);
      if (!ids.length) return bad('Tidak ada soal dipilih');
      try { await sql`delete from questions where id = any(${ids}::int[])`; }
      catch (e) { if (e.code === '23503') return bad('Soal masih terhubung ke data lain', 409); throw e; }
      return J({ deleted: ids.length });
    }

    if (route === 'GET admin/reports') {
      const rows = await sql`select q.id, q.jilid, q.bab, q.q, q.a, q.b, q.c, q.d, q.answer, count(*)::int n, max(r.created_at) last,
          json_agg(json_build_object('kind', r.kind, 'note', r.note, 'by', u.username, 'at', r.created_at) order by r.created_at desc) rs
        from question_reports r join questions q on q.id = r.question_id join users u on u.id = r.user_id
        where r.status = 'open' group by q.id order by n desc, last desc limit 100`;
      return J({ rows });
    }

    if (route === 'POST admin/report-resolve') {
      const id = +body.question;
      if (!Number.isInteger(id) || id < 1) return bad('Soal tidak valid');
      const r = await sql`update question_reports set status = 'done' where question_id = ${id} and status = 'open' returning id`;
      return J({ resolved: r.length });
    }

    if (route === 'POST admin/reset-password') {
      const id = +body.id, np = String(body.password || '');
      if (!id) return bad('ID tidak valid');
      if (np.length < 6 || np.length > PW_MAX) return bad('Password baru 6–' + PW_MAX + ' karakter');
      const [t] = await sql`select username, role from users where id = ${id}`;
      if (!t) return bad('Pengguna tidak ditemukan', 404);
      if (t.role === 'admin') return bad('Password akun admin diganti lewat menu Profil', 403);
      const salt = crypto.getRandomValues(new Uint8Array(16));
      await sql.transaction([
        sql`update users set pass_hash = ${await hash(np, salt)}, salt = ${b64(salt)} where id = ${id}`,
        sql`delete from login_attempts where key = ${'u:' + t.username.toLowerCase()}`]);
      return J({ ok: true });
    }

    if (route === 'GET admin/users') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 30);
      const users = await sql`
        select u.id, u.username, u.role,
          (select max(a.created_at) from attempts a where a.user_id = u.id) as last,
          (select count(*) from attempts a where a.user_id = u.id)::int as attempts,
          coalesce((select sum(x) from (
            select max(case when a.level = 'endless' then a.score::numeric else round((case a.level when 'easy' then 100 when 'medium' then 200 else 300 end) * a.correct::numeric / a.total) end) x
            from attempts a where a.user_id = u.id group by a.jilid, a.level) t), 0)::int as xp
        from users u
        where ${q}::text = '' or strpos(lower(u.username), lower(${q}::text)) > 0
        order by u.username limit 50`;
      const [{ n }] = await sql`select count(*)::int n from users where ${q}::text = '' or strpos(lower(username), lower(${q}::text)) > 0`;
      return J({ users, total: n });
    }

    if (route === 'GET admin/user') {
      const id = +url.searchParams.get('id') || 0;
      const [[t], best, recent, [en]] = await sql.transaction([
        sql`select id, username, role, created_at from users where id = ${id}`,
        bestOf(id),
        sql`select jilid, level, correct, total, score, created_at from attempts where user_id = ${id} order by created_at desc limit 10`,
        sql`select least(ceil(coalesce(max(n), 0) / 10.0), 7)::int s from endless_runs where user_id = ${id}`]);
      if (!t) return bad('Pengguna tidak ditemukan', 404);
      return J({ user: t, best: Object.fromEntries(best.map(r => [r.jilid + ':' + r.level, r.xp])), recent, tstage: en.s });
    }

    if (route === 'POST admin/delete-user') {
      const id = +body.id;
      if (!id) return bad('ID tidak valid');
      if (id === u.id) return bad('Tidak bisa menghapus akunmu sendiri');
      const [t] = await sql`select role from users where id = ${id}`;
      if (!t) return bad('Pengguna tidak ditemukan', 404);
      if (t.role === 'admin') return bad('Akun admin tidak bisa dihapus dari sini', 403);
      await sql`delete from users where id = ${id}`;
      LB.clear();
      return J({ ok: true });
    }

    return bad('Tidak ditemukan', 404);
  } catch (e) {
    if (e.code === '23503') return bad('Silakan masuk dulu', 401); // akun sudah dihapus
    console.error(e);
    return bad('Kesalahan server', 500);
  }
}
