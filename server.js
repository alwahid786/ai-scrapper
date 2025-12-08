import app from './app.js';
import { getEnv } from './config/config.js';
import { connectDb } from './config/dbConnection.js';
import { configureCloudinary } from './utils/cloudinary.js';

const port = getEnv('PORT');
(async () => {
  await connectDb(getEnv('DB_URL'));
  await configureCloudinary();
  app.listen(port, () => {
    console.log(`Server is running on ${port}`);
  });
})();
