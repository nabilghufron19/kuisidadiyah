import { neon } from '@neondatabase/serverless';

const enc = new TextEncoder();
const b64 = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const bad = (m, s = 400) => J({ error: m }, s);
// Efek: harga efek jawaban benar (gold). 'confetti' bawaan dan gratis. Gold = XP rekor x GOLD_RATE, dikurangi total belanja.
const GOLD_RATE = 1;
// Gold tambahan di luar XP rekor dan hadiah spin. Dicatat di tabel gold_grants (satu baris per pemberian) dan ikut dihitung lewat gold_total_bonus().
const STARTER_GOLD = 500;                          // Gold awal untuk murid yang baru mendaftar
const RANK_MIN = [0, 300, 700, 1200, 1800, 3000];  // batas XP tiap rank (harus sama dengan RANKS di index.html dan admin/stats)
const RANK_PAY = [50, 100, 150, 200, 250, 300];    // Gold harian per rank: Bronze, Silver, Gold, Platinum, Diamond, Legend
const GRANTED = new Map();                         // uid -> hari (WIB) bonus rank sudah diperiksa; menghemat satu query per /me
const wibDay = () => new Date(Date.now() + 7 * 36e5).toISOString().slice(0, 10);
const SHOP = { stars: 100, bubbles: 200, petals: 300, coins: 450, fireworks: 600, fire: 900, ice: 1100, lightning: 1500, comet: 2000, galaxy: 2800 };
// Efek: gaya nama di leaderboard (kunci diawali n_). Disimpan di purchases seperti efek jawaban; yang terpasang ada di users.fxn.
const NSHOP = { n_mint: 100, n_ocean: 150, n_grape: 300, n_sunset: 400, n_shimmer: 600, n_neon: 800, n_blaze: 1100, n_frost: 1300, n_glitch: 2000, n_rainbow: 2500 };
// Efek soal: gaya dan animasi teks soal saat kuis (kunci diawali f_). Disimpan di purchases; yang terpasang ada di users.fxq.
const FSHOP = { f_emas: 150, f_embun: 150, f_neon: 400, f_holo: 450, f_api: 800, f_es: 900, f_petir: 1500, f_lava: 1800, f_aurora: 2500, f_galaksi: 3000 };
const PRICES = { ...SHOP, ...NSHOP, ...FSHOP };
// Kuis harian: 10 soal acak semua jilid; nilai >= DAILY_PASS memberi 1 spin. Hadiah = [gold, bobot]. Spin ke-PITY sejak hadiah >= RARE terakhir dijamin langka.
const DAILY_N = 10, DAILY_PASS = 80, RARE = 500, PITY = 10;
const PRIZES = [[150, 30], [200, 25], [300, 20], [500, 13], [750, 7], [1000, 5]]; // hadiah minimal 150 gold; rata-rata sekitar 322 gold per spin
// Cepat Tepat (kuis harian kedua): 10 soal, batas waktu per soal turun dari 10 detik ke 5 detik. Jeda antarsoal di klien +-1,2 detik.
const FAST_LIM = [10, 9, 9, 8, 8, 7, 7, 6, 6, 5], FAST_PASS = 80, FAST_GRACE_MS = 800, FAST_SLACK_MS = 35000; // FAST_SLACK_MS = kelonggaran total (jeda, jaringan)
const RANK_MIN_XP = 300, RANK_MIN_PLAYERS = 5; // syarat pencapaian peringkat leaderboard
const PASS_PCT = 60, XPMAX = { easy: 100, medium: 200, hard: 300 }; // PASS_PCT = persen benar agar sebuah quest dianggap selesai

