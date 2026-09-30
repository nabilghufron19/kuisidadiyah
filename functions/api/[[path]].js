import { neon } from '@neondatabase/serverless';

const enc = new TextEncoder();
const b64 = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const bad = (m, s = 400) => J({ error: m }, s);
const PASS_PCT = 60, XPMAX = { easy: 100, medium: 200, hard: 300 }; // PASS_PCT = persen benar agar sebuah quest dianggap selesai
const keyCache = new Map(); // CryptoKey cukup dibuat sekali per isolate, bukan tiap request
const hmacKey = s => keyCache.get(s) || (keyCache.set(s, crypto.subtle.importKey('raw', enc.encode(s), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])), keyCache.get(s));
const LB = new Map(), LB_TTL = 10000; // cache leaderboard per isolate (hasilnya sama untuk semua pengguna)

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
  const bestOf = uid => sql`select jilid, level, max(case when level = 'endless' then score::numeric else round((case level when 'easy' then 100 when 'medium' then 200 else 300 end) * correct::numeric / total) end)::int xp
    from attempts where user_id = ${uid} group by jilid, level`;
  // [jilid1, jilid2, jilid3, jilid4] -> true bila ketiga level jilid itu selesai
  const jilidDone = rows => {
    const b = {}; for (const r of rows) b[r.jilid + ':' + r.level] = r.xp;
    return [1, 2, 3, 4].map(j => Object.entries(XPMAX).every(([l, x]) => (b[j + ':' + l] || 0) >= x * PASS_PCT / 100));
  };

  try {
    // ---------- Daftar & masuk ----------
    if (route === 'POST register') {
      const un = String(body.username || ''), pw = String(body.password || '');
      if (!/^[A-Za-z0-9_]{3,20}$/.test(un)) return bad('Username 3–20 karakter: huruf, angka, atau _');
      if (pw.length < 6) return bad('Password minimal 6 karakter');
      if ((await sql`select 1 from users where lower(username) = lower(${un}) limit 1`).length) return bad('Username sudah dipakai', 409);
      const salt = crypto.getRandomValues(new Uint8Array(16));
      try {
        const [u] = await sql`insert into users (username, pass_hash, salt) values (${un}, ${await hash(pw, salt)}, ${b64(salt)}) returning id`;
        return J({ token: await authToken(u.id) });
      } catch (e) {
        if (e.code === '23505') return bad('Username sudah dipakai', 409);
        throw e;
      }
    }
    if (route === 'POST login') {
      const un = String(body.username || ''), pw = String(body.password || '');
      const [u] = await sql`select id, pass_hash, salt from users where lower(username) = lower(${un})`;
      if (!u || (await hash(pw, unb64(u.salt))) !== u.pass_hash) return bad('Username atau password salah', 401);
      return J({ token: await authToken(u.id) });
    }

    // ---------- Wajib masuk ----------
    // Token bertanda tangan sudah cukup untuk tahu siapa pemanggilnya (uid). Data user dari DB
    // (getUser) hanya diambil di rute yang memerlukannya: profil dan admin.
    const claim = await verify((request.headers.get('Authorization') || '').slice(7), S);
    const uid = claim && claim.k === 'auth' ? +claim.uid : 0;
    if (!uid) return bad('Silakan masuk dulu', 401);
    let cachedUser;
    const getUser = async () => cachedUser ||= (await sql`select id, username, role, avatar, fx from users where id = ${uid}`)[0] || null;

    if (route === 'GET me') {
      // satu round trip untuk tiga query
      const [[usr], best, [t]] = await sql.transaction([
        sql`select username, role, avatar, fx from users where id = ${uid}`,
        bestOf(uid),
        sql`select least(ceil(coalesce(max(n), 0) / 10.0), 7)::int as s from endless_runs where user_id = ${uid}`]);
      if (!usr) return bad('Silakan masuk dulu', 401);
      const ach = jilidDone(best);
      return J({ username: usr.username, role: usr.role, avatar: usr.avatar, fxp: usr.fx, tstage: t.s, pass: PASS_PCT, ach, tathbiq: usr.role === 'admin' || ach.every(Boolean), best: Object.fromEntries(best.map(r => [r.jilid + ':' + r.level, r.xp])) });
    }

    if (route === 'GET quiz') {
      const j = +url.searchParams.get('jilid'), l = url.searchParams.get('level');
      const n = { easy: 10, medium: 20, hard: 30 }[l];
      if (!(j >= 1 && j <= 4) || !n) return bad('Pilihan tidak valid');
      const qs = await sql`select id, q, a, b, c, d from questions where jilid = ${j} order by random() limit ${n}`;
      if (!qs.length) return bad('Belum ada soal untuk jilid ini');
      const token = await sign({ k: 'quiz', uid, j, l, ids: qs.map(x => x.id), nonce: crypto.randomUUID(), exp: Date.now() + 72e5 }, S);
      return J({ questions: qs, token });
    }

    if (route === 'POST check') {
      const t = await verify(String(body.token || ''), S);
      if (!t || t.k !== 'quiz' || t.uid !== uid) return bad('Sesi kuis tidak valid atau kedaluwarsa');
      const id = +body.id, c = String(body.choice || '');
      if (!t.ids.includes(id) || !/^[ABCD]$/.test(c)) return bad('Jawaban tidak valid');
      // satu round trip: ambil kunci jawaban + catat jawaban (ok dihitung di database)
      const [[r], ins] = await sql.transaction([
        sql`select answer from questions where id = ${id}`,
        sql`insert into quiz_answers (nonce, qid, ok) values (${t.nonce}, ${id}, coalesce((select answer from questions where id = ${id}) = ${c}, false)) on conflict do nothing returning ok`]);
      if (!r) return bad('Soal tidak ditemukan');
      if (!ins.length) return bad('Soal ini sudah dijawab', 409);
      return J({ ok: ins[0].ok, answer: r.answer });
    }

    if (route === 'POST submit') {
      const t = await verify(String(body.token || ''), S);
      if (!t || t.k !== 'quiz' || t.uid !== uid) return bad('Sesi kuis tidak valid atau kedaluwarsa');
      const total = t.ids.length, XP = { easy: 100, medium: 200, hard: 300 };
      let row;
      try {
        // hitung benar + simpan percobaan dalam satu statement
        [row] = await sql`insert into attempts (user_id, jilid, level, total, correct, score, nonce)
          values (${uid}, ${t.j}, ${t.l}, ${total},
            (select count(*)::int from quiz_answers where nonce = ${t.nonce} and ok),
            (select round(count(*) * 100.0 / ${total})::int from quiz_answers where nonce = ${t.nonce} and ok),
            ${t.nonce})
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
      // pilih soal acak + buat sesi dalam satu statement
      const [r] = await sql`with q as (select id, q, a, b, c, d from questions order by random() limit 1),
        ins as (insert into endless_runs (user_id, asked, n, cur) select ${uid}::int, array[q.id], 1, q.id from q returning id)
        select ins.id as run, to_jsonb(q) as question from ins, q`;
      if (!r) return bad('Belum ada soal');
      return J({ run: r.run, question: r.question, n: 1, lives: 3, score: 0 });
    }

    if (route === 'POST endless/answer') {
      const c = String(body.choice || '');
      if (!/^[ABCD]$/.test(c)) return bad('Jawaban tidak valid');
      // sesi + kunci jawaban + kandidat soal berikutnya dalam satu query
      const [r] = await sql`select r.id, r.lives, r.score, r.correct, r.n, r.cur, r.done, r.asked, q.answer,
          (select to_jsonb(x) from (select id, q, a, b, c, d from questions where id <> all(r.asked) order by random() limit 1) x) as nxt
        from endless_runs r left join questions q on q.id = r.cur
        where r.id = ${+body.run || 0} and r.user_id = ${uid}`;
      if (!r || r.done) return bad('Sesi endless sudah berakhir', 409);
      if (!r.answer) return bad('Soal tidak ditemukan', 404);
      const ok = r.answer === c, pts = ok ? 10 * Math.ceil(r.n / 10) : 0;
      const lives = r.lives - (ok ? 0 : 1), score = r.score + pts, correct = r.correct + (ok ? 1 : 0);
      const next = lives > 0 ? r.nxt : null;
      const over = !next, n = next ? r.n + 1 : r.n;
      // satu round trip: update (dijaga dengan cur/done) + catat percobaan dari kondisi terbaru di DB.
      // Percobaan dibaca dari baris sesi itu sendiri, jadi dua request bersamaan tidak bisa saling menimpa.
      const [upd] = await sql.transaction([
        sql`update endless_runs set lives = ${lives}, score = ${score}, correct = ${correct}, n = ${n},
          asked = ${next ? [...r.asked, next.id] : r.asked}::int[], cur = ${next ? next.id : null}, done = ${over}
          where id = ${r.id} and cur = ${r.cur} and not done returning id`,
        sql`insert into attempts (user_id, jilid, level, total, correct, score, nonce)
          select user_id, 0, 'endless', case when done then n else n - 1 end, correct, score, 'endless-' || id
          from endless_runs where id = ${r.id}
          on conflict (nonce) do update set total = excluded.total, correct = excluded.correct, score = excluded.score`]);
      if (!upd.length) return bad('Jawaban ini sudah dikirim', 409);
      LB.clear();
      return J({ ok, answer: r.answer, pts, lives, score, correct, next, over, cleared: over && lives > 0 });
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
      const needFx = fx > 0 && u.role !== 'admin' && fx !== u.fx; // admin bebas; efek yang sudah dipakai tak perlu dicek ulang
      const qs = [sql`select 1 from users where lower(username) = lower(${un}) and id <> ${u.id} limit 1`];
      if (needFx) qs.push(bestOf(u.id), sql`select least(ceil(coalesce(max(n), 0) / 10.0), 7)::int as s from endless_runs where user_id = ${u.id}`);
      const [dup, best, st] = await sql.transaction(qs);
      if (dup.length) return bad('Username sudah dipakai', 409);
      if (needFx && fx > jilidDone(best).filter(Boolean).length + st[0].s) return bad('Efek ini belum terbuka', 403);
      try { await sql`update users set username = ${un}, avatar = ${av}, fx = ${fx} where id = ${u.id}`; }
      catch (e) { if (e.code === '23505') return bad('Username sudah dipakai', 409); throw e; }
      LB.clear();
      return J({ username: un, avatar: av, fx });
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
          select rank() over (order by sum(xp) desc)::int as rank, u.id, u.username, u.avatar, u.role, u.fx as pick,
                 sum(xp)::int as total, (count(distinct jilid) filter (where jilid > 0))::int as jilids
          from best join users u on u.id = best.user_id group by u.id, u.username, u.avatar, u.role, u.fx)
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

    // ---------- Khusus admin ----------
    const u = await getUser();
    if (!u) return bad('Silakan masuk dulu', 401);
    if (u.role !== 'admin') return bad('Khusus admin', 403);

    if (route === 'GET admin/stats') {
      const q = await sql`select jilid, count(*)::int n from questions group by jilid`;
      const [c] = await sql`select (select count(*) from users where role = 'student')::int users, (select count(*) from attempts)::int attempts`;
      return J({ q: Object.fromEntries(q.map(r => [r.jilid, r.n])), ...c });
    }

    if (route === 'POST admin/questions') {
      const rows = body.rows;
      if (!Array.isArray(rows) || !rows.length || rows.length > 2000) return bad('Data soal kosong atau lebih dari 2000 baris');
      for (const [i, r] of rows.entries()) {
        const ok = [1, 2, 3, 4].includes(r.jilid) && [r.q, r.a, r.b, r.c, r.d].every(x => typeof x === 'string' && x) &&
          typeof r.answer === 'string' && /^[ABCD]$/.test(r.answer);
        if (!ok) return bad(`Baris ${i + 2} tidak valid (jilid 1–4, semua kolom terisi, jawaban A–D)`);
      }
      const ins = sql`insert into questions (jilid, q, a, b, c, d, answer)
        select * from unnest(${rows.map(r => r.jilid)}::int[], ${rows.map(r => r.q)}::text[], ${rows.map(r => r.a)}::text[],
          ${rows.map(r => r.b)}::text[], ${rows.map(r => r.c)}::text[], ${rows.map(r => r.d)}::text[], ${rows.map(r => r.answer)}::text[])`;
      if (body.replace) await sql.transaction([sql`delete from questions where jilid = any(${[...new Set(rows.map(r => r.jilid))]})`, ins]);
      else await ins;
      return J({ added: rows.length });
    }

    if (route === 'GET admin/questions') {
      const j = +url.searchParams.get('jilid') || 0, q = (url.searchParams.get('q') || '').trim().slice(0, 60);
      const off = Math.max(0, +url.searchParams.get('offset') || 0), like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
      const rows = await sql`select id, jilid, q, a, b, c, d, answer from questions
        where (${j}::int = 0 or jilid = ${j}::int) and (${q}::text = '' or q ilike ${like})
        order by jilid, id limit 30 offset ${off}`;
      const [{ n }] = await sql`select count(*)::int n from questions where (${j}::int = 0 or jilid = ${j}::int) and (${q}::text = '' or q ilike ${like})`;
      return J({ rows, total: n });
    }

    if (route === 'POST admin/question-save') {
      const id = +body.id || 0, j = +body.jilid, f = ['q', 'a', 'b', 'c', 'd'].map(k => String(body[k] ?? '').trim()), ans = String(body.answer || '').toUpperCase();
      if (![1, 2, 3, 4].includes(j) || f.some(x => !x) || !/^[ABCD]$/.test(ans)) return bad('Jilid 1–4, semua kolom terisi, jawaban A–D');
      if (id) {
        const r = await sql`update questions set jilid = ${j}, q = ${f[0]}, a = ${f[1]}, b = ${f[2]}, c = ${f[3]}, d = ${f[4]}, answer = ${ans} where id = ${id} returning id`;
        if (!r.length) return bad('Soal tidak ditemukan', 404);
      } else await sql`insert into questions (jilid, q, a, b, c, d, answer) values (${j}, ${f[0]}, ${f[1]}, ${f[2]}, ${f[3]}, ${f[4]}, ${ans})`;
      return J({ ok: true });
    }

    if (route === 'POST admin/question-delete') {
      const ids = [].concat(body.ids ?? body.id ?? []).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 500);
      if (!ids.length) return bad('Tidak ada soal dipilih');
      try { await sql`delete from questions where id = any(${ids}::int[])`; }
      catch (e) { if (e.code === '23503') return bad('Soal masih terhubung ke data lain', 409); throw e; }
      return J({ deleted: ids.length });
    }

    if (route === 'GET admin/users') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 30);
      const users = await sql`
        select u.id, u.username, u.role,
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
