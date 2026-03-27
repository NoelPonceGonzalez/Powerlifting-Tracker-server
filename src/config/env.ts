import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  jwtSecret: process.env.JWT_SECRET || 'powerlifting-super-secret-jwt-key-2026',
  mongodbUri: process.env.MONGODB_URI || 'mongodb+srv://root:OM5efz85AL4SB4Ad@power.ax8gn87.mongodb.net/?appName=Power',
  email: {
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT || '587'),
    user: process.env.EMAIL_USER || 'noel.ponce.gonzalez@gmail.com',
    pass: process.env.EMAIL_PASS || 'osam pwxk watx ensq',
    from: process.env.EMAIL_FROM || 'noreply@powerliftingtracker.com',
  },
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  mobileAppScheme: process.env.MOBILE_APP_SCHEME || 'powerliftingtracker',
};
