import mongoose from 'mongoose';
import { getEnv } from './config.js';

export const connectDb = async (dburl = getEnv('DB_URL')) => {
  try {
    const res = await mongoose.connect(dburl);
    if (res?.connection?.readyState === 1) {
      console.log(`Connected to ${res?.connection?.db?.databaseName} successfully `);
    } else {
      console.log('Connection Failed');
      await mongoose.connection.close();
    }
  } catch (err) {
    console.log('Connection Failed');
    await mongoose.connection.close();
  }
};
