import cloudinary from 'cloudinary';
import streamifier from 'streamifier';
import { getEnv } from '../config/config.js';

// CONFIGURE CLOUDINARY
export const configureCloudinary = async () => {
  try {
    cloudinary.v2.config({
      cloud_name: getEnv('CLOUDINARY_CLIENT_NAME'),
      api_key: getEnv('CLOUDINARY_CLIENT_KEY'),
      api_secret: getEnv('CLOUDINARY_CLIENT_SECRET'),
    });
    console.log('Cloudinary configured successfully');
  } catch (error) {
    console.error('Error configuring Cloudinary:', error);
  }
};

// UPLOAD FILE ON CLOUDINARY
export const uploadOnCloudinary = async (image, subFolder) => {
  try {
    if (!image?.buffer) return null;
    const streamUpload = (buffer) => {
      return new Promise((resolve, reject) => {
        const stream = cloudinary.v2.uploader.upload_stream(
          { resourceType: 'auto', folder: `${getEnv('CLOUDINARY_FOLDER_NAME')}/${subFolder}` },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          }
        );
        streamifier.createReadStream(buffer).pipe(stream);
      });
    };
    const result = await streamUpload(image.buffer);
    console.log('Image uploaded successfully on Cloudinary');
    return result;
  } catch (error) {
    console.error('Error occurred while uploading file on Cloudinary', error);
    return null;
  }
};

// REMOVE FILE FROM CLOUDINARY
export const removeFromCloudinary = async (fileName, resourceType = 'image') => {
  try {
    const response = await cloudinary.v2.uploader.destroy(fileName, { resourceType: resourceType });
    console.log(`Image deleted successfully from Cloudinary`);
    return response;
  } catch (error) {
    console.error('Error occurred while removing file from Cloudinary', error);
    return null;
  }
};
