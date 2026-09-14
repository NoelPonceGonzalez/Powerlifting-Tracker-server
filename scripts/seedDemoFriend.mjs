/**
 * Crea (o rehace) un amigo de mentira con publicaciones, historia y marcas para ver el
 * perfil lleno. Uso:  node scripts/seedDemoFriend.mjs [--remove]
 * Las fotos se descargan de picsum.photos; si no hay internet se generan degradados.
 */
import 'dotenv/config';
import dns from 'node:dns';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

dns.setServers(['1.1.1.1', '8.8.8.8']);

const DEMO_EMAIL = 'marta.demo@powerlifting.app';
const MEDIA_ROOT = resolve(process.env.MEDIA_LOCAL_DIR || join(process.cwd(), 'uploads'));

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** PNG con un degradado: sirve de reserva cuando no se pueden descargar fotos. */
function gradientPng(width, height, from, to) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    const t = y / (height - 1);
    for (let x = 0; x < width; x++) {
      const s = (x / (width - 1)) * 0.35 + t * 0.65;
      raw[p++] = Math.round(from[0] + (to[0] - from[0]) * s);
      raw[p++] = Math.round(from[1] + (to[1] - from[1]) * s);
      raw[p++] = Math.round(from[2] + (to[2] - from[2]) * s);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function loadPhoto(seed, fallback) {
  try {
    const res = await fetch(`https://picsum.photos/seed/${seed}/900/1100`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const type = res.headers.get('content-type') || 'image/jpeg';
      return { buffer: Buffer.from(await res.arrayBuffer()), mime: type.includes('png') ? 'image/png' : 'image/jpeg' };
    }
  } catch {
    /* sin internet: degradado */
  }
  return { buffer: gradientPng(600, 750, fallback[0], fallback[1]), mime: 'image/png' };
}

function saveMedia(buffer, mime) {
  const ext = mime === 'image/png' ? '.png' : mime === 'video/mp4' ? '.mp4' : '.jpg';
  const now = new Date();
  const folder = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const key = `${folder}/${randomUUID()}${ext}`;
  const full = join(MEDIA_ROOT, key);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, buffer);
  return key;
}

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const users = db.collection('users');
const friendships = db.collection('friendships');
const posts = db.collection('posts');
const comments = db.collection('postcomments');

const existing = await users.findOne({ email: DEMO_EMAIL });
if (existing) {
  await posts.deleteMany({ userId: existing._id });
  await comments.deleteMany({ userId: existing._id });
  await friendships.deleteMany({ $or: [{ requester: existing._id }, { recipient: existing._id }] });
  await users.deleteOne({ _id: existing._id });
  console.log('Usuario de prueba anterior eliminado');
}
if (process.argv.includes('--remove')) {
  await mongoose.disconnect();
  console.log('Listo: sin usuario de prueba');
  process.exit(0);
}

const owner = await users.findOne({ email: { $ne: DEMO_EMAIL }, password: { $exists: true } });
if (!owner) throw new Error('No hay ninguna cuenta real con la que emparejar al usuario de prueba');

const now = new Date();
const demo = {
  email: DEMO_EMAIL,
  username: 'marta_lifts',
  password: await bcrypt.hash(`demo-${randomUUID()}`, 10),
  name: 'Marta Ruiz',
  gender: 'mujer',
  avatar: 'https://ui-avatars.com/api/?name=Marta+Ruiz&background=6366f1&color=fff&size=256',
  bio: 'Powerlifter -63 kg · Entrenando para el autonómico · Sentadilla es mi vida',
  bodyWeight: 62.5,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
};
const { insertedId: demoId } = await users.insertOne(demo);
console.log('Creada Marta Ruiz (@marta_lifts)');

await friendships.insertOne({
  requester: demoId,
  recipient: owner._id,
  status: 'accepted',
  createdAt: now,
  updatedAt: now,
});
console.log(`Ahora es amiga de ${owner.name || owner.email}`);

