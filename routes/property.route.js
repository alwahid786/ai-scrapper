import express from 'express';
import {
  address,
  fetchMetadata,
  saveProperty,
  debugHtml,
  searchProperties,
  fetchPropertyDetails,
  searchPropertyByAddress,
  uploadPropertyImages,
} from '../controllers/property.controller.js';
import { propertyImagesUpload } from '../middlewares/multer.js';

const router = express.Router();

/** Handle multer errors (e.g. file too large) so API returns clear message instead of generic 500 */
const multerUploadErrorHandler = (err, req, res, next) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      error: 'File too large. Maximum size per image is 10 MB.',
      urls: [],
    });
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({
      success: false,
      error: 'Too many files. Maximum 60 images allowed.',
      urls: [],
    });
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    // Multer can throw this when > maxCount files are sent (field name is correct but count exceeds limit)
    const isImagesField = err.field === 'images' || err.field === 'images[]';
    if (isImagesField) {
      return res.status(400).json({
        success: false,
        error: 'Too many files. Maximum 60 images allowed.',
        urls: [],
      });
    }
    const field = err.field ? ` Received field: "${err.field}".` : '';
    return res.status(400).json({
      success: false,
      error: `Unexpected field. Use field name "images" for file upload (max 60).${field}`,
      urls: [],
    });
  }
  next(err);
};

router.post('/normalize', address);

router.post('/fetchmetadata', fetchMetadata);
router.post('/searchproperties', searchProperties);
router.post('/search-by-address', searchPropertyByAddress);
router.post('/upload-images', propertyImagesUpload, multerUploadErrorHandler, uploadPropertyImages);
router.post('/save', saveProperty);
router.post('/fetch-details', fetchPropertyDetails); // New endpoint for fetching full property details with all images

//for debugging HTML content
router.post('/debug-html', debugHtml);

export default router;
