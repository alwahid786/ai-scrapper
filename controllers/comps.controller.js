import { runCompsAnalysis } from '../services/compsEngineService.js';
import Property from '../models/property.js';
import PropertyAnalysis from '../models/propertyAnalysis.js';
import Comparable from '../models/comparable.js';
import ImageAnalysis from '../models/imageAnalysis.js';
import { CustomError } from '../utils/CustomError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  validateAddress,
  validateImageUrls,
  validateMaoInputs,
  validateObjectId,
} from '../utils/inputValidation.js';

/**
 * Run analysis on selected comp properties (3-5 comps)
 * POST /api/comps/analyze-selected
 * Body: { propertyId, selectedCompIds: [compId1, compId2, ...], maoInputs: {} }
 */
export const analyzeSelectedComps = asyncHandler(async (req, res, next) => {
  const { propertyId, selectedCompIds = [], maoInputs = {} } = req.body;

  if (!validateObjectId(propertyId)) {
    return next(new CustomError(400, 'Invalid property ID'));
  }

  // Validate selected comps (must be 1-5, but 3-5 recommended)
  if (!Array.isArray(selectedCompIds) || selectedCompIds.length < 1 || selectedCompIds.length > 5) {
    return next(new CustomError(400, 'Please select 1-5 comparable properties (3-5 recommended for accurate results)'));
  }
  
  // Warn if less than 3 comps (but allow it)
  if (selectedCompIds.length < 3) {
    console.warn(`⚠️ Only ${selectedCompIds.length} comp${selectedCompIds.length === 1 ? '' : 's'} selected. Analysis may be less accurate with fewer than 3 comparables.`);
  }

  // Validate all comp IDs
  for (const compId of selectedCompIds) {
    if (!validateObjectId(compId)) {
      return next(new CustomError(400, `Invalid comp ID: ${compId}`));
    }
  }

  // Fetch property
  const property = await Property.findById(propertyId);
  if (!property) {
    return next(new CustomError(404, 'Property not found'));
  }

  // Fetch selected comps
  const selectedComps = await Comparable.find({
    _id: { $in: selectedCompIds },
    subjectPropertyId: propertyId,
  });

  if (selectedComps.length !== selectedCompIds.length) {
    return next(new CustomError(400, 'Some selected comps were not found or do not belong to this property'));
  }

  const address = property.formattedAddress || property.address || property.rawAddress;
  const propertyImages = property.images || [];

  if (!address) {
    return next(new CustomError(400, 'Property address not found'));
  }

  try {
    // Import comps engine functions
    const { prepareSubjectProperty, calculateARV, calculateMAO, calculateDealScore, generateRecommendation, estimateRepairsFromCondition } = await import('../services/compsEngineService.js');
    const { analyzePropertyImages, aggregateImageAnalyses } = await import('../services/geminiService.js');

    // Prepare subject property WITH image analysis (skipImageAnalysis = false)
    console.log(`📊 Running analysis on ${selectedComps.length} selected comps for property: ${address}`);
    console.log(`🖼️ Running image analysis for subject property (${propertyImages.length} images)...`);
    const prepared = await prepareSubjectProperty(address, propertyImages, false); // skipImageAnalysis = false
    const subjectProperty = prepared.property;
    const subjectAggregated = prepared.aggregatedImageScores;

    // Run image analysis on selected comps (if they have images)
    console.log(`🖼️ Running image analysis on ${selectedComps.length} selected comps...`);
    const { alignRoomTypesForComparison } = await import('../services/compsEngineService.js');
    
    for (const comp of selectedComps) {
      if (comp.images && comp.images.length > 0) {
        try {
          console.log(`  🖼️ Analyzing ${comp.images.length} images for comp: ${comp.address || comp.formattedAddress}`);
          const compImageAnalyses = await analyzePropertyImages(comp.images, {
            address: comp.address || comp.formattedAddress,
            propertyType: comp.propertyType,
          });
          
          if (compImageAnalyses && compImageAnalyses.length > 0) {
            const aggregated = aggregateImageAnalyses(compImageAnalyses);
            
            // Update comp with image analysis results
            comp.conditionRating = aggregated.overallConditionScore ? Math.round(aggregated.overallConditionScore / 2) : 3; // Convert 1-10 to 1-5
            comp.renovationIndicators = aggregated.renovationIndicators || [];
            comp.damageFlags = aggregated.damageFlags || [];
            
            // Store image analyses on comp for room-type comparison
            comp.imageAnalyses = compImageAnalyses;
            comp.aggregatedImageScores = aggregated;
            
            // Perform room-type alignment comparison with subject property
            if (subjectProperty.imageAnalyses && subjectProperty.imageAnalyses.length > 0) {
              const roomTypeComparisons = alignRoomTypesForComparison(
                subjectProperty.imageAnalyses,
                compImageAnalyses
              );
              
              // Adjust comp value based on condition differences
              if (roomTypeComparisons.length > 0) {
                let totalWeightedAdjustment = 0;
                let totalWeight = 0;
                
                roomTypeComparisons.forEach(comparison => {
                  const weight = (comparison.confidence || 50) / 100;
                  const adjustment = comparison.adjustmentPercent || 0;
                  totalWeightedAdjustment += adjustment * weight;
                  totalWeight += weight;
                });
                
                const avgAdjustmentPercent = totalWeight > 0 ? totalWeightedAdjustment / totalWeight : 0;
                comp.conditionAdjustmentPercent = Math.max(-0.15, Math.min(0.15, avgAdjustmentPercent));
                comp.conditionAdjustment = roomTypeComparisons.reduce((sum, comp) => sum + comp.conditionDifference, 0) / roomTypeComparisons.length;
                
                console.log(`  ✅ Room-type comparison: ${roomTypeComparisons.length} rooms compared, avg adjustment: ${(avgAdjustmentPercent * 100).toFixed(2)}%`);
              }
            }
            
            // Save image analyses
            const compProperty = await Property.findOne({ formattedAddress: comp.formattedAddress || comp.address }) ||
                                 await Property.create({
                                   formattedAddress: comp.formattedAddress || comp.address,
                                   address: comp.address || comp.formattedAddress,
                                   latitude: comp.latitude,
                                   longitude: comp.longitude,
                                 });
            const analysesToSave = compImageAnalyses.map((analysis) => ({
              propertyId: compProperty._id,
              ...analysis,
            }));
            await ImageAnalysis.insertMany(analysesToSave);
            
            await comp.save();
            console.log(`  ✅ Image analysis complete for comp: ${comp.address}`);
          }
        } catch (imageError) {
          console.warn(`  ⚠️ Failed to analyze images for comp ${comp.address}:`, imageError.message);
        }
      }
    }

    // Calculate ARV using only selected comps
    console.log(`💰 Calculating ARV from ${selectedComps.length} selected comps...`);
    const arv = calculateARV(subjectProperty, selectedComps);

    if (!arv) {
      return next(new CustomError(400, 'Could not calculate ARV from selected comps. Ensure comps have valid sale prices.'));
    }

    // Calculate MAO
    const validatedMaoInputs = validateMaoInputs(maoInputs);
    if ((!validatedMaoInputs.estimatedRepairs || validatedMaoInputs.estimatedRepairs === 0) && subjectAggregated) {
      const estimated = estimateRepairsFromCondition(arv, subjectAggregated);
      if (estimated) {
        validatedMaoInputs.estimatedRepairs = estimated;
      }
    }
    const mao = calculateMAO(arv, validatedMaoInputs);

    // Get area type from subject property preparation
    // Use areaType from prepared property if available, otherwise determine from normalized data
    let areaType = 'suburban'; // Default
    if (prepared && prepared.areaType) {
      areaType = prepared.areaType;
    } else if (prepared && prepared.normalized && prepared.normalized.types) {
      const { determineAreaType } = await import('../services/googleMapsService.js');
      areaType = determineAreaType(prepared.normalized.types);
    }
    
    // Create analysis object for deal score calculation
    const tempAnalysis = {
      arv,
      estimatedRepairs: validatedMaoInputs.estimatedRepairs,
      daysOnMarket: property.daysOnMarket || 90,
      areaType: areaType, // Pass area type for neighborhood rating
    };

    // Calculate Deal Score (now async to fetch neighborhood rating)
    const dealScore = await calculateDealScore(subjectProperty, tempAnalysis, selectedComps);

    // Generate recommendation
    const recommendation = generateRecommendation(dealScore.dealScore);

    // Create or update PropertyAnalysis
    let analysis = await PropertyAnalysis.findOne({ propertyId });
    if (!analysis) {
      analysis = new PropertyAnalysis({ propertyId });
    }

    // Update analysis with results
    analysis.propertyCategory = subjectProperty.propertyCategory || 'single-family';
    analysis.searchRadius = subjectProperty.searchRadius || 1;
    analysis.timeWindowMonths = 6; // Default
    analysis.compsFound = selectedComps.length;
    analysis.arv = arv;
    analysis.arvCalculationMethod = 'weighted';
    analysis.topCompsUsed = selectedCompIds.map(id => id);
    analysis.mao = mao?.mao || null;
    analysis.estimatedRepairs = validatedMaoInputs.estimatedRepairs;
    analysis.holdingCost = validatedMaoInputs.holdingCost;
    analysis.closingCost = validatedMaoInputs.closingCost;
    analysis.wholesaleFee = validatedMaoInputs.wholesaleFee;
    analysis.maoRule = validatedMaoInputs.maoRule;
    analysis.suggestedOffer = mao?.suggestedOffer || null;
    analysis.dealScore = dealScore.dealScore;
    analysis.spreadScore = dealScore.spreadScore;
    analysis.repairScore = dealScore.repairScore;
    analysis.marketScore = dealScore.marketScore;
    analysis.areaScore = dealScore.areaScore;
    analysis.compStrengthScore = dealScore.compStrengthScore;
    analysis.recommendation = recommendation.recommendation;
    analysis.recommendationReason = recommendation.recommendationReason;

    // Get condition scores from subject property image analysis
    if (subjectProperty.imageAnalyses && subjectProperty.imageAnalyses.length > 0) {
      const aggregated = subjectAggregated || aggregateImageAnalyses(subjectProperty.imageAnalyses);
      analysis.conditionCategory = aggregated.conditionCategory || 'medium-repairs';
      analysis.interiorScore = aggregated.interiorScore || 3;
      analysis.exteriorScore = aggregated.exteriorScore || 3;
      analysis.overallConditionScore = aggregated.overallConditionScore || 5;
      analysis.renovationScore = aggregated.renovationScore || 0;
      analysis.damageRiskScore = aggregated.damageRiskScore || 0;
    }

    const imageConfidence = subjectAggregated?.imageConfidence || 0;
    const compConfidence = Math.min(selectedComps.length, 5) / 5;
    analysis.confidence = Math.min(
      100,
      Math.round(40 + compConfidence * 30 + (imageConfidence / 100) * 30)
    );

    await analysis.save();

    res.status(200).json({
      success: true,
      message: `Analysis completed successfully using ${selectedComps.length} selected comps`,
      data: {
        property: {
          _id: property._id,
          formattedAddress: property.formattedAddress || address,
          latitude: property.latitude,
          longitude: property.longitude,
          beds: property.beds,
          baths: property.baths,
          squareFootage: property.squareFootage,
          lotSize: property.lotSize,
          yearBuilt: property.yearBuilt,
          propertyType: property.propertyType,
          price: property.price,
        },
        analysis: {
          _id: analysis._id,
          propertyCategory: analysis.propertyCategory,
          arv: analysis.arv,
          mao: analysis.mao,
          suggestedOffer: analysis.suggestedOffer,
          dealScore: analysis.dealScore,
          confidence: analysis.confidence,
          recommendation: analysis.recommendation,
          recommendationReason: analysis.recommendationReason,
          conditionCategory: analysis.conditionCategory,
          interiorScore: analysis.interiorScore,
          exteriorScore: analysis.exteriorScore,
          overallConditionScore: analysis.overallConditionScore,
          renovationScore: analysis.renovationScore,
          damageRiskScore: analysis.damageRiskScore,
        },
        comps: {
          total: selectedComps.length,
          selected: selectedComps.map((comp) => ({
            _id: comp._id,
            address: comp.address || comp.formattedAddress,
            beds: comp.beds,
            baths: comp.baths,
            squareFootage: comp.squareFootage,
            saleDate: comp.saleDate,
            salePrice: comp.salePrice,
            adjustedPrice: comp.adjustedPrice,
            distanceMiles: comp.distanceMiles,
            compScore: comp.compScore,
            dataSource: comp.dataSource,
            images: comp.images || [],
            conditionRating: comp.conditionRating || null,
            renovationIndicators: comp.renovationIndicators || [],
            damageFlags: comp.damageFlags || [],
          })),
        },
        dealScore: {
          overall: dealScore.dealScore,
          spreadScore: dealScore.spreadScore,
          repairScore: dealScore.repairScore,
          marketScore: dealScore.marketScore,
          areaScore: dealScore.areaScore,
          compStrengthScore: dealScore.compStrengthScore,
        },
        mao: mao,
        recommendation: recommendation,
      },
    });
  } catch (error) {
    console.error('Analysis error:', error);
    return next(new CustomError(500, `Analysis failed: ${error.message}`));
  }
});

