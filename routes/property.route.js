import express from 'express';
import {
  normalize,
  checkDuplicate,
  fetchMetadata,
  saveProperty,
} from '../controllers/property.controller.js';

const router = express.Router();

router.post('/normalize', normalize);
router.post('/checkduplicate', checkDuplicate);
router.post('/fetchmetadata', fetchMetadata);
router.post('/save', saveProperty);

export default router;
