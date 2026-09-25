require('dotenv').config();
const mongoose = require('mongoose');

const WANT = ['noel', 'coach', 'test'];

function pick(users, key) {
  const re = new RegExp(`^${key}$`, 'i');
  return (
    users.find((u) => re.test(String(u.username || ''))) ||
    users.find((u) => re.test(String(u.name || ''))) ||
    null
  );
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const users = await mongoose.connection.collection('users').find({}).project({ name: 1, username: 1, avatar: 1 }).toArray();
  let chosen = WANT.map((key) => ({ key, user: pick(users, key) }));
  if (!chosen.find((row) => row.key === 'coach')?.user) {
    const inserted = await mongoose.connection.collection('users').insertOne({
      email: 'coach.preview@powerlifting.local',
      username: 'coach',
      name: 'Coach',
      gender: 'hombre',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    chosen = chosen.map((row) =>
      row.key === 'coach'
        ? { key: 'coach', user: { _id: inserted.insertedId, username: 'coach', name: 'Coach', avatar: '' } }
        : row
    );
  }
  const missing = chosen.filter((row) => !row.user).map((row) => row.key);
  if (missing.length) {
    console.log('MISSING', missing.join(','));
    console.log('HAVE', users.map((u) => u.username || u.name).filter(Boolean).slice(0, 30).join(','));
    await mongoose.disconnect();
    process.exit(1);
  }
  const marks = {
    noel: { sq: 180, bp: 120, dl: 220, bw: 83, g: 'hombre' },
    coach: { sq: 160, bp: 110, dl: 200, bw: 90, g: 'hombre' },
    test: { sq: 140, bp: 95, dl: 180, bw: 74, g: 'hombre' },
  };
  const gl = {
    hombre: { a: 1236.25115, b: 1449.21864, c: 0.01644 },
    mujer: { a: 758.63878, b: 949.31382, c: 0.02435 },
  };
  const points = (total, bw, g) => {
    const c = gl[g] || gl.hombre;
    const den = c.a - c.b * Math.exp(-c.c * (bw > 0 ? bw : 80));
    return Math.round((100 / den) * total * 100) / 100;
  };
  const participants = chosen.map(({ key, user }) => {
    const m = marks[key];
    const total = m.sq + m.bp + m.dl;
    const score = points(total, m.bw, m.g);
    return {
      userId: user._id,
      name: user.name || user.username || key,
      avatar: user.avatar || '',
      score,
      value: total,
      lifts: [
        { exercise: 'Sentadilla', value: m.sq },
        { exercise: 'Press banca', value: m.bp },
        { exercise: 'Peso muerto', value: m.dl },
      ],
      attempts: {
        squat: [m.sq - 10, m.sq, 0],
        bench: [m.bp - 5, m.bp, 0],
        deadlift: [m.dl - 10, m.dl, 0],
      },
      initialValue: total,
      initialScore: score,
      initialRank: 1,
      joinedAt: new Date(Date.now() - 3 * 86400000),
    };
  });
  const creator = chosen.find((row) => row.key === 'noel').user;
  const title = 'Competición de prueba';
  await mongoose.connection.collection('challenges').deleteMany({ title, meet: true, description: 'vista-podio' });
  await mongoose.connection.collection('challenges').insertOne({
    createdBy: creator._id,
    title,
    description: 'vista-podio',
    type: 'weight',
    exercise: 'Sentadilla · Press banca · Peso muerto',
    exercises: ['Sentadilla', 'Press banca', 'Peso muerto'],
    isPrivate: false,
    closeFriendsOnly: false,
    passwordHash: '',
    usePointsSystem: true,
    bodyWeightScoring: 'heavier_more',
    meet: true,
    endingSoonNotifiedAt: new Date(),
    winnerNotifiedAt: new Date(),
    participants,
    endDate: new Date(Date.now() - 60 * 60 * 1000),
    createdAt: new Date(Date.now() - 4 * 86400000),
    updatedAt: new Date(),
  });
  console.log('SEEDED', chosen.map((row) => row.user.name || row.user.username).join(','));
  await mongoose.disconnect();
})().catch((err) => {
  console.error('SEED_FAIL', err.message);
  process.exit(1);
});