/**
 * Analyze property by ID (from search results) - runs full analysis automatically
 * POST /api/comps/analyze/:propertyId
 */
export const analyzePropertyById = asyncHandler(async (req, res, next) => {
  const { propertyId } = req.params;
  const { images = [], maoInputs = {} } = req.body;

  if (!validateObjectId(propertyId)) {
    return next(new CustomError(400, 'Invalid property ID'));
  }

  // Fetch property from database
  const property = await Property.findById(propertyId);
  if (!property) {
    return next(new CustomError(404, 'Property not found'));
  }

  // Use property's address and existing images
  const address = property.formattedAddress || property.address || property.rawAddress;
  const propertyImages = images.length > 0 ? images : (property.images || []);

  if (!address) {
    return next(new CustomError(400, 'Property address not found'));
  }

  // NOTE: This endpoint now only finds comps, does NOT calculate ARV automatically
  // User must select 3-5 comps and use /api/comps/analyze-selected to get ARV/MAO
  try {
    const { prepareSubjectProperty, findComparableProperties, scoreComparables } = await import('../services/compsEngineService.js');
    const Comparable = await import('../models/comparable.js');
    
    // Prepare subject property
    const subjectProperty = await prepareSubjectProperty(address, propertyImages, false); // Run image analysis for deprecated endpoint
    
    if (!subjectProperty.latitude || !subjectProperty.longitude) {
      return next(new CustomError(400, 'Property coordinates not found. Cannot search for comparables.'));
    }

    // Find comparable properties (SOLD properties only)
    const searchParams = {
      latitude: subjectProperty.latitude,
      longitude: subjectProperty.longitude,
      radius: 1, // Default radius
      timeWindowMonths: 6,
      maxMonths: 12,
      propertyType: subjectProperty.propertyType,
    };
    
    const comps = await findComparableProperties(subjectProperty, searchParams);
    
    // Score the comps
    const matchingCriteria = {
      propertyType: true,
      bedrooms: { tolerance: 1 },
      bathrooms: { tolerance: 1 },
      squareFootage: { tolerance: 0.2 },
      lotSize: { tolerance: 0.5 },
      yearBuilt: { tolerance: 10 },
      areaType: subjectProperty.areaType,
    };
    
    const scoredComps = scoreComparables(subjectProperty, comps, matchingCriteria);
    
    // Save comps to database
    const savedComps = await Comparable.default.insertMany(
      scoredComps.map((comp) => ({
        ...comp,
        subjectPropertyId: property._id,
      }))
    );

    res.status(200).json({
      success: true,
      message: `Found ${savedComps.length} comparable properties. Please select 3-5 comps to calculate ARV.`,
      data: {
        property: {
          _id: property._id,
          formattedAddress: property.formattedAddress || address,
          latitude: property.latitude,
          longitude: property.longitude,
          beds: property.beds,
          baths: property.baths,
          squareFootage: property.squareFootage,
          lotSize: property.lotSize,
          yearBuilt: property.yearBuilt,
          propertyType: property.propertyType,
          price: property.price,
        },
        comps: {
          total: savedComps.length,
          data: savedComps.map((comp) => ({
            _id: comp._id,
            address: comp.address || comp.formattedAddress,
            beds: comp.beds,
            baths: comp.baths,
            squareFootage: comp.squareFootage,
            saleDate: comp.saleDate,
            salePrice: comp.salePrice,
            distanceMiles: comp.distanceMiles,
            compScore: comp.compScore,
            dataSource: comp.dataSource,
            images: comp.images || [],
            conditionRating: comp.conditionRating || null,
            renovationIndicators: comp.renovationIndicators || [],
            damageFlags: comp.damageFlags || [],
          })),
        },
        note: 'Select 3-5 comps and call POST /api/comps/analyze-selected to calculate ARV, MAO, and Deal Score',
      },
    });
  } catch (error) {
    console.error('Analysis error:', error);
    return next(new CustomError(500, `Analysis failed: ${error.message}`));
  }
});

