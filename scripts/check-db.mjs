// Comprueba que la cadena de MONGODB_URI conecta y lista las colecciones con documentos.
// Uso: node scripts/check-db.mjs
import 'dotenv/config';
import dns from 'dns';
import mongoose from 'mongoose';

// El DNS local (127.0.0.1) rechaza SRV, que es lo que usa mongodb+srv://.
dns.setServers(['1.1.1.1', '8.8.8.8']);

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('Falta MONGODB_URI en server/.env');
  process.exit(1);
}

try {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  console.log(`OK conectado -> base de datos "${db.databaseName}"`);

  const collections = await db.listCollections().toArray();
  if (collections.length === 0) {
    console.log('La base de datos está vacía (0 colecciones).');
  } else {
    for (const c of collections.sort((a, b) => a.name.localeCompare(b.name))) {
      const count = await db.collection(c.name).countDocuments();
      console.log(`  ${c.name}: ${count}`);
    }
  }
  await mongoose.disconnect();
  process.exit(0);
} catch (err) {
  console.error(`FALLO: ${err.message}`);
  process.exit(1);
}