// ---------- Pencapaian: katalog dan fungsi murni (diuji terpisah) ----------
// <ach-pure>
const STREAK_SKIP_DOW = 5; // hari yang tidak memutus streak (0 = Ahad ... 5 = Jumat, libur madrasah). Isi -1 untuk mematikan.
const AG = { Umum: 25, Langka: 75, Epik: 150, Legendaris: 300, Mitos: 500 }; // Gold hadiah per tingkat, sekali per pencapaian
const ACH_GROUPS = ['Konsistensi', 'Ketepatan', 'Tathbiq', 'Efek & Hoki', 'Profil & Komunitas', 'Peringkat'];
const LEGEND_ITEMS = new Set(['lightning', 'comet', 'galaxy', 'n_blaze', 'n_frost', 'n_glitch', 'n_rainbow']); // item Legendaris + Mitos di menu Efek (harus sama dengan tier di index.html)
// A(kunci, grup, nama, deskripsi, ikon, tingkat, metrik, target, { h: tersembunyi, ok: syarat tambahan })
const A = (k, g, n, d, i, t, m, need, o = {}) => ({ k, g, n, d, i, t, gold: AG[t], m, need, h: o.h ? 1 : 0, np: o.np ? 1 : 0, ok: o.ok });
const ACH = [
  A('streak3', 0, 'Istiqomah 3 Hari', 'Aktif 3 hari berturut-turut', '🌱', 'Umum', 'streak', 3),
  A('streak7', 0, 'Istiqomah 7 Hari', 'Aktif 7 hari berturut-turut', '🔥', 'Langka', 'streak', 7),
  A('streak30', 0, 'Istiqomah 30 Hari', 'Aktif 30 hari berturut-turut', '🌟', 'Epik', 'streak', 30),
  A('streak100', 0, 'Istiqomah 100 Hari', 'Aktif 100 hari berturut-turut', '👑', 'Mitos', 'streak', 100),
  A('subuh1', 0, 'Pejuang Subuh', 'Selesaikan kuis (lulus) di waktu Subuh, pukul 03.45–05.30 WIB', '🌄', 'Langka', 'subuh', 1, { h: 1 }),
  A('subuh7', 0, 'Ahli Subuh', 'Selesaikan 7 kuis (lulus) di waktu Subuh', '🌅', 'Epik', 'subuh', 7, { h: 1 }),
  A('daily7', 0, 'Harian Tekun', 'Lulus kuis harian 7 hari berturut-turut', '📅', 'Epik', 'dstreak', 7),
  A('daily30', 0, 'Harian Istiqomah', 'Lulus kuis harian 30 hari berturut-turut', '🗓️', 'Legendaris', 'dstreak', 30),
  A('bangkit', 0, 'Bangkit Lagi', 'Naikkan nilai minimal 30 poin dari percobaan sebelumnya di level yang sama', '💪', 'Umum', 'improved', 1),
  A('perfE', 1, 'Sempurna Mudah', 'Raih nilai 100 di level Mudah (jilid mana pun)', '🎯', 'Umum', 'perf_easy', 1),
  A('perfM', 1, 'Sempurna Sedang', 'Raih nilai 100 di level Sedang (jilid mana pun)', '🏹', 'Langka', 'perf_medium', 1),
  A('perfH', 1, 'Sempurna Sulit', 'Raih nilai 100 di level Sulit (jilid mana pun)', '💎', 'Epik', 'perf_hard', 1),
  A('mj1', 1, 'Mumtaz Jilid 1', 'Raih nilai 100 di ketiga level Jilid 1', '💯', 'Epik', 'mj1', 1),
  A('mj2', 1, 'Mumtaz Jilid 2', 'Raih nilai 100 di ketiga level Jilid 2', '💯', 'Epik', 'mj2', 1),
  A('mj3', 1, 'Mumtaz Jilid 3', 'Raih nilai 100 di ketiga level Jilid 3', '💯', 'Epik', 'mj3', 1),
  A('mj4', 1, 'Mumtaz Jilid 4', 'Raih nilai 100 di ketiga level Jilid 4', '💯', 'Epik', 'mj4', 1),
  A('hafizh', 1, 'Hafizh Nahwu', 'Raih nilai 100 di semua 12 level', '🏆', 'Mitos', 'perfAll', 12),
  A('kilat', 1, 'Kilat Sempurna', 'Raih nilai 100 di kuis harian Cepat Tepat', '⏱️', 'Epik', 'fastPerf', 1),
  A('run20', 1, 'Beruntun 20', 'Jawab benar 20 soal berturut-turut dalam satu sesi', '⚡', 'Langka', 'run', 20),
  A('run50', 1, 'Beruntun 50', 'Jawab benar 50 soal berturut-turut dalam satu sesi', '🌩️', 'Epik', 'run', 50),
  A('correct100', 1, 'Seratus Benar', 'Kumpulkan 100 jawaban benar', '📘', 'Umum', 'correct', 100),
  A('correct500', 1, 'Lima Ratus Benar', 'Kumpulkan 500 jawaban benar', '📗', 'Langka', 'correct', 500),
  A('correct1000', 1, 'Seribu Benar', 'Kumpulkan 1000 jawaban benar', '📚', 'Epik', 'correct', 1000),
  A('clean', 2, 'Tanpa Cela', 'Capai soal ke-31 Tathbiq tanpa kehilangan nyawa', '🛡️', 'Legendaris', 'clean', 1),
  A('marathon', 2, 'Maraton', 'Jawab 100 soal dalam satu sesi Tathbiq', '🏃', 'Epik', 'marathon', 100),
  A('legend3', 3, 'Kolektor Legendaris', 'Miliki 3 item Legendaris atau Mitos di menu Efek', '💠', 'Legendaris', 'legend', 3),
  A('legend5', 3, 'Kolektor Agung', 'Miliki 5 item Legendaris atau Mitos di menu Efek', '🔱', 'Mitos', 'legend', 5),
  A('fxall', 3, 'Koleksi Efek Penuh', 'Miliki semua efek jawaban di menu Efek', '🎆', 'Mitos', 'fxOwned', Object.keys(SHOP).length),
  A('nmall', 3, 'Koleksi Nama Penuh', 'Miliki semua gaya nama di menu Efek', '✒️', 'Mitos', 'nmOwned', Object.keys(NSHOP).length),
  A('jackpot', 3, 'Jackpot', 'Dapatkan hadiah 1000 Gold dari spin kuis harian', '🎰', 'Mitos', 'jackpot', 1, { h: 1 }),
  A('photo', 4, 'Wajah Baru', 'Unggah foto pribadi', '📷', 'Umum', 'photo', 1),
  A('vet30', 4, 'Murid Lama', 'Akun berusia 30 hari dan aktif minimal 10 hari', '🕌', 'Langka', 'age', 30, { ok: m => m.active >= 10 }),
  A('vet100', 4, 'Veteran', 'Akun berusia 100 hari dan aktif minimal 10 hari', '🏛️', 'Epik', 'age', 100, { ok: m => m.active >= 10 }),
  A('rank3', 5, 'Tiga Besar', 'Capai peringkat 3 besar di Leaderboard (Semua), minimal ' + RANK_MIN_XP + ' XP dan ' + RANK_MIN_PLAYERS + ' murid terdaftar', '🥉', 'Epik', 'rankScore', 1, { np: 1 }),
  A('rank2', 5, 'Peringkat Dua', 'Capai peringkat 2 di Leaderboard (Semua)', '🥈', 'Legendaris', 'rankScore', 2, { np: 1 }),
  A('rank1', 5, 'Juara Umum', 'Capai peringkat 1 di Leaderboard (Semua)', '🥇', 'Mitos', 'rankScore', 3, { np: 1 }),
  A('eagle', 4, 'Mata Elang', 'Laporkan soal yang salah, lalu admin menerimanya (soal diperbaiki atau dihapus)', '🦅', 'Langka', 'accepted', 1),
];
const ACHBY = Object.fromEntries(ACH.map(a => [a.k, a]));
const achMini = a => ({ k: a.k, n: a.n, i: a.i, t: a.t, g: a.gold });
const badgeInfo = keys => (keys || []).map(k => ACHBY[k]).filter(Boolean).map(a => [a.i, a.n, a.t]); // [ikon, nama, tingkat] untuk lencana terpasang
const dayNum = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5; // 'YYYY-MM-DD' -> nomor hari
const dowOf = n => (n + 4) % 7; // nomor hari -> hari pekan (0 = Ahad); hari ke-0 (1 Jan 1970) = Kamis
// nums: nomor hari aktif, urut naik dan unik. Mengembalikan streak terbaik dan streak berjalan (yang belum putus sampai hari ini).
// Hari 'skip' tanpa aktivitas tidak memutus streak (dan tidak dihitung sebagai hari aktif).
function streaks(nums, today, skip) {
  const gapOk = (a, b) => { for (let x = a + 1; x < b; x++) if (dowOf(x) !== skip) return false; return true; };
  let best = 0, run = 0, prev = null;
  for (const x of nums) { run = prev !== null && gapOk(prev, x) ? run + 1 : 1; prev = x; if (run > best) best = run; }
  return { best, cur: prev !== null && gapOk(prev, today) ? run : 0 };
}
// rekor jawaban benar berturut-turut menurut urutan soal; soal tak terjawab dihitung salah
function maxRun(order, ans, keys) { let run = 0, best = 0; for (const id of order) { if (ans[id] && ans[id] === keys[id]) { if (++run > best) best = run; } else run = 0; } return best; }
// raw: data mentah dari database -> metrik yang dibandingkan dengan target tiap pencapaian
function calcMetrics(raw, today) {
  const b = {}; for (const r of raw.best) b[r.jilid + ':' + r.level] = r.xp;
  const J4 = [1, 2, 3, 4], LV = Object.keys(XPMAX), perf = (j, l) => (b[j + ':' + l] || 0) >= XPMAX[l];
  const uniq = a => [...new Set(a.map(dayNum))].sort((x, y) => x - y);
  const sk = streaks(uniq(raw.days), today, STREAK_SKIP_DOW), dk = streaks(uniq(raw.ddays), today, STREAK_SKIP_DOW), own = new Set(raw.items);
  const m = {
    streak: sk.best, streakCur: sk.cur, dstreak: dk.best, dstreakCur: dk.cur, subuh: raw.subuh, improved: raw.improved ? 1 : 0,
    run: raw.bestRun, correct: raw.correct, clean: raw.clean ? 1 : 0, marathon: Math.max(0, raw.maxn - 1),
    legend: [...LEGEND_ITEMS].filter(k => own.has(k)).length, fxOwned: Object.keys(SHOP).filter(k => own.has(k)).length, nmOwned: Object.keys(NSHOP).filter(k => own.has(k)).length,
    fastPerf: raw.fastPerf ? 1 : 0, rankPos: raw.rank ? raw.rank.pos : 0, players: raw.rank ? raw.rank.players : 0,
    rankScore: raw.rank && raw.rank.players >= RANK_MIN_PLAYERS && raw.rank.xp >= RANK_MIN_XP && raw.rank.pos <= 3 ? 4 - raw.rank.pos : 0,
    jackpot: raw.jackpot ? 1 : 0, photo: raw.photo ? 1 : 0, age: raw.age || 0, active: new Set(raw.days).size, accepted: raw.accepted,
    perfAll: J4.reduce((s, j) => s + LV.filter(l => perf(j, l)).length, 0),
  };
  for (const l of LV) m['perf_' + l] = J4.filter(j => perf(j, l)).length;
  for (const j of J4) m['mj' + j] = LV.every(l => perf(j, l)) ? 1 : 0;
  return m;
}
// </ach-pure>
const keyCache = new Map(); // CryptoKey cukup dibuat sekali per isolate, bukan tiap request
const hmacKey = s => keyCache.get(s) || (keyCache.set(s, crypto.subtle.importKey('raw', enc.encode(s), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])), keyCache.get(s));
const LB = new Map(), LB_TTL = 10000; // cache leaderboard per isolate (hasilnya sama untuk semua pengguna)
const REPORT_DAY = 30;                   // maksimal laporan soal per murid per hari
const REPORT_KINDS = ['kunci', 'ketik', 'ambigu', 'lain'];
const babOf = x => String(x ?? '').trim().replace(/\s+/g, ' ');
const PHOTO_MAX = 24000;                  // batas keras foto profil (byte). Klien menargetkan ~9 KB, jadi ini hanya pagar pengaman.
const PHOTO_EDGE_S = 86400;               // umur cache di edge Cloudflare (detik); browser menyimpan setahun karena URL memuat versi
// Periksa isi file sebenarnya (bukan header kiriman klien): hanya WebP atau JPEG yang utuh.
const photoMime = u => {
  const n = u.length, s = (i, t) => [...t].every((c, k) => u[i + k] === c.charCodeAt(0));
  if (n > 12 && s(0, 'RIFF') && s(8, 'WEBP') && (u[4] | u[5] << 8 | u[6] << 16 | u[7] << 24) + 8 === n) return 'image/webp';
  if (n > 4 && u[0] === 0xFF && u[1] === 0xD8 && u[2] === 0xFF && u[n - 2] === 0xFF && u[n - 1] === 0xD9) return 'image/jpeg';
  return null;
};
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