/**
 * Main endpoint to run complete comps analysis
 * POST /api/comps/analyze
 */
export const analyzeProperty = asyncHandler(async (req, res, next) => {
  const { address, images = [], maoInputs = {} } = req.body;

  // Validate and sanitize address
  let validatedAddress;
  try {
    validatedAddress = validateAddress(address);
  } catch (error) {
    return next(new CustomError(400, error.message));
  }

  // Validate MAO inputs
  let validatedMaoInputs;
  try {
    validatedMaoInputs = validateMaoInputs(maoInputs);
  } catch (error) {
    return next(new CustomError(400, error.message));
  }

  // Validate and sanitize image URLs
  let imageUrls;
  try {
    imageUrls = validateImageUrls(images);
  } catch (error) {
    return next(new CustomError(400, error.message));
  }

  try {
    const result = await runCompsAnalysis(validatedAddress, imageUrls, validatedMaoInputs);

    res.status(200).json({
      success: true,
      message: 'Property analysis completed successfully',
      data: {
        property: {
          _id: result.property._id,
          formattedAddress: result.property.formattedAddress,
          latitude: result.property.latitude,
          longitude: result.property.longitude,
          beds: result.property.beds,
          baths: result.property.baths,
          squareFootage: result.property.squareFootage,
          lotSize: result.property.lotSize,
          yearBuilt: result.property.yearBuilt,
          propertyType: result.property.propertyType,
          price: result.property.price,
        },
        analysis: {
          _id: result.analysis._id,
          propertyCategory: result.analysis.propertyCategory,
          arv: result.arv,
          mao: result.mao?.mao,
          suggestedOffer: result.mao?.suggestedOffer,
          dealScore: result.dealScore.dealScore,
          recommendation: result.recommendation.recommendation,
          recommendationReason: result.recommendation.recommendationReason,
          conditionCategory: result.analysis.conditionCategory,
          interiorScore: result.analysis.interiorScore,
          exteriorScore: result.analysis.exteriorScore,
          overallConditionScore: result.analysis.overallConditionScore,
          renovationScore: result.analysis.renovationScore,
          damageRiskScore: result.analysis.damageRiskScore,
        },
        comps: {
          total: result.comps.length,
          topComps: result.topComps.map((comp) => ({
            _id: comp._id,
            address: comp.address,
            beds: comp.beds,
            baths: comp.baths,
            squareFootage: comp.squareFootage,
            saleDate: comp.saleDate,
            salePrice: comp.salePrice,
            adjustedPrice: comp.adjustedPrice,
            distanceMiles: comp.distanceMiles,
            compScore: comp.compScore,
            dataSource: comp.dataSource,
            images: comp.images || [], // Include images for comps
            conditionRating: comp.conditionRating || null,
            renovationIndicators: comp.renovationIndicators || [],
            damageFlags: comp.damageFlags || [],
          })),
        },
        dealScore: {
          overall: result.dealScore.dealScore,
          spreadScore: result.dealScore.spreadScore,
          repairScore: result.dealScore.repairScore,
          marketScore: result.dealScore.marketScore,
          areaScore: result.dealScore.areaScore,
          compStrengthScore: result.dealScore.compStrengthScore,
        },
        mao: result.mao,
        recommendation: result.recommendation,
      },
    });
  } catch (error) {
    console.error('Analysis error:', error);
    return next(new CustomError(500, `Analysis failed: ${error.message}`));
  }
});

