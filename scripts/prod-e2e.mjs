/**
 * Prueba de punta a punta contra el API local (127.0.0.1:3000).
 * Crea una cuenta, ejercita auth/rutina/TM/social/chat/torneo/gym/perfil.
 */
import { MongoClient } from 'mongodb';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const BASE = process.env.API_BASE || 'http://127.0.0.1:3000';
const PASS = 'Test1234!';
const failures = [];
const notes = [];

function loadEnv() {
  const raw = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    out[t.slice(0, i)] = t.slice(i + 1);
  }
  return out;
}

async function req(method, path, { token, json, form } = {}) {
  const headers = {};
  const opts = { method, headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  }
  if (form) opts.body = form;
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* raw */
  }
  return { status: res.status, body, text };
}

function expect(name, cond, extra) {
  if (cond) {
    console.log(`OK   ${name}`);
    return true;
  }
  const msg = extra !== undefined ? ` :: ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : '';
  console.log(`FAIL ${name}${msg}`);
  failures.push(name);
  return false;
}

async function pendingCode(uri, email) {
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const dbName = new URL(uri).pathname.replace(/^\//, '').split('?')[0] || 'powerlifting';
    const db = client.db(dbName);
    const doc = await db.collection('pendingsignups').findOne({ email });
    return doc?.verificationToken || null;
  } finally {
    await client.close();
  }
}

async function main() {
  const env = loadEnv();
  const stamp = Date.now();
  const email = `e2e.prod.${stamp}@gmail.com`;

  const health = await req('GET', '/health');
  expect('health', health.status === 200 && health.body?.status === 'ok', health.body);

  const loginA = await req('POST', '/api/auth/login', {
    json: { username: 'atletaprueba', password: PASS },
  });
  const loginC = await req('POST', '/api/auth/login', {
    json: { username: 'coachprueba', password: PASS },
  });
  expect('login atletaprueba', loginA.status === 200 && !!loginA.body?.token, loginA.body);
  expect('login coachprueba', loginC.status === 200 && !!loginC.body?.token, loginC.body);

  const tokenA = loginA.body?.token;
  const tokenC = loginC.body?.token;
  const idA = loginA.body?.user?.id;
  const idC = loginC.body?.user?.id;

  if (tokenA) {
    const me = await req('GET', '/api/auth/me', { token: tokenA });
    expect('auth/me', me.status === 200 && !!me.body?.id, me.body);
  }

  const reg = await req('POST', '/api/auth/register', { json: { email } });
  expect('register envía código', reg.status === 201 && reg.body?.requiresCode === true, reg.body);

  let code = null;
  if (env.MONGODB_URI) {
    try {
      code = await pendingCode(env.MONGODB_URI, email);
    } catch (e) {
      notes.push(`mongo code: ${e.message}`);
    }
  }
  expect('código en pending signup', !!code, code);

  let tokenNew = null;
  let idNew = null;
  if (code) {
    const ver = await req('POST', '/api/auth/verify-registration-code', { json: { email, code } });
    expect('verify-registration-code', ver.status === 200, ver.body);
    const complete = await req('POST', '/api/auth/complete-registration', {
      json: {
        token: code,
        name: `E2E Prod ${stamp}`,
        bodyWeight: 90,
        password: PASS,
        gender: 'hombre',
      },
    });
    expect('complete-registration', complete.status === 200 && !!complete.body?.token, complete.body);
    tokenNew = complete.body?.token;
    idNew = complete.body?.user?.id;
    notes.push(`cuenta nueva: ${complete.body?.user?.username || email} / ${PASS}`);
  }

  const actor = tokenNew || tokenA;
  if (!actor) {
    console.log('\nSin token de usuario; se corta el resto.');
    process.exit(1);
  }

  const routines0 = await req('GET', '/api/routines', { token: actor });
  expect('GET routines', routines0.status === 200 && Array.isArray(routines0.body), routines0.body);

  const created = await req('POST', '/api/routines', {
    token: actor,
    json: {
      name: `Ciclo E2E ${stamp}`,
      cycleLength: 4,
      sameTemplateAllWeeks: true,
      weeks: [
        {
          weekNumber: 1,
          days: [
            {
              dayNumber: 1,
              name: 'Sentadilla',
              exercises: [{ name: 'Sentadilla', sets: 3, reps: 5 }],
            },
          ],
        },
      ],
    },
  });
  expect('POST routine', created.status === 201 && !!(created.body?.id || created.body?._id), created.body);
  const routineId = created.body?.id || created.body?._id;

  if (routineId) {
    const tm = await req('POST', '/api/training-maxes', {
      token: actor,
      json: { routineId, name: 'Sentadilla', value: 180, mode: 'weight' },
    });
    expect('POST training-max', tm.status === 201 && !!(tm.body?._id || tm.body?.id), tm.body);
  }

  const feed = await req('GET', '/api/feed', { token: actor });
  expect('GET feed', feed.status === 200, feed.body);

  const friends = await req('GET', '/api/social/friends', { token: actor });
  expect('GET friends', friends.status === 200 && Array.isArray(friends.body), friends.body);

  const search = await req('GET', `/api/social/search?q=coach`, { token: actor });
  expect('GET search', search.status === 200 && Array.isArray(search.body), search.body);

  const suggestions = await req('GET', '/api/social/suggestions', { token: actor });
  expect('GET suggestions', suggestions.status === 200, suggestions.body);

  if (tokenA && tokenC && idA && idC && idA !== idC) {
    const reqF = await req('POST', '/api/social/requests', { token: tokenA, json: { userId: idC } });
    const reqOk = reqF.status === 200 || reqF.status === 201 || (reqF.status === 400 && /ya|existe|pendiente|amigo/i.test(JSON.stringify(reqF.body)));
    expect('POST friend request (o ya amigos)', reqOk, reqF.body);

    const incoming = await req('GET', '/api/social/requests', { token: tokenC });
    expect('GET friend requests', incoming.status === 200, incoming.body);
    const pending = Array.isArray(incoming.body)
      ? incoming.body.find((r) => String(r.requester?.id || r.requester || r.from || '') === String(idA) || String(r.requesterId) === String(idA))
      : null;
    const pendingId = pending?.id || pending?._id;
    if (pendingId) {
      const acc = await req('PUT', `/api/social/requests/${pendingId}/accept`, { token: tokenC });
      expect('accept friend request', acc.status === 200, acc.body);
    } else {
      notes.push('sin solicitud pendiente atleta→coach (quizá ya eran amigos)');
    }

    const chat = await req('POST', `/api/social/chats/${idC}/messages`, {
      token: tokenA,
      json: { text: `e2e hola ${stamp}` },
    });
    expect('POST chat message', chat.status === 200 || chat.status === 201, chat.body);

    const inbox = await req('GET', '/api/social/chats', { token: tokenA });
    expect('GET chats', inbox.status === 200, inbox.body);
  }

  const end = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  const challenge = await req('POST', '/api/challenges', {
    token: actor,
    json: {
      title: `Torneo E2E ${stamp}`,
      type: 'weight',
      exercise: 'Sentadilla',
      endDate: end,
      usePointsSystem: true,
    },
  });
  expect('POST challenge', challenge.status === 201 && !!(challenge.body?.id || challenge.body?._id), challenge.body);

  const challenges = await req('GET', '/api/challenges', { token: actor });
  expect('GET challenges', challenges.status === 200, challenges.body);

  const checkin = await req('POST', '/api/checkins', {
    token: actor,
    json: { gymName: 'Gym E2E', time: '18:30' },
  });
  expect('POST checkin', checkin.status === 200 || checkin.status === 201, checkin.body);

  const checkins = await req('GET', '/api/checkins', { token: actor });
  expect('GET checkins', checkins.status === 200, checkins.body);

  const notif = await req('GET', '/api/notifications', { token: actor });
  expect('GET notifications', notif.status === 200, notif.body);

  const profile = await req('PUT', '/api/auth/me', {
    token: actor,
    json: { bodyWeight: 91 },
  });
  expect('PUT profile weight', profile.status === 200, profile.body);

  console.log('\n--- notas ---');
  for (const n of notes) console.log(n);
  console.log(`\n${failures.length} fallos de ${20} comprobaciones`);
  if (failures.length) {
    console.log(failures.join('\n'));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