export async function onRequest({ request, env, params, waitUntil }) {
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

  // ---------- Pencapaian: ambil data mentah (satu round trip), hitung metrik, buka yang baru ----------
  const achRaw = async id => {
    const [best, [a1], [im], days, ddays, [en], own, [mi], [st], [rp], have, [ub], [rk]] = await sql.transaction([
      bestOf(id),
      sql`select coalesce(sum(correct), 0)::int c, (count(*) filter (where jilid between 1 and 4 and score >= ${PASS_PCT} and (created_at at time zone 'Asia/Jakarta')::time between time '03:45' and time '05:30'))::int subuh from attempts where user_id = ${id}`,
      sql`select exists(select 1 from (select score - lag(score) over (partition by jilid, level order by created_at) d from attempts where user_id = ${id} and jilid between 1 and 4) t where d >= 30) v`,
      sql`select to_char(d, 'YYYY-MM-DD') d from (select (created_at at time zone 'Asia/Jakarta')::date d from attempts where user_id = ${id} and (jilid = 0 or score >= ${PASS_PCT}) union select day d from daily where user_id = ${id} and done union select day d from daily_fast where user_id = ${id} and done) t order by d`,
      sql`select to_char(day, 'YYYY-MM-DD') d from daily where user_id = ${id} and done and score >= ${DAILY_PASS} order by day`,
      sql`select coalesce(max(n), 0)::int maxn, coalesce(bool_or(lives = 3 and n >= 31), false) clean from endless_runs where user_id = ${id}`,
      sql`select item from purchases where user_id = ${id}`,
      sql`select (exists(select 1 from daily where user_id = ${id} and prize >= 1000) or exists(select 1 from daily_fast where user_id = ${id} and prize >= 1000)) jp, exists(select 1 from daily_fast where user_id = ${id} and done and score >= 100) fp, (select photo_v is not null from users where id = ${id}) photo, (select floor(extract(epoch from now() - created_at) / 86400)::int from users where id = ${id}) age`,
      sql`select coalesce(max(best_run), 0)::int r from user_stats where user_id = ${id}`,
      sql`select count(*)::int n from question_reports where user_id = ${id} and accepted`,
      sql`select key, unlocked_at, gold, seen from user_achievements where user_id = ${id}`,
      sql`select badges from users where id = ${id}`,
      // peringkat di Leaderboard (Semua): hanya dihitung bila XP cukup dan Juara Umum belum terbuka (jadi murid biasa tidak memicu pemindaian semua percobaan)
      sql`with mine as (select coalesce(sum(xp), 0)::int xp from (select max(case when level = 'endless' then score::numeric else round((case level when 'easy' then 100 when 'medium' then 200 else 300 end) * correct::numeric / total) end)::int xp from attempts where user_id = ${id} group by jilid, level) x),
          gate as (select xp from mine where xp >= ${RANK_MIN_XP}::int and not exists (select 1 from user_achievements where user_id = ${id} and key = 'rank1'))
        select g.xp, r.pos, r.players from gate g, lateral (
          select (count(*) filter (where t.total > g.xp) + 1)::int pos, count(*)::int players from (
            select sum(b.xp) total from (
              select a.user_id, max(case when a.level = 'endless' then a.score::numeric else round((case a.level when 'easy' then 100 when 'medium' then 200 else 300 end) * a.correct::numeric / a.total) end)::int xp
              from attempts a join users u on u.id = a.user_id where u.role <> 'admin' or u.on_board group by a.user_id, a.jilid, a.level) b group by b.user_id) t) r`]);
    return { best, correct: a1.c, subuh: a1.subuh, improved: im.v, days: days.map(r => r.d), ddays: ddays.map(r => r.d), maxn: en.maxn, clean: en.clean,
      items: own.map(r => r.item), jackpot: mi.jp, fastPerf: mi.fp, rank: rk || null, photo: mi.photo, age: mi.age, bestRun: st.r, accepted: rp.n, have, badges: ub ? ub.badges : [] };
  };
  // Buka semua pencapaian yang sudah memenuhi syarat (termasuk milik murid lama = backfill otomatis). Hadiah Gold dicatat di user_achievements.gold.
  const evalFull = async (id, seen = true) => {
    const raw = await achRaw(id), m = calcMetrics(raw, dayNum(wibDay())), have = new Set(raw.have.map(r => r.key));
    const fresh = ACH.filter(a => !have.has(a.k) && m[a.m] >= a.need && (!a.ok || a.ok(m)));
    let newly = [];
    if (fresh.length) {
      const ins = await sql`insert into user_achievements (user_id, key, gold, seen)
        select ${id}::int, t.k, t.g, ${seen}::boolean from unnest(${fresh.map(a => a.k)}::text[], ${fresh.map(a => a.gold)}::int[]) as t(k, g)
        on conflict do nothing returning key, gold`;
      const got = new Set(ins.map(r => r.key));
      newly = fresh.filter(a => got.has(a.k)).map(achMini);
      for (const r of ins) raw.have.push({ key: r.key, unlocked_at: new Date().toISOString(), gold: r.gold, seen });
    }
    return { newly, m, have: raw.have, badges: raw.badges || [] };
  };
  // Dipakai di hook (kuis, Tathbiq, belanja, dll). Kegagalan di sini tidak boleh menggagalkan aksi utamanya.
  const evalAch = (id, seen = true) => evalFull(id, seen).then(r => r.newly).catch(e => { console.error(e); return []; });

  // Pemilihan soal: soal ber-bab diprioritaskan dan diambil bergiliran per (jilid, bab) supaya semua bab tercakup;
  // kekurangannya diisi soal tanpa bab secara acak. Urutan akhir diacak. j = 0 berarti semua jilid; excl = id yang dilewati.
  const pickQs = (j, n, excl = []) => sql`select id, q, a, b, c, d, answer from (
      select id, q, a, b, c, d, answer from (
        select id, q, a, b, c, d, answer, bab is null as nb,
          case when bab is null then 0 else row_number() over (partition by jilid, lower(bab) order by random()) end as rk
        from questions where (${j}::int = 0 or jilid = ${j}::int) and id <> all(${excl}::int[])) t
      order by nb, rk, random() limit ${n}) s order by random()`;

  try {
    // ---------- Foto profil (publik: dipanggil lewat <img>, yang tidak bisa mengirim header Authorization) ----------
    // URL memuat versi (?v=), jadi tiap unggahan baru = URL baru. Browser menyimpannya setahun; edge Cloudflare sehari (hemat compute Neon).
    if (route === 'GET photo') {
      const un = (url.searchParams.get('u') || '').trim().slice(0, 30), cache = caches.default;
      const hit = await cache.match(request);
      if (hit) return hit;
      const [p] = un ? await sql`select encode(p.data, 'base64') d, p.mime from user_photos p join users u on u.id = p.user_id where lower(u.username) = lower(${un}) and u.use_photo` : [];
      if (!p) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=60' } });
      const h = { 'Content-Type': p.mime, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" };
      const bytes = Uint8Array.from(atob(p.d), c => c.charCodeAt(0));
      if (waitUntil) waitUntil(cache.put(request, new Response(bytes, { headers: { ...h, 'Cache-Control': 'public, max-age=' + PHOTO_EDGE_S } })));
      return new Response(bytes, { headers: { ...h, 'Cache-Control': 'public, max-age=31536000, immutable' } });
    }

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
    const getUser = async () => cachedUser ||= (await sql`select id, username, role, avatar, fx, on_board, photo_v, use_photo from users where id = ${uid}`)[0] || null;

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
      const [[usr], best, [t], [sp], [bn], [rq], [ag], un] = await sql.transaction([
        sql`select username, role, avatar, fx, fxa, fxn, fxq, on_board, photo_v, use_photo, badges from users where id = ${uid}`,
        bestOf(uid),
        sql`select least(ceil(coalesce(max(n), 0) / 10.0), 7)::int as s from endless_runs where user_id = ${uid}`,
        sql`select coalesce(sum(price), 0)::int s from purchases where user_id = ${uid}`,
        sql`select gold_total_bonus(${uid}::int) s`,
        sql`select case when (select role from users where id = ${uid}) = 'admin' then (select count(distinct question_id) from question_reports where status = 'open') else 0 end::int n`,
        sql`select coalesce(sum(gold), 0)::int s from user_achievements where user_id = ${uid}`,
        sql`select key from user_achievements where user_id = ${uid} and not seen`]);
      if (!usr) return bad('Silakan masuk dulu', 401);
      const ach = jilidDone(best);
      const xpTot = best.reduce((a, r) => a + r.xp, 0), ri = Math.max(0, RANK_MIN.filter(m => m <= xpTot).length - 1);
      return J({ rankGot: got, rankPay: usr.role === 'admin' ? 0 : RANK_PAY[ri], pays: RANK_PAY, starter: STARTER_GOLD, reports: rq.n, username: usr.username, role: usr.role, avatar: usr.avatar, photo: usr.photo_v, usePhoto: usr.use_photo, fxp: usr.fx, fxa: usr.fxa, fxn: usr.fxn, fxq: usr.fxq, board: usr.on_board, spent: sp.s, bonus: bn.s + ag.s, bd: badgeInfo(usr.badges), unseen: un.map(r => ACHBY[r.key]).filter(Boolean).map(achMini), rate: GOLD_RATE, tstage: t.s, pass: PASS_PCT, ach, tathbiq: usr.role === 'admin' || ach.every(Boolean), best: Object.fromEntries(best.map(r => [r.jilid + ':' + r.level, r.xp])) });
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
      // rekor jawaban benar beruntun (urutan soal sesuai token); pencatatan ini tidak boleh menggagalkan hasil kuis
      try {
        const kq = await sql`select id, answer from questions where id = any(${t.ids}::int[])`, run = maxRun(t.ids, an, Object.fromEntries(kq.map(k => [k.id, k.answer])));
        if (run > 0) await sql`insert into user_stats (user_id, best_run) values (${uid}::int, ${run}::int) on conflict (user_id) do update set best_run = greatest(user_stats.best_run, excluded.best_run)`;
      } catch (e) { console.error(e); }
      return J({ correct: row.correct, total, score: row.score, xp: Math.round(XP[t.l] * row.correct / total), ach: await evalAch(uid) });
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
      const [r] = await sql`select id, lives, score, correct, n, asked, done, cur_run from endless_runs where id = ${+body.run || 0} and user_id = ${uid}`;
      if (!r || r.done) return bad('Sesi endless sudah berakhir', 409);
      const off = r.n - 1 - (+body.from || 0); // kiriman ulang: buang jawaban yang sudah diproses
      if (off < 0 || off > ch.length) return bad('Jawaban tidak valid');
      ch = ch.slice(off);
      const ids = r.asked.slice(r.n - 1, r.n - 1 + ch.length);
      if (ids.length < ch.length) return bad('Jawaban tidak valid');
      const key = Object.fromEntries((await sql`select id, answer from questions where id = any(${ids}::int[])`).map(k => [k.id, k.answer]));
      let { lives, score, correct, n } = r, over = false, run = r.cur_run || 0, bestRun = 0;
      for (let i = 0; i < ch.length; i++) {
        if (key[ids[i]]) { // soal yang dihapus admin dilewati
          if (key[ids[i]] === ch[i]) { score += 10 * Math.ceil(n / 10); correct++; if (++run > bestRun) bestRun = run; }
          else { run = 0; if (--lives <= 0) { over = true; break; } }
        }
        n++;
      }
      const done = over || body.end === true;
      const qs = [sql`update endless_runs set lives = ${lives}, score = ${score}, correct = ${correct}, n = ${n}, cur_run = ${run}, done = ${done}, cur = null
        where id = ${r.id} and n = ${r.n} and not done returning id`];
      if (n > 1) qs.push(sql`insert into attempts (user_id, jilid, level, total, correct, score, nonce)
        select user_id, 0, 'endless', case when lives <= 0 then n else n - 1 end, correct, score, 'endless-' || id
        from endless_runs where id = ${r.id}
        on conflict (nonce) do update set total = excluded.total, correct = excluded.correct, score = excluded.score`);
      const [upd] = await sql.transaction(qs);
      if (!upd.length) return bad('Jawaban ini sudah dikirim', 409);
      LB.clear();
      if (bestRun > 0) { try { await sql`insert into user_stats (user_id, best_run) values (${uid}::int, ${bestRun}::int) on conflict (user_id) do update set best_run = greatest(user_stats.best_run, excluded.best_run)`; } catch (e) { console.error(e); } }
      return J({ lives, score, correct, over: done, ach: await evalAch(uid) });
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
      const up = typeof body.usePhoto === 'boolean' ? body.usePhoto && u.photo_v != null : u.use_photo; // foto hanya bisa dipakai bila sudah diunggah
      try { await sql`update users set username = ${un}, avatar = ${av}, fx = ${fx}, on_board = ${ob}, use_photo = ${up} where id = ${u.id}`; }
      catch (e) { if (e.code === '23505') return bad('Username sudah dipakai', 409); throw e; }
      LB.clear();
      return J({ username: un, avatar: av, fx, board: ob, usePhoto: up });
    }

    // ---------- Foto pribadi ----------
    // Klien sudah memotong persegi, mengecilkan, dan mengompres (WebP/JPEG, ~9 KB). Server hanya memverifikasi isinya lalu menyimpan
    // satu baris per murid (upsert), jadi pemakaian Neon dibatasi: murid x PHOTO_MAX byte.
    if (route === 'POST photo') {
      const s = String(body.data || '');
      if (!s || s.length > Math.ceil(PHOTO_MAX / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return bad('Foto tidak valid');
      let raw; try { raw = Uint8Array.from(atob(s), c => c.charCodeAt(0)); } catch { return bad('Foto tidak valid'); }
      const mime = raw.length <= PHOTO_MAX ? photoMime(raw) : null;
      if (!mime) return bad('Foto harus berupa WebP atau JPEG utuh, maksimal ' + Math.round(PHOTO_MAX / 1000) + ' KB');
      const [cd] = await sql`select 1 from user_photos where user_id = ${uid}::int and updated_at > now() - interval '5 seconds'`;
      if (cd) return bad('Tunggu sebentar sebelum mengunggah lagi', 429);
      // versi = detik epoch: tidak pernah berulang walau foto dihapus lalu diunggah lagi, sehingga cache lama tidak tertukar
      const [, [r]] = await sql.transaction([
        sql`insert into user_photos (user_id, data, mime, updated_at) values (${uid}::int, decode(${s}::text, 'base64'), ${mime}::text, now())
          on conflict (user_id) do update set data = excluded.data, mime = excluded.mime, updated_at = now()`,
        sql`update users set photo_v = extract(epoch from now())::int, use_photo = true where id = ${uid}::int returning photo_v`]);
      if (!r) return bad('Silakan masuk dulu', 401);
      LB.clear();
      return J({ photo: r.photo_v, bytes: raw.length, ach: await evalAch(uid) });
    }
    if (route === 'POST photo/delete') {
      await sql.transaction([
        sql`delete from user_photos where user_id = ${uid}::int`,
        sql`update users set photo_v = null, use_photo = false where id = ${uid}::int`]);
      LB.clear();
      return J({ ok: true });
    }

    // ---------- Pencapaian dan lencana ----------
    if (route === 'GET achievements') {
      if (url.searchParams.get('lite')) { // ringan (halaman Profil): hanya yang sudah terbuka + lencana terpasang
        const [own, [ub]] = await sql.transaction([sql`select key from user_achievements where user_id = ${uid}`, sql`select badges from users where id = ${uid}`]);
        const has = new Set(own.map(r => r.key));
        return J({ list: ACH.filter(a => has.has(a.k)).map(a => ({ k: a.k, n: a.n, d: a.d, i: a.i, t: a.t })), badges: (ub && ub.badges) || [] });
      }
      const ev = await evalFull(uid), have = new Map(ev.have.map(r => [r.key, r]));
      const list = ACH.map(a => {
        const h = have.get(a.k), got = !!h;
        if (a.h && !got) return { k: a.k, g: a.g, n: '???', d: 'Pencapaian tersembunyi. Temukan sendiri!', i: '❔', t: a.t, gold: a.gold, h: 1, got: false, v: 0, need: 0 };
        return { k: a.k, g: a.g, n: a.n, d: a.d, i: a.i, t: a.t, gold: a.gold, h: a.h, np: a.np, got, at: got ? h.unlocked_at : null, v: Math.min(ev.m[a.m] || 0, a.need), need: a.need };
      });
      return J({ list, groups: ACH_GROUPS, newly: ev.newly, pinned: ev.badges, skip: STREAK_SKIP_DOW, rank: ev.m.rankPos ? { pos: ev.m.rankPos, players: ev.m.players } : null, rmin: [RANK_MIN_XP, RANK_MIN_PLAYERS],
        earned: ev.have.reduce((s, r) => s + (r.gold || 0), 0),
        cur: { streak: ev.m.streakCur, best: ev.m.streak, dstreak: ev.m.dstreakCur, dbest: ev.m.dstreak } });
    }
    if (route === 'POST achievements/seen') {
      await sql`update user_achievements set seen = true where user_id = ${uid} and not seen`;
      return J({ ok: true });
    }
    // Pasang sampai 3 lencana di profil; hanya dari pencapaian yang sudah terbuka. Urutan kiriman = urutan tampil.
    if (route === 'POST badges') {
      const want = [...new Set((Array.isArray(body.keys) ? body.keys : []).map(String))].filter(k => ACHBY[k]);
      const own = want.length ? await sql`select key from user_achievements where user_id = ${uid} and key = any(${want}::text[])` : [];
      const ok = new Set(own.map(r => r.key)), final = want.filter(k => ok.has(k)).slice(0, 3);
      await sql`update users set badges = ${final}::text[] where id = ${uid}`;
      LB.clear();
      return J({ badges: final, bd: badgeInfo(final) });
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
      const [best, own, [u], [bn], [ag]] = await sql.transaction([bestOf(uid), sql`select item, price from purchases where user_id = ${uid}`, sql`select fxa, fxn, fxq, role from users where id = ${uid}`, sql`select gold_total_bonus(${uid}::int) s`, sql`select coalesce(sum(gold), 0)::int s from user_achievements where user_id = ${uid}`]);
      const earned = best.reduce((a, r) => a + r.xp, 0) * GOLD_RATE, spent = own.reduce((a, r) => a + r.price, 0), admin = !!u && u.role === 'admin';
      return { gold: earned + bn.s + ag.s - spent, earned, bonus: bn.s + ag.s, spent, admin, owned: admin ? Object.keys(PRICES) : own.map(r => r.item), equipped: u ? u.fxa : null, equippedName: u ? u.fxn : null, equippedFont: u ? u.fxq : null, prices: PRICES };
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
            bal as (select coalesce((select sum(xp) from best), 0) * ${GOLD_RATE}::numeric + coalesce(gold_total_bonus(${uid}::int), 0) + coalesce((select sum(gold) from user_achievements where user_id = ${uid}), 0) - coalesce((select sum(price) from purchases where user_id = ${uid}), 0) g)
          insert into purchases (user_id, item, price) select ${uid}::int, ${item}::text, ${price}::int from bal where g >= ${price}::int on conflict do nothing returning item`]);
      if (!ins.length) {
        const [own] = await sql`select 1 from purchases where user_id = ${uid} and item = ${item}`;
        return own ? bad('Item ini sudah kamu miliki', 409) : bad('Gold belum cukup', 402);
      }
      const ach = await evalAch(uid);
      return J({ ...(await shopState()), ach });
    }
    if (route === 'POST shop/equip') {
      const item = String(body.item || 'confetti');
      if (item === 'n_none') { // lepas gaya nama
        await sql`update users set fxn = null where id = ${uid}`; LB.clear();
        return J(await shopState());
      }
      if (item === 'f_none') { // lepas efek soal
        await sql`update users set fxq = null where id = ${uid}`;
        return J(await shopState());
      }
      if (item !== 'confetti' && !Object.hasOwn(PRICES, item)) return bad('Item tidak ditemukan', 404);
      const st = await shopState();
      if (item !== 'confetti' && !st.owned.includes(item)) return bad('Beli dulu item ini', 403);
      if (item.startsWith('n_')) { // gaya nama -> users.fxn
        await sql`update users set fxn = ${item} where id = ${uid}`; LB.clear();
        return J({ ...st, equippedName: item });
      }
      if (item.startsWith('f_')) { // efek soal -> users.fxq
        await sql`update users set fxq = ${item} where id = ${uid}`;
        return J({ ...st, equippedFont: item });
      }
      const fx = item === 'confetti' ? null : item; // efek jawaban benar -> users.fxa
      await sql`update users set fxa = ${fx} where id = ${uid}`;
      return J({ ...st, equipped: fx });
    }

    // ---------- Kuis harian (hari mengikuti WIB) ----------
    const dailyPity = () => sql`select count(*)::int n from daily where user_id = ${uid} and spun and day > coalesce((select max(day) from daily where user_id = ${uid} and prize >= ${RARE}), date '1970-01-01')`;
    const fastPity = () => sql`select count(*)::int n from daily_fast where user_id = ${uid} and spun and day > coalesce((select max(day) from daily_fast where user_id = ${uid} and prize >= ${RARE}), date '1970-01-01')`;
    if (route === 'GET daily') {
      const [[t], [p], [y], [ft], [fp], [fy]] = await sql.transaction([
        sql`select done, correct, score, spun, prize from daily where user_id = ${uid} and day = (now() at time zone 'Asia/Jakarta')::date`,
        sql`select count(*)::int n from daily where user_id = ${uid} and done and score >= ${DAILY_PASS} and not spun`,
        dailyPity(),
        sql`select done, correct, score, spun, prize from daily_fast where user_id = ${uid} and day = (now() at time zone 'Asia/Jakarta')::date`,
        sql`select count(*)::int n from daily_fast where user_id = ${uid} and done and score >= ${FAST_PASS} and not spun`,
        fastPity()]);
      return J({ today: t || null, pending: p.n, pity: y.n, need: PITY, rare: RARE, prizes: PRIZES, fast: { today: ft || null, pending: fp.n, pity: fy.n, pass: FAST_PASS, lim: FAST_LIM } });
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
      return J({ correct: row.correct, total, score: row.score, pass: row.score >= DAILY_PASS, ach: await evalAch(uid) });
    }
    // ---------- Cepat Tepat: kuis harian kedua, 10 soal, batas waktu per soal 10 detik turun ke 5 detik ----------
    // Satu kesempatan per hari (baris dibuat saat mulai). Klien mengirim waktu jawab tiap soal; server memeriksa batas per soal
    // dan total waktu sejak mulai (anti-curang kasar, setara kuis lain: kunci jawaban memang ikut dikirim ke klien).
    if (route === 'POST daily/fast/start') {
      const qs = await pickQs(0, FAST_LIM.length);
      if (qs.length < FAST_LIM.length) return bad('Soal belum cukup untuk Cepat Tepat (minimal ' + FAST_LIM.length + ' soal)');
      const [r] = await sql`insert into daily_fast (user_id, day) values (${uid}, (now() at time zone 'Asia/Jakarta')::date) on conflict do nothing returning day::text as d`;
      if (!r) return bad('Cepat Tepat hari ini sudah kamu ambil. Kembali lagi besok!', 409);
      const token = await sign({ k: 'fast', uid, day: r.d, ids: qs.map(x => x.id), t0: Date.now(), exp: Date.now() + 36e5 }, S);
      return J({ questions: qs, token, lim: FAST_LIM });
    }
    if (route === 'POST daily/fast/submit') {
      const t = await verify(String(body.token || ''), S);
      if (!t || t.k !== 'fast' || t.uid !== uid) return bad('Sesi Cepat Tepat tidak valid atau kedaluwarsa');
      const total = t.ids.length, el = Date.now() - t.t0, budget = FAST_LIM.reduce((a, b) => a + b, 0) * 1000 + FAST_SLACK_MS;
      if (el < total * 700) return bad('Terlalu cepat. Baca soal dengan teliti.', 429);
      const an = body.answers && typeof body.answers === 'object' ? body.answers : {}, tm = body.times && typeof body.times === 'object' ? body.times : {};
      // jawaban dihitung hanya bila waktunya sah: 0 <= waktu <= batas soal + toleransi; kirim terlambat (lewat total waktu) = semua dianggap salah
      const ok = el <= budget ? t.ids.map((id, i) => [id, i]).filter(([id, i]) => /^[ABCD]$/.test(an[id]) && +tm[id] >= 0 && +tm[id] <= FAST_LIM[i] * 1000 + FAST_GRACE_MS) : [];
      const ids = ok.map(x => x[0]), ls = ids.map(id => an[id]);
      const [row] = await sql`with c as (select count(*)::int n from unnest(${ids}::int[], ${ls}::text[]) as a(id, l) join questions q on q.id = a.id and q.answer = a.l)
        update daily_fast set done = true, correct = c.n, score = round(c.n * 100.0 / ${total}::int)::int from c
        where user_id = ${uid} and day = ${t.day}::date and not done returning correct, score`;
      if (!row) return bad('Cepat Tepat ini sudah diselesaikan', 409);
      return J({ correct: row.correct, total, score: row.score, pass: row.score >= FAST_PASS, ach: await evalAch(uid) });
    }
    if (route === 'POST daily/spin') {
      const fast = body.mode === 'fast'; // spin dari Cepat Tepat memakai tabel dan hitungan jaminan sendiri
      const [[row], [y]] = await sql.transaction([
        fast ? sql`select day::text d from daily_fast where user_id = ${uid} and done and score >= ${FAST_PASS} and not spun order by day desc limit 1`
          : sql`select day::text d from daily where user_id = ${uid} and done and score >= ${DAILY_PASS} and not spun order by day desc limit 1`,
        fast ? fastPity() : dailyPity()]);
      if (!row) return bad('Kamu belum punya kesempatan spin', 409);
      const pool = y.n + 1 >= PITY ? PRIZES.filter(p => p[0] >= RARE) : PRIZES;
      let x = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 * pool.reduce((a, p) => a + p[1], 0), prize = pool[pool.length - 1][0];
      for (const [g, w] of pool) { if ((x -= w) < 0) { prize = g; break; } }
      const [u] = fast ? await sql`update daily_fast set spun = true, prize = ${prize} where user_id = ${uid} and day = ${row.d}::date and done and score >= ${FAST_PASS} and not spun returning prize`
        : await sql`update daily set spun = true, prize = ${prize} where user_id = ${uid} and day = ${row.d}::date and done and score >= ${DAILY_PASS} and not spun returning prize`;
      if (!u) return bad('Spin sudah dipakai', 409);
      return J({ prize, rare: prize >= RARE, pity: prize >= RARE ? 0 : y.n + 1, ach: await evalAch(uid) });
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
                 case when u.use_photo then u.photo_v end as ph, u.badges,
                 sum(xp)::int as total, (count(distinct jilid) filter (where jilid > 0))::int as jilids
          from best join users u on u.id = best.user_id where u.role <> 'admin' or u.on_board group by u.id, u.username, u.avatar, u.role, u.fx, u.fxn, u.photo_v, u.use_photo, u.badges)
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
      for (const r of rows) { const mx = r.role === 'admin' ? 11 : jilidDone(by[r.id] || []).filter(Boolean).length + (st[r.id] || 0); r.fx = r.pick == null ? mx : Math.min(r.pick, mx); delete r.id; delete r.role; delete r.pick; r.bd = badgeInfo(r.badges); delete r.badges; }
      const out = { rows };
      if (LB.size > 60) LB.clear();
      LB.set(ck, { t: Date.now() + LB_TTL, v: out });
      return J(out);
    }

    // ---------- Profil pemain (dibuka dari leaderboard) ----------
    // Hanya data publik: XP, pencapaian, efek foto, dan koleksi item. Gold, riwayat percobaan, dan data akun TIDAK dikirim.
    if (route === 'GET player') {
      const un = (url.searchParams.get('u') || '').trim().slice(0, 30);
      const [t] = un ? await sql`select id, username, role, avatar, fx, fxa, fxn, fxq, on_board, created_at, photo_v, use_photo, badges from users where lower(username) = lower(${un})` : [];
      if (!t || (t.role === 'admin' && !t.on_board)) return bad('Pemain tidak ditemukan', 404);
      const [best, [en], own] = await sql.transaction([
        bestOf(t.id),
        sql`select least(ceil(coalesce(max(n), 0) / 10.0), 7)::int s from endless_runs where user_id = ${t.id}`,
        sql`select item from purchases where user_id = ${t.id}`]);
      const admin = t.role === 'admin', ach = admin ? [true, true, true, true] : jilidDone(best);
      const mx = admin ? 11 : ach.filter(Boolean).length + en.s;
      return J({
        username: t.username, admin, avatar: t.avatar, ph: t.use_photo ? t.photo_v : null, bd: badgeInfo(t.badges), since: t.created_at,
        fx: t.fx == null ? mx : Math.min(t.fx, mx),
        total: best.reduce((a, r) => a + r.xp, 0), best: Object.fromEntries(best.map(r => [r.jilid + ':' + r.level, r.xp])),
        ach, tstage: admin ? 7 : en.s, owned: admin ? Object.keys(PRICES) : own.map(r => r.item), equipped: t.fxa, nm: t.fxn, fq: t.fxq
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
      // accepted = laporan benar (soal diedit atau dihapus admin): pelapor mendapat kredit untuk pencapaian Mata Elang, diberi tahu saat membuka aplikasi
      const acc = body.accepted === true;
      const r = await sql`update question_reports set status = 'done', accepted = ${acc} where question_id = ${id} and status = 'open' returning user_id`;
      if (acc) for (const rid of new Set(r.map(x => x.user_id))) await evalAch(rid, false);
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
        sql`select id, username, role, created_at, photo_v, use_photo from users where id = ${id}`,
        bestOf(id),
        sql`select jilid, level, correct, total, score, created_at from attempts where user_id = ${id} order by created_at desc limit 10`,
        sql`select least(ceil(coalesce(max(n), 0) / 10.0), 7)::int s from endless_runs where user_id = ${id}`]);
      if (!t) return bad('Pengguna tidak ditemukan', 404);
      return J({ user: t, best: Object.fromEntries(best.map(r => [r.jilid + ':' + r.level, r.xp])), recent, tstage: en.s });
    }

    // Moderasi: admin bisa menghapus foto pribadi murid (foto tampil publik di leaderboard).
    if (route === 'POST admin/photo-delete') {
      const id = +body.id;
      if (!Number.isInteger(id) || id < 1) return bad('ID tidak valid');
      await sql.transaction([
        sql`delete from user_photos where user_id = ${id}::int`,
        sql`update users set photo_v = null, use_photo = false where id = ${id}::int`]);
      LB.clear();
      return J({ ok: true });
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