/**
 * Get analysis by property ID
 * GET /api/comps/analysis/:propertyId
 */
export const getAnalysis = asyncHandler(async (req, res, next) => {
  const { propertyId } = req.params;

  if (!validateObjectId(propertyId)) {
    return next(new CustomError(400, 'Invalid property ID'));
  }

  const analysis = await PropertyAnalysis.findOne({ propertyId }).populate('topCompsUsed');

  if (!analysis) {
    return next(new CustomError(404, 'Analysis not found'));
  }

  const property = await Property.findById(propertyId);
  const comps = await Comparable.find({ subjectPropertyId: propertyId })
    .sort({ compScore: -1 })
    .limit(10);

  res.status(200).json({
    success: true,
    data: {
      property,
      analysis,
      comps,
    },
  });
});

/**
 * Find comparable properties for a selected property (without running analysis)
 * POST /api/comps/find/:propertyId
 * This finds sold comps and returns them for user selection
 * 
 * Also accepts property data in request body if property doesn't exist in database yet
 */
export const findComparables = asyncHandler(async (req, res, next) => {
  const { propertyId } = req.params;
  const { timeWindowMonths = 6, maxResults = 20, propertyData } = req.body;

  let property = null;

  // Try to find property by ID if it's a valid ObjectId
  if (validateObjectId(propertyId)) {
    property = await Property.findById(propertyId);
  }

  // If property not found by ID, try to find by zpid or sourceId
  if (!property) {
    // Try finding by zpid (if propertyId is a zpid)
    if (propertyId && !validateObjectId(propertyId)) {
      property = await Property.findOne({ sourceId: propertyId });
    }
    
    // Try finding by propertyData zpid
    if (!property && propertyData?.zpid) {
      property = await Property.findOne({ sourceId: propertyData.zpid });
    }
    
    // Try finding by formattedAddress
    if (!property && propertyData?.formattedAddress) {
      property = await Property.findOne({ formattedAddress: propertyData.formattedAddress });
    }
  }

  // If still not found, create property from propertyData or propertyId
  if (!property) {
    try {
      const { prepareSubjectProperty } = await import('../services/compsEngineService.js');
      
      // Determine address from propertyData or construct from propertyId if it's an address-like string
      let address = null;
      
      if (propertyData) {
        address = propertyData.formattedAddress || 
                 propertyData.address || 
                 (propertyData.streetAddress && propertyData.city && propertyData.state
                   ? `${propertyData.streetAddress}, ${propertyData.city}, ${propertyData.state} ${propertyData.postalCode || ''}`.trim()
                   : null);
      }
      
      // If no address from propertyData, and propertyId is not a valid ObjectId, 
      // it might be an address string (though this is less common)
      if (!address && !validateObjectId(propertyId) && propertyId.includes(',')) {
        address = propertyId;
      }
      
      if (!address) {
        return next(new CustomError(400, 'Property not found in database. Please provide propertyData with formattedAddress or address in request body.'));
      }

      // Prepare property (normalizes address, fetches metadata if needed)
      // Skip image analysis - will run after comp selection
      const prepared = await prepareSubjectProperty(address, propertyData?.images || [], true); // skipImageAnalysis = true
      property = prepared.property;

      // If propertyData has coordinates, use them (more reliable than geocoding)
      if (propertyData.latitude && propertyData.longitude) {
        console.log(`📍 Using coordinates from propertyData: ${propertyData.latitude}, ${propertyData.longitude}`);
        property.latitude = propertyData.latitude;
        property.longitude = propertyData.longitude;
        await property.save();
      } else if (!property.latitude || !property.longitude) {
        // If geocoding didn't provide coordinates, try to get from normalized result
        if (prepared.normalized?.latitude && prepared.normalized?.longitude) {
          property.latitude = prepared.normalized.latitude;
          property.longitude = prepared.normalized.longitude;
          await property.save();
        }
      }

      console.log(`✅ Created property in database: ${property._id} for address: ${address}`);
      console.log(`📍 Property coordinates: ${property.latitude}, ${property.longitude}`);
    } catch (error) {
      console.error('Error creating property:', error);
      return next(new CustomError(400, `Failed to create property: ${error.message}`));
    }
  }

  // Final check - property should exist now
  if (!property) {
    return next(new CustomError(404, 'Property not found and could not be created. Please provide valid propertyData.'));
  }

  const address = property.formattedAddress || property.address || property.rawAddress;
  if (!address) {
    return next(new CustomError(400, 'Property address not found'));
  }

  try {
    // Import comps engine functions
    const { prepareSubjectProperty, findComparableProperties, scoreComparables, prepareCompSearch } = await import('../services/compsEngineService.js');

    // Prepare subject property (normalize address, get metadata)
    console.log(`🔍 Finding comparables for property: ${address}`);
    console.log(`📍 Available coordinates - propertyData: ${propertyData?.latitude}, ${propertyData?.longitude} | property: ${property.latitude}, ${property.longitude}`);
    
    // Prepare subject property (skip image analysis - will run after comp selection)
    // Returns { property, normalized, areaType, propertyCategory, imageAnalyses, aggregatedImageScores }
    const prepared = await prepareSubjectProperty(address, property.images || [], true); // skipImageAnalysis = true
    let subjectProperty = prepared.property; // Extract the actual property object
    
    // Image analysis will be skipped - no imageAnalyses at this stage
    console.log('⏭️ Skipping subject property image analysis (will run after comp selection)');
    
    // Priority order for coordinates:
    // 1. propertyData coordinates (most reliable - from frontend)
    // 2. property coordinates (from database)
    // 3. normalized coordinates (from geocoding)
    
    if (propertyData?.latitude && propertyData?.longitude) {
      console.log(`📍 Using coordinates from propertyData: ${propertyData.latitude}, ${propertyData.longitude}`);
      subjectProperty.latitude = propertyData.latitude;
      subjectProperty.longitude = propertyData.longitude;
      // Update in database too
      property.latitude = propertyData.latitude;
      property.longitude = propertyData.longitude;
      await property.save();
    } else if (property.latitude && property.longitude) {
      console.log(`📍 Using coordinates from property record: ${property.latitude}, ${property.longitude}`);
      subjectProperty.latitude = property.latitude;
      subjectProperty.longitude = property.longitude;
    } else if (prepared.normalized?.latitude && prepared.normalized?.longitude) {
      console.log(`📍 Using coordinates from address normalization: ${prepared.normalized.latitude}, ${prepared.normalized.longitude}`);
      subjectProperty.latitude = prepared.normalized.latitude;
      subjectProperty.longitude = prepared.normalized.longitude;
      // Update in database too
      property.latitude = prepared.normalized.latitude;
      property.longitude = prepared.normalized.longitude;
      await property.save();
    }

    // Final validation - must have coordinates to search
    if (!subjectProperty.latitude || !subjectProperty.longitude) {
      // No coordinates available anywhere
      console.error('❌ No coordinates found after all attempts:', {
        propertyData: {
          hasLat: !!propertyData?.latitude,
          hasLng: !!propertyData?.longitude,
          lat: propertyData?.latitude,
          lng: propertyData?.longitude,
        },
        property: {
          hasLat: !!property.latitude,
          hasLng: !!property.longitude,
          lat: property.latitude,
          lng: property.longitude,
        },
        normalized: {
          hasLat: !!prepared.normalized?.latitude,
          hasLng: !!prepared.normalized?.longitude,
          lat: prepared.normalized?.latitude,
          lng: prepared.normalized?.longitude,
        },
        address: address,
      });
      return next(new CustomError(400, 'Property coordinates not found. Cannot search for comparables. Please ensure the property has coordinates (latitude/longitude) or a complete address (street, city, state).'));
    }
    
    console.log(`✅ Using coordinates: ${subjectProperty.latitude}, ${subjectProperty.longitude}`);

    // Prepare comp search parameters (get proper radius based on area type)
    const searchParams = prepareCompSearch(subjectProperty, prepared.areaType);
    
    // Ensure subjectProperty has all required fields for findComparableProperties
    if (!subjectProperty._id) {
      subjectProperty._id = property._id;
    }
    if (!subjectProperty.formattedAddress) {
      subjectProperty.formattedAddress = property.formattedAddress || address;
    }
    if (!subjectProperty.address) {
      subjectProperty.address = property.address || property.formattedAddress || address;
    }
    
    // Store city, state, postalCode from propertyData, property record, or extract from address
    if (propertyData?.city) {
      subjectProperty.city = propertyData.city;
      property.city = propertyData.city;
    } else if (prepared.normalized?.addressComponents?.city) {
      subjectProperty.city = prepared.normalized.addressComponents.city;
      property.city = prepared.normalized.addressComponents.city;
    }
    
    if (propertyData?.state) {
      subjectProperty.state = propertyData.state;
      property.state = propertyData.state;
    } else if (prepared.normalized?.addressComponents?.state) {
      subjectProperty.state = prepared.normalized.addressComponents.state;
      property.state = prepared.normalized.addressComponents.state;
    }
    
    // Extract postal code from address if not provided (prefer from address over geocoding)
    let postalCodeToUse = propertyData?.postalCode;
    if (!postalCodeToUse) {
      // Try to extract from address string (more reliable than geocoding)
      const addressMatch = address.match(/\b(\d{5})\b/);
      if (addressMatch) {
        postalCodeToUse = addressMatch[1];
        console.log(`📮 Extracted postal code from address: ${postalCodeToUse}`);
      } else if (prepared.normalized?.addressComponents?.zipCode) {
        postalCodeToUse = prepared.normalized.addressComponents.zipCode;
        console.log(`📮 Using postal code from geocoding: ${postalCodeToUse}`);
      }
    }
    
    if (postalCodeToUse) {
      subjectProperty.postalCode = postalCodeToUse;
      subjectProperty.zipCode = postalCodeToUse; // Also store as zipCode for compatibility
      property.postalCode = postalCodeToUse;
    }
    
    // Save property updates if we added city/state/postalCode
    if (propertyData?.city || propertyData?.state || propertyData?.postalCode) {
      await property.save();
    }

    // Find comparable properties (SOLD properties only)
    // The findComparableProperties function automatically sets isSold: true
    console.log(`🔍 Searching for SOLD comparables near: ${subjectProperty.latitude}, ${subjectProperty.longitude}`);
    console.log(`📊 Search parameters: radius=${searchParams.radius}mi, timeWindow=${timeWindowMonths || searchParams.preferredMonths} months, propertyType=${subjectProperty.propertyType || 'any'}`);
    console.log(`📍 Subject property: ${subjectProperty.formattedAddress || subjectProperty.address}`);
    console.log(`🏠 Subject property details: ${subjectProperty.beds || '?'} beds, ${subjectProperty.baths || '?'} baths, ${subjectProperty.squareFootage || '?'} sqft`);
    
    const comps = await findComparableProperties(subjectProperty, {
      latitude: subjectProperty.latitude,
      longitude: subjectProperty.longitude,
      radius: searchParams.radius,
      timeWindowMonths: parseInt(timeWindowMonths) || searchParams.preferredMonths,
      maxMonths: searchParams.maxMonths,
      maxRadius: searchParams.maxRadius,
      preferredMonths: searchParams.preferredMonths,
      propertyType: subjectProperty.propertyType,
      maxResults: parseInt(maxResults) || 20,
    });

    console.log(`📊 Found ${comps.length} SOLD comparable properties after scraping`);

    if (comps.length === 0) {
      console.warn(`⚠️ No SOLD comparables found. This could be due to:
        1. No sold properties in the area within the time window
        2. Apify actors not configured or not working
        3. Search radius too small
        4. Property type mismatch
      `);
      return res.status(200).json({
        success: true,
        message: 'No comparable properties found. Try expanding the search radius or time window.',
        count: 0,
        data: [],
        searchParams: {
          radius: searchParams.radius,
          timeWindowMonths: timeWindowMonths || searchParams.preferredMonths,
          propertyType: subjectProperty.propertyType,
        },
      });
    }

    // Score the comps using the matching criteria from search params
    const matchingCriteria = searchParams.matchingCriteria || {
      propertyType: true,
      bedrooms: { tolerance: 1 },
      bathrooms: { tolerance: 1 },
      squareFootage: { tolerance: 0.2 },
      lotSize: { tolerance: 0.5 },
      yearBuilt: { tolerance: 10 },
      areaType: prepared.areaType,
    };

    const scoredComps = scoreComparables(subjectProperty, comps, matchingCriteria);

    // Sort by comp score and limit
    const sortedComps = scoredComps
      .sort((a, b) => (b.compScore || 0) - (a.compScore || 0))
      .slice(0, parseInt(maxResults) || 20);

    // Save comps to database
    // Use property._id (from database) as subjectPropertyId
    // This ensures we use the correct database ID even if property was just created
    const dbPropertyId = property._id.toString();
    
    const savedComps = await Promise.all(
      sortedComps.map(async (comp) => {
        // Check if comp already exists
        const existing = await Comparable.findOne({
          subjectPropertyId: dbPropertyId,
          sourceId: comp.sourceId,
          dataSource: comp.dataSource,
        });

        if (existing) {
          // Update existing comp
          Object.assign(existing, comp);
          await existing.save();
          return existing;
        } else {
          // Create new comp
          const newComp = new Comparable({
            ...comp,
            subjectPropertyId: dbPropertyId,
          });
          await newComp.save();
          return newComp;
        }
      })
    );

    res.status(200).json({
      success: true,
      message: `Found ${savedComps.length} comparable properties`,
      count: savedComps.length,
      propertyId: dbPropertyId, // Return the database property ID for use in analyze-selected
      data: savedComps.map((comp) => ({
        _id: comp._id,
        address: comp.address || comp.formattedAddress,
        beds: comp.beds,
        baths: comp.baths,
        squareFootage: comp.squareFootage,
        lotSize: comp.lotSize,
        yearBuilt: comp.yearBuilt,
        propertyType: comp.propertyType,
        saleDate: comp.saleDate,
        salePrice: comp.salePrice,
        distanceMiles: comp.distanceMiles,
        compScore: comp.compScore,
        dataSource: comp.dataSource,
        images: comp.images || [],
        conditionRating: comp.conditionRating || null,
        renovationIndicators: comp.renovationIndicators || [],
        damageFlags: comp.damageFlags || [],
      })),
    });
  } catch (error) {
    console.error('Find comparables error:', error);
    return next(new CustomError(500, `Failed to find comparables: ${error.message}`));
  }
});