const PLAN = [
  { seed: 'squat-day', caption: 'Sentadilla 140x3 @8. Las piernas van solas hoy 🔥', hours: 3, likes: 4, mins: 12 },
  { seed: 'bench-pr', caption: 'PR en press banca: 82,5 kg. Un año buscando este número.', hours: 27, likes: 9, mins: 45 },
  { seed: 'deadlift', caption: 'Peso muerto con déficit, 5x3. Espalda destrozada pero contenta.', hours: 52, likes: 6, mins: 20 },
  { seed: 'gym-mirror', caption: 'Semana de descarga, toca cuidarse.', hours: 76, likes: 3, mins: 5 },
  { seed: 'competition', caption: 'Día de competición 💪 total de 375 kg', hours: 120, likes: 15, mins: 90 },
  { seed: 'accessories', caption: 'Accesorios de tirón, hip thrust y a casa.', hours: 150, likes: 2, mins: 8 },
];

const COMMENT_POOL = [
  'Qué bestia 💪',
  'Menuda técnica',
  '¡Enhorabuena por el PR!',
  'Esto es otro nivel',
];

const created = [];
for (const [i, item] of PLAN.entries()) {
  const photo = await loadPhoto(item.seed, [
    [99, 102, 241],
    [244, 114, 182],
  ]);
  const key = saveMedia(photo.buffer, photo.mime);
  const createdAt = new Date(now.getTime() - item.hours * 3600 * 1000 - item.mins * 60 * 1000);
  const doc = {
    userId: demoId,
    kind: 'post',
    mediaType: 'image',
    mediaKey: key,
    mimeType: photo.mime,
    caption: item.caption,
    likes: i % 2 === 0 ? [owner._id] : [],
    commentCount: 0,
    createdAt,
    updatedAt: createdAt,
  };
  const { insertedId } = await posts.insertOne(doc);
  created.push({ id: insertedId, createdAt });
}
console.log(`${created.length} publicaciones subidas`);

// Un par de comentarios suyos para que el hilo no salga vacío.
const target = created[1];
const commentDocs = COMMENT_POOL.slice(0, 2).map((text, i) => ({
  postId: target.id,
  userId: demoId,
  text,
  createdAt: new Date(target.createdAt.getTime() + (i + 1) * 60000),
  updatedAt: new Date(target.createdAt.getTime() + (i + 1) * 60000),
}));
await comments.insertMany(commentDocs);
await posts.updateOne({ _id: target.id }, { $set: { commentCount: commentDocs.length } });

const storyPhoto = await loadPhoto('story-gym', [
  [16, 185, 129],
  [59, 130, 246],
]);
await posts.insertOne({
  userId: demoId,
  kind: 'story',
  mediaType: 'image',
  mediaKey: saveMedia(storyPhoto.buffer, storyPhoto.mime),
  mimeType: storyPhoto.mime,
  caption: 'Calentando para la sentadilla',
  likes: [],
  commentCount: 0,
  expiresAt: new Date(now.getTime() + 22 * 3600 * 1000),
  createdAt: new Date(now.getTime() - 2 * 3600 * 1000),
  updatedAt: now,
});
console.log('Historia activa creada (caduca en 22 h)');

// Rutina con marcas compartidas: así la pestaña «Marcas» del perfil no sale vacía.
const routines = db.collection('routines');
const trainingMaxes = db.collection('trainingmaxes');
const { insertedId: routineId } = await routines.insertOne({
  userId: demoId,
  name: 'Bloque de fuerza',
  isActive: true,
  cycleLength: 4,
  sameTemplateAllWeeks: false,
  createdAt: now,
  updatedAt: now,
});
await trainingMaxes.insertMany(
  [
    ['Squat', 150],
    ['Bench', 85],
    ['Deadlift', 175],
  ].map(([name, value]) => ({
    userId: demoId,
    routineId,
    name,
    value,
    mode: 'weight',
    sharedToSocial: true,
    createdAt: now,
    updatedAt: now,
  }))
);
console.log('Marcas compartidas: Squat 150 · Bench 85 · Deadlift 175');

await mongoose.disconnect();
console.log('\nListo. Entra en Social → Perfil y búscala como «Marta».');
console.log('Para borrarla: node scripts/seedDemoFriend.mjs --remove');
