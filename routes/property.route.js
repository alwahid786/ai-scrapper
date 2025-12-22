import express from 'express';
import {
  address,
  fetchMetadata,
  saveProperty,
  debugHtml,
  searchProperties,
} from '../controllers/property.controller.js';

const router = express.Router();

router.post('/normalize', address);

router.post('/fetchmetadata', fetchMetadata);
router.post('/searchproperties', searchProperties);
router.post('/save', saveProperty);

//for debugging HTML content
router.post('/debug-html', debugHtml);

export default router;
