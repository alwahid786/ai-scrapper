import express from 'express';
import { address, fetchMetadata, saveProperty } from '../controllers/property.controller.js';

const router = express.Router();

router.post('/normalize', address);

router.post('/fetchmetadata', fetchMetadata);
router.post('/save', saveProperty);

export default router;
