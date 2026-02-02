import app from './app.js';
import { getEnv } from './config/config.js';
import { connectDb } from './config/dbConnection.js';
import { configureCloudinary } from './utils/cloudinary.js';

const port = getEnv('PORT');
(async () => {
  await connectDb(getEnv('DB_URL'));
  await configureCloudinary();
  
  // Log Apify actor configurations on startup
  console.log('\n📋 Apify Actor Configuration:');
  console.log('   Zillow Actor:', process.env.APIFY_ZILLOW_ACTOR_ID || process.env.ZILLOW_ACTOR_ID || 'NOT CONFIGURED');
  console.log('   Redfin Actor:', process.env.APIFY_REDFIN_ACTOR_ID || process.env.REDFIN_ACTOR_ID || 'NOT CONFIGURED');
  console.log('   Realtor Actor:', process.env.APIFY_REALTOR_ACTOR_ID || process.env.REALTOR_ACTOR_ID || 'NOT CONFIGURED');
  console.log('   Property Detail Actor:', process.env.APIFY_PROPERTY_DETAIL_ACTOR_ID || 'NOT CONFIGURED');
  console.log('   ⚠️  NOTE: If you changed .env file, restart the server for changes to take effect\n');
  
  app.listen(port, () => {
    console.log(`Server is running on ${port}`);
  });
})();
