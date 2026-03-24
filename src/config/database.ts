import mongoose from 'mongoose';
import { config } from './env';

export const connectDB = async (): Promise<void> => {
  try {
    await mongoose.connect(config.mongodbUri);
    console.log('✅ MongoDB conectado exitosamente');
    console.log(`   Base de datos: ${mongoose.connection.name}`);
  } catch (error) {
    console.error('❌ Error conectando a MongoDB:', error);
    process.exit(1);
  }
};

export default mongoose.connection;
