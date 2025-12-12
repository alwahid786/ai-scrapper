import dotenv from 'dotenv';
dotenv.config();

const config = Object.freeze({
  PORT: process.env.PORT,
  DB_URL: process.env.DB_URL,
  NODE_ENV: process.env.NODE_ENV,

  GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
  ZENROWS_API_KEY: process.env.ZENROWS_API_KEY,

  ACCESS_TOKEN_NAME: process.env.ACCESS_TOKEN_NAME,
  ACCESS_TOKEN_EXPIRY: process.env.ACCESS_TOKEN_EXPIRY,
  ACCESS_TOKEN_MAX_AGE: process.env.ACCESS_TOKEN_MAX_AGE,
  ACCESS_TOKEN_SECRET: process.env.ACCESS_TOKEN_SECRET,
  REFRESH_TOKEN_NAME: process.env.REFRESH_TOKEN_NAME,
  REFRESH_TOKEN_EXPIRY: process.env.REFRESH_TOKEN_EXPIRY,
  REFRESH_TOKEN_MAX_AGE: process.env.REFRESH_TOKEN_MAX_AGE,
  REFRESH_TOKEN_SECRET: process.env.REFRESH_TOKEN_SECRET,

  CLOUDINARY_CLIENT_NAME: process.env.CLOUDINARY_CLIENT_NAME,
  CLOUDINARY_CLIENT_KEY: process.env.CLOUDINARY_CLIENT_KEY,
  CLOUDINARY_CLIENT_SECRET: process.env.CLOUDINARY_CLIENT_SECRET,
  CLOUDINARY_FOLDER_NAME: process.env.CLOUDINARY_FOLDER_NAME,

  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
});

const getEnv = (key) => {
  const value = config[key];
  if (!value) throw new Error(`Env variable ${key} is not defined`);
  return value;
};
export { getEnv };
