import express from 'express';
import {
  analyzeProperty,
  analyzePropertyById,
  analyzeSelectedComps,
  findComparables,
  getAnalysis,
  getComparables,
  getImageAnalyses,
  recalculateMAO,
} from '../controllers/comps.controller.js';
import { isAuthenticated } from '../middlewares/auth.middleware.js';

const router = express.Router();

// Main analysis endpoint
router.post('/analyze', isAuthenticated, analyzeProperty);

// Find comparables for a property (without analysis) - NEW
router.post('/find/:propertyId', isAuthenticated, findComparables);

// Analyze selected comps (3-5 comps) - NEW
router.post('/analyze-selected', isAuthenticated, analyzeSelectedComps);

// Analyze selected comps with Server-Sent Events progress (same body as analyze-selected)
router.post('/analyze-selected-stream', isAuthenticated, (req, res, next) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  req.progress = (ev) => {
    res.write('data: ' + JSON.stringify(ev) + '\n\n');
    if (typeof res.flush === 'function') res.flush();
  };
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    res.write('data: ' + JSON.stringify({ type: 'complete', ...body }) + '\n\n');
    res.end();
  };
  next();
}, analyzeSelectedComps);

// Analyze property by ID (from search results) - must come before /analyze route
router.post('/analyze/:propertyId', isAuthenticated, analyzePropertyById);

// Get analysis by property ID
router.get('/analysis/:propertyId', isAuthenticated, getAnalysis);

// Get comparables for a property (from database)
router.get('/:propertyId', isAuthenticated, getComparables);

// Get image analyses
router.get('/images/:propertyId', isAuthenticated, getImageAnalyses);

// Recalculate MAO
router.post('/recalculate/:analysisId', isAuthenticated, recalculateMAO);

export default router;
