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
