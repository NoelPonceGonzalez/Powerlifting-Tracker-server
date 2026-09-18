import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';
import mongoose from 'mongoose';
import { Notification, type NotificationType } from '../src/models/Notification';
import { User } from '../src/models/User';
import { sendPushToUser } from '../src/utils/push';

loadEnv({ path: resolve(process.cwd(), '.env') });

const uri = process.env.MONGODB_URI?.trim();
if (!uri) {
  console.error('Sin MONGODB_URI');
  process.exit(1);
}

await mongoose.connect(uri, { serverSelectionTimeoutMS: 12000 });

const noel =
  (await User.findOne({ username: /^noel$/i }).select('name email username pushTokens webPushSubscriptions')) ||
  (await User.findOne({ name: /^noel/i }).select('name email username pushTokens webPushSubscriptions')) ||
  (await User.findOne({ email: /noel/i }).select('name email username pushTokens webPushSubscriptions'));

if (!noel) {
  console.error('No encuentro al usuario Noel');
  await mongoose.disconnect();
  process.exit(1);
}

const from =
  (await User.findOne({
    _id: { $ne: noel._id },
    name: { $in: ['Valentina', 'María', 'Maria'] },
  }).select('name')) ||
  (await User.findOne({ _id: { $ne: noel._id } }).select('name'));

const fromId = from?._id ? String(from._id) : undefined;
const fromName = from?.name || 'Valentina';
const toId = String(noel._id);

const expo = (noel.pushTokens || []).length;
const web = (noel.webPushSubscriptions || []).length;
console.log(`Noel: ${noel.name || noel.username} ${noel.email} (${toId})`);
console.log(`Canales: Expo=${expo} WebPush=${web}`);
console.log(`Desde: ${fromName}`);

const samples: Array<{
  type: NotificationType;
  title: string;
  message: string;
  relatedData?: Record<string, unknown>;
}> = [
  { type: 'gym_checkin', title: `${fromName} va a entrenar`, message: 'Box Central a las 19:00' },
  { type: 'friend_request', title: `${fromName} te ha enviado una solicitud`, message: 'Toca para ver la solicitud de seguimiento' },
  { type: 'friend_accepted', title: `${fromName} ahora te sigue`, message: `${fromName} ahora te sigue`, relatedData: { kind: 'new_follower' } },
  { type: 'new_rm', title: `${fromName} ha batido su RM`, message: 'Sentadilla: 120 kg (antes 115 kg)' },
  { type: 'post_like', title: 'Nuevo me gusta', message: `A ${fromName} le gusta tu historia` },
  { type: 'post_comment', title: 'Historia', message: `${fromName} ha respondido a tu historia` },
  { type: 'post_comment_reply', title: 'Respuesta a tu comentario', message: `${fromName} ha respondido: ¡Brutal!` },
  { type: 'coach_request', title: 'Te piden ser entrenador', message: `${fromName} quiere que seas su entrenador` },
  { type: 'coach_accepted', title: 'Entrenador confirmado', message: `${fromName} te ha aceptado como entrenador` },
  { type: 'group_invite', title: `${fromName} te invita a «Competición»`, message: 'Acepta para entrar al grupo' },
  { type: 'chat_request', title: `${fromName} quiere chatear`, message: 'Acepta para poder hablar' },
  { type: 'chat_message', title: `${fromName} te ha escrito`, message: '¿Entrenamos juntos esta tarde?' },
  { type: 'challenge_invite', title: 'Nuevo torneo creado', message: `${fromName} ha creado «Press banca semanal»` },
  { type: 'challenge_join', title: `${fromName} se ha unido a tu torneo`, message: '«Press banca semanal»' },
  { type: 'challenge_winner', title: 'Torneo finalizado: «Press banca semanal»', message: `Ganador: ${fromName}.` },
];

for (const sample of samples) {
  await Notification.create({
    userId: toId,
    type: sample.type,
    title: sample.title,
    message: sample.message,
    relatedUserId: fromId,
    relatedData: sample.relatedData,
    read: false,
  });
  await sendPushToUser(toId, sample.title, sample.message, {
    type: sample.type,
    relatedUserId: fromId,
    ...(sample.relatedData || {}),
  });
  console.log(`OK ${sample.type}: ${sample.title}`);
}

console.log(`Enviados ${samples.length} avisos a Noel`);
await mongoose.disconnect();
