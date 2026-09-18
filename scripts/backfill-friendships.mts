import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';
import mongoose from 'mongoose';
import { backfillLegacyMutualFriendships } from '../src/utils/migrateFriendships';

loadEnv({ path: resolve(process.cwd(), '.env') });

const uri = process.env.MONGODB_URI?.trim();
if (!uri) {
  console.error('Sin MONGODB_URI');
  process.exit(1);
}

await mongoose.connect(uri, { serverSelectionTimeoutMS: 12000 });
await backfillLegacyMutualFriendships();
console.log('backfill ok');
await mongoose.disconnect();
