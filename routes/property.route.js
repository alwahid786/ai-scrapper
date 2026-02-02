import express from 'express';
import {
  address,
  fetchMetadata,
  saveProperty,
  debugHtml,
  searchProperties,
  fetchPropertyDetails,
  searchPropertyByAddress,
} from '../controllers/property.controller.js';

const router = express.Router();

router.post('/normalize', address);

router.post('/fetchmetadata', fetchMetadata);
router.post('/searchproperties', searchProperties);
router.post('/search-by-address', searchPropertyByAddress); // New endpoint for address-based search
router.post('/save', saveProperty);
router.post('/fetch-details', fetchPropertyDetails); // New endpoint for fetching full property details with all images

//for debugging HTML content
router.post('/debug-html', debugHtml);

export default router;