/**
 * Get comparables for a property (from database)
 * GET /api/comps/:propertyId
 */
export const getComparables = asyncHandler(async (req, res, next) => {
  const { propertyId } = req.params;
  const { limit = 10, minScore = 0 } = req.query;

  if (!validateObjectId(propertyId)) {
    return next(new CustomError(400, 'Invalid property ID'));
  }

  const limitNum = Math.min(parseInt(limit) || 10, 100); // Max 100
  const minScoreNum = Math.max(0, Math.min(100, parseFloat(minScore) || 0));

  const comps = await Comparable.find({
    subjectPropertyId: propertyId,
    compScore: { $gte: minScoreNum },
  })
    .sort({ compScore: -1 })
    .limit(limitNum);

  res.status(200).json({
    success: true,
    count: comps.length,
    data: comps,
  });
});

/**
 * Get image analyses for a property
 * GET /api/comps/images/:propertyId
 */
export const getImageAnalyses = asyncHandler(async (req, res, next) => {
  const { propertyId } = req.params;

  if (!validateObjectId(propertyId)) {
    return next(new CustomError(400, 'Invalid property ID'));
  }

  const analyses = await ImageAnalysis.find({ propertyId }).sort({ createdAt: -1 });

  res.status(200).json({
    success: true,
    count: analyses.length,
    data: analyses,
  });
});

