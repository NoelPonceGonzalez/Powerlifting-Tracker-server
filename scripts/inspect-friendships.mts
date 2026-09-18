import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';
import mongoose from 'mongoose';

loadEnv({ path: resolve(process.cwd(), '.env') });

const uri = process.env.MONGODB_URI?.trim();
if (!uri) {
  console.error('Sin MONGODB_URI');
  process.exit(1);
}

await mongoose.connect(uri, { serverSelectionTimeoutMS: 12000 });
const col = mongoose.connection.db!.collection('friendships');

const total = await col.countDocuments();
const byStatus = await col.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
const followOnly = await col.aggregate([
  { $group: { _id: { status: '$status', followOnly: '$followOnly' }, n: { $sum: 1 } } },
]).toArray();

const accepted = await col.find({ status: 'accepted' }).project({ requester: 1, recipient: 1, followOnly: 1, createdAt: 1, updatedAt: 1 }).toArray();

const pairKey = (a: unknown, b: unknown) => {
  const x = String(a);
  const y = String(b);
  return x < y ? `${x}|${y}` : `${y}|${x}`;
};

const pairs = new Map<string, typeof accepted>();
for (const row of accepted) {
  const k = pairKey(row.requester, row.recipient);
  const list = pairs.get(k) ?? [];
  list.push(row);
  pairs.set(k, list);
}

let oneWay = 0;
let twoWay = 0;
let oneWayFollowOnly = 0;
let oneWayLegacy = 0;
const oldest: Date[] = [];
const newest: Date[] = [];

for (const list of pairs.values()) {
  const dirs = new Set(list.map(r => `${r.requester}>${r.recipient}`));
  if (dirs.size >= 2) {
    twoWay += 1;
  } else {
    oneWay += 1;
    const fo = list.some(r => r.followOnly === true);
    if (fo) oneWayFollowOnly += 1;
    else oneWayLegacy += 1;
  }
  for (const r of list) {
    if (r.createdAt) {
      oldest.push(new Date(r.createdAt));
      newest.push(new Date(r.createdAt));
    }
  }
}

oldest.sort((a, b) => a.getTime() - b.getTime());
newest.sort((a, b) => b.getTime() - a.getTime());

console.log(JSON.stringify({
  db: mongoose.connection.name,
  total,
  byStatus,
  followOnly,
  acceptedCount: accepted.length,
  uniquePairs: pairs.size,
  twoWayPairs: twoWay,
  oneWayPairs: oneWay,
  oneWayLegacy,
  oneWayFollowOnly,
  oldestAccepted: oldest[0]?.toISOString() ?? null,
  newestAccepted: newest[0]?.toISOString() ?? null,
}, null, 2));

await mongoose.disconnect();
