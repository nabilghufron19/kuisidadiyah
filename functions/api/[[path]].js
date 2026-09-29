import { neon } from '@neondatabase/serverless';

const enc = new TextEncoder();
const b64 = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
const bad = (m, s = 400) => J({ error: m }, s);
const hmacKey = s => crypto.subtle.importKey('raw', enc.encode(s), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

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
  const auth = async () => {
    const p = await verify((request.headers.get('Authorization') || '').slice(7), S);
    if (!p || p.k !== 'auth') return null;
    return (await sql`select id, username, role, avatar from users where id = ${p.uid}`)[0] || null;
  };
  const authToken = id => sign({ k: 'auth', uid: id, exp: Date.now() + 6048e5 }, S);

  try {
    // ---------- Daftar & masuk ----------
    if (route === 'POST register') {
      const un = String(body.username || ''), pw = String(body.password || '');
      if (!/^[A-Za-z0-9_]{3,20}$/.test(un)) return bad('Username 3–20 karakter: huruf, angka, atau _');
      if (pw.length < 6) return bad('Password minimal 6 karakter');
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
    const u = await auth();
    if (!u) return bad('Silakan masuk dulu', 401);

    if (route === 'GET me') {
      const best = await sql`select jilid, level, max(case when level = 'endless' then score::numeric else round((case level when 'easy' then 100 when 'medium' then 200 else 300 end) * correct::numeric / total) end)::int xp
        from attempts where user_id = ${u.id} group by jilid, level`;
      const [t] = await sql`select least(ceil(coalesce(max(n), 0) / 10.0), 7)::int as s from endless_runs where user_id = ${u.id}`;
      return J({ username: u.username, role: u.role, avatar: u.avatar, tstage: t.s, best: Object.fromEntries(best.map(r => [r.jilid + ':' + r.level, r.xp])) });
    }

    if (route === 'GET quiz') {
      const j = +url.searchParams.get('jilid'), l = url.searchParams.get('level');
      const n = { easy: 10, medium: 20, hard: 30 }[l];
      if (!(j >= 1 && j <= 4) || !n) return bad('Pilihan tidak valid');
      const qs = await sql`select id, q, a, b, c, d from questions where jilid = ${j} order by random() limit ${n}`;
      if (!qs.length) return bad('Belum ada soal untuk jilid ini');
      const token = await sign({ k: 'quiz', uid: u.id, j, l, ids: qs.map(x => x.id), nonce: crypto.randomUUID(), exp: Date.now() + 72e5 }, S);
      return J({ questions: qs, token });
    }

    if (route === 'POST check') {
      const t = await verify(String(body.token || ''), S);
      if (!t || t.k !== 'quiz' || t.uid !== u.id) return bad('Sesi kuis tidak valid atau kedaluwarsa');
      const id = +body.id, c = String(body.choice || '');
      if (!t.ids.includes(id) || !/^[ABCD]$/.test(c)) return bad('Jawaban tidak valid');
      const [r] = await sql`select answer from questions where id = ${id}`;
      if (!r) return bad('Soal tidak ditemukan');
      const ok = r.answer === c;
      const ins = await sql`insert into quiz_answers (nonce, qid, ok) values (${t.nonce}, ${id}, ${ok}) on conflict do nothing returning qid`;
      if (!ins.length) return bad('Soal ini sudah dijawab', 409);
      return J({ ok, answer: r.answer });
    }

    if (route === 'POST submit') {
      const t = await verify(String(body.token || ''), S);
      if (!t || t.k !== 'quiz' || t.uid !== u.id) return bad('Sesi kuis tidak valid atau kedaluwarsa');
      const total = t.ids.length, XP = { easy: 100, medium: 200, hard: 300 };
      const [{ n }] = await sql`select count(*)::int n from quiz_answers where nonce = ${t.nonce} and ok`;
      const score = Math.round(n * 100 / total), xp = Math.round(XP[t.l] * n / total);
      try {
        await sql`insert into attempts (user_id, jilid, level, total, correct, score, nonce) values (${u.id}, ${t.j}, ${t.l}, ${total}, ${n}, ${score}, ${t.nonce})`;
      } catch (e) {
        if (e.code === '23505') return bad('Kuis ini sudah pernah dikirim', 409);
        throw e;
      }
      return J({ correct: n, total, score, xp });
    }

    if (route === 'POST endless/start') {
      const [q] = await sql`select id, q, a, b, c, d from questions order by random() limit 1`;
      if (!q) return bad('Belum ada soal');
      const [r] = await sql`insert into endless_runs (user_id, asked, n, cur) values (${u.id}, ${[q.id]}::int[], 1, ${q.id}) returning id`;
      return J({ run: r.id, question: q, n: 1, lives: 3, score: 0 });
    }

    if (route === 'POST endless/answer') {
      const c = String(body.choice || '');
      if (!/^[ABCD]$/.test(c)) return bad('Jawaban tidak valid');
      const [r] = await sql`select * from endless_runs where id = ${+body.run || 0} and user_id = ${u.id}`;
      if (!r || r.done) return bad('Sesi endless sudah berakhir', 409);
      const [q] = await sql`select answer from questions where id = ${r.cur}`;
      if (!q) return bad('Soal tidak ditemukan', 404);
      const ok = q.answer === c, pts = ok ? 10 * Math.ceil(r.n / 10) : 0;
      const lives = r.lives - (ok ? 0 : 1), score = r.score + pts, correct = r.correct + (ok ? 1 : 0);
      let next = null;
      if (lives > 0) [next] = await sql`select id, q, a, b, c, d from questions where id <> all(${r.asked}::int[]) order by random() limit 1`;
      const over = !next, n = next ? r.n + 1 : r.n;
      const upd = await sql`update endless_runs set lives = ${lives}, score = ${score}, correct = ${correct}, n = ${n},
        asked = ${next ? [...r.asked, next.id] : r.asked}::int[], cur = ${next ? next.id : null}, done = ${over}
        where id = ${r.id} and cur = ${r.cur} and not done returning id`;
      if (!upd.length) return bad('Jawaban ini sudah dikirim', 409);
      await sql`insert into attempts (user_id, jilid, level, total, correct, score, nonce)
        values (${u.id}, 0, 'endless', ${r.n}, ${correct}, ${score}, ${'endless-' + r.id})
        on conflict (nonce) do update set total = excluded.total, correct = excluded.correct, score = excluded.score`;
      return J({ ok, answer: q.answer, pts, lives, score, correct, next, over, cleared: over && lives > 0 });
    }

    if (route === 'POST profile') {
      const un = String(body.username ?? u.username).trim(), av = String(body.avatar ?? u.avatar);
      if (!/^[A-Za-z0-9_]{3,20}$/.test(un)) return bad('Username 3–20 karakter: huruf, angka, atau _');
      if (!/^a([1-9]|1[0-2])$/.test(av)) return bad('Foto tidak valid');
      try { await sql`update users set username = ${un}, avatar = ${av} where id = ${u.id}`; }
      catch (e) { if (e.code === '23505') return bad('Username sudah dipakai', 409); throw e; }
      return J({ username: un, avatar: av });
    }

    if (route === 'GET leaderboard') {
      const j = +url.searchParams.get('jilid') || 0;
      const q = (url.searchParams.get('q') || '').trim().slice(0, 30);
      const rows = await sql`
        with best as (
          select user_id, jilid, level,
                 max(case when level = 'endless' then score::numeric else round((case level when 'easy' then 100 when 'medium' then 200 else 300 end) * correct::numeric / total) end)::int xp
          from attempts where case when ${j}::int = 0 then true when ${j}::int = 5 then level = 'endless' else jilid = ${j}::int end group by 1, 2, 3),
        ranked as (
          select rank() over (order by sum(xp) desc)::int as rank, u.username, u.avatar,
                 sum(xp)::int as total, (count(distinct jilid) filter (where jilid > 0))::int as jilids
          from best join users u on u.id = best.user_id group by u.username, u.avatar)
        select * from ranked
        where ${q}::text = '' or strpos(lower(username), lower(${q}::text)) > 0
        order by rank, username limit 100`;
      return J({ rows });
    }

    // ---------- Khusus admin ----------
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
      return J({ ok: true });
    }

    return bad('Tidak ditemukan', 404);
  } catch (e) {
    console.error(e);
    return bad('Kesalahan server', 500);
  }
}