/**
 * Recalculate ARV/MAO with custom inputs
 * POST /api/comps/recalculate/:analysisId
 */
export const recalculateMAO = asyncHandler(async (req, res, next) => {
  const { analysisId } = req.params;
  const { estimatedRepairs, holdingCost, closingCost, wholesaleFee, maoRule, maoRulePercent } = req.body;

  if (!validateObjectId(analysisId)) {
    return next(new CustomError(400, 'Invalid analysis ID'));
  }

  // Validate MAO inputs
  let validatedMaoInputs;
  try {
    validatedMaoInputs = validateMaoInputs({
      estimatedRepairs,
      holdingCost,
      closingCost,
      wholesaleFee,
      maoRule,
      maoRulePercent,
    });
  } catch (error) {
    return next(new CustomError(400, error.message));
  }

  const analysis = await PropertyAnalysis.findById(analysisId);
  if (!analysis) {
    return next(new CustomError(404, 'Analysis not found'));
  }

  const { calculateMAO } = await import('../services/compsEngineService.js');

  const maoResult = calculateMAO(analysis.arv, {
    estimatedRepairs: parseFloat(estimatedRepairs) || analysis.estimatedRepairs,
    holdingCost: parseFloat(holdingCost) || analysis.holdingCost,
    closingCost: parseFloat(closingCost) || analysis.closingCost,
    wholesaleFee: parseFloat(wholesaleFee) || analysis.wholesaleFee,
    maoRule: maoRule || analysis.maoRule,
  });

  // Update analysis
  analysis.mao = maoResult?.mao || null;
  analysis.suggestedOffer = maoResult?.suggestedOffer || null;
  analysis.estimatedRepairs = validatedMaoInputs.estimatedRepairs;
  analysis.holdingCost = validatedMaoInputs.holdingCost;
  analysis.closingCost = validatedMaoInputs.closingCost;
  analysis.wholesaleFee = validatedMaoInputs.wholesaleFee;
  analysis.maoRule = validatedMaoInputs.maoRule;
  await analysis.save();

  res.status(200).json({
    success: true,
    message: 'MAO recalculated successfully',
    data: {
      analysis,
      mao: maoResult,
    },
  });
});
