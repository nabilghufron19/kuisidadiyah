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
    return (await sql`select id, username, role from users where id = ${p.uid}`)[0] || null;
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
      const best = await sql`select jilid, level, max(round((case level when 'easy' then 100 when 'medium' then 200 else 300 end) * correct::numeric / total))::int xp
        from attempts where user_id = ${u.id} group by jilid, level`;
      return J({ username: u.username, role: u.role, best: Object.fromEntries(best.map(r => [r.jilid + ':' + r.level, r.xp])) });
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

    if (route === 'GET leaderboard') {
      const j = +url.searchParams.get('jilid') || 0;
      const q = (url.searchParams.get('q') || '').trim().slice(0, 30);
      const rows = await sql`
        with best as (
          select user_id, jilid, level,
                 max(round((case level when 'easy' then 100 when 'medium' then 200 else 300 end) * correct::numeric / total))::int xp
          from attempts where ${j}::int = 0 or jilid = ${j}::int group by 1, 2, 3),
        ranked as (
          select rank() over (order by sum(xp) desc)::int as rank, u.username,
                 sum(xp)::int as total, count(distinct jilid)::int as jilids
          from best join users u on u.id = best.user_id group by u.username)
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
            select max(round((case level when 'easy' then 100 when 'medium' then 200 else 300 end) * correct::numeric / total)) x
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
