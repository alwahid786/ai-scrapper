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

/** Sanitize a single image analysis for API response (no Mongoose, no internal-only fields) */
function sanitizeImageAnalysisForResponse(a) {
  if (!a || typeof a !== 'object') return null;
  return {
    imageUrl: a.imageUrl,
    imageType: a.imageType || 'uncertain',
    confidence: a.confidence,
    conditionScore: a.conditionScore,
    conditionDetails: a.conditionDetails || null,
    renovationIndicators: Array.isArray(a.renovationIndicators) ? a.renovationIndicators : [],
    damageFlags: Array.isArray(a.damageFlags) ? a.damageFlags : [],
    hasNewCabinets: a.hasNewCabinets,
    hasStainlessAppliances: a.hasStainlessAppliances,
    hasModernLightFixtures: a.hasModernLightFixtures,
    hasUpdatedBathroom: a.hasUpdatedBathroom,
    hasNewFlooring: a.hasNewFlooring,
    hasFreshPaint: a.hasFreshPaint,
    hasModernWindows: a.hasModernWindows,
    hasUpgradedSiding: a.hasUpgradedSiding,
    hasNewRoof: a.hasNewRoof,
    hasWaterDamage: a.hasWaterDamage,
    hasMold: a.hasMold,
    hasCracks: a.hasCracks,
    hasBrokenWindows: a.hasBrokenWindows,
    hasMissingShingles: a.hasMissingShingles,
    hasFoundationCracks: a.hasFoundationCracks,
    hasYardNeglect: a.hasYardNeglect,
    damageNotes: a.damageNotes || null,
  };
}

/** Build a short subject-vs-comp summary for display (SOP: comp-to-subject photo comparison) */
function buildSubjectVsCompSummary(subjectProperty, selectedComps) {
  const parts = [];
  const roomLabels = { kitchen: 'Kitchen', bathroom: 'Bathroom', bedroom: 'Bedroom', 'living-room': 'Living room', 'exterior-front': 'Exterior front', 'exterior-back': 'Exterior back', basement: 'Basement', garage: 'Garage', backyard: 'Backyard', roof: 'Roof' };
  const subjectAgg = subjectProperty?.aggregatedImageScores;
  for (const comp of selectedComps || []) {
    const comparisons = comp.roomTypeComparisons || [];
    for (const r of comparisons) {
      if (r.conditionDifference > 0) {
        const label = roomLabels[r.roomType] || r.roomType;
        parts.push(`${label}: comp ${r.compCondition}/5 vs subject ${r.subjectCondition}/5`);
      }
    }
  }
  if (parts.length === 0 && subjectAgg) {
    if ((subjectAgg.overallConditionScore ?? 5) < 5) parts.push('Subject condition below average; comps used for ARV baseline.');
    else if ((subjectAgg.renovationScore ?? 0) < 50) parts.push('Subject has limited renovation indicators compared to comps.');
  }
  return parts.length > 0 ? parts.join('. ') : undefined;
}

/**
 * Run analysis on selected comp properties (3-5 comps)
 * POST /api/comps/analyze-selected
 * Body: { propertyId, selectedCompIds: [compId1, compId2, ...], maoInputs: {} }
 */
export const analyzeSelectedComps = asyncHandler(async (req, res, next) => {
  const { propertyId, selectedCompIds = [], maoInputs = {}, subjectImages } = req.body;

  // propertyId can be MongoDB _id or sourceId (e.g. ZPID) – must be non-empty string
  if (!propertyId || typeof propertyId !== 'string' || !propertyId.trim()) {
    return next(new CustomError(400, 'Property ID is required'));
  }
  const propertyIdTrimmed = propertyId.trim();

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

  // Fetch property by MongoDB _id or by sourceId (e.g. ZPID) so frontend can send either
  let property = null;
  if (validateObjectId(propertyIdTrimmed)) {
    property = await Property.findById(propertyIdTrimmed);
  }
  if (!property) {
    property = await Property.findOne({ sourceId: propertyIdTrimmed });
  }
  if (!property) {
    return next(new CustomError(404, 'Property not found'));
  }

  const effectivePropertyId = property._id.toString();

  // Fetch selected comps: they must belong to this property (by subjectPropertyId)
  let selectedComps = await Comparable.find({
    _id: { $in: selectedCompIds },
    subjectPropertyId: effectivePropertyId,
  });

  // If some comps were not found, they may have been saved under a different subject document (same property, different _id)
  if (selectedComps.length !== selectedCompIds.length) {
    const byIdOnly = await Comparable.find({ _id: { $in: selectedCompIds } });
    if (byIdOnly.length === selectedCompIds.length) {
      const subjectIds = [...new Set(byIdOnly.map((c) => c.subjectPropertyId?.toString()).filter(Boolean))];
      if (subjectIds.length === 1) {
        const subject = await Property.findById(subjectIds[0]);
        const sameSubject =
          subject &&
          (subject._id.toString() === effectivePropertyId ||
            (subject.sourceId && property.sourceId && subject.sourceId === property.sourceId) ||
            (subject.formattedAddress && property.formattedAddress && subject.formattedAddress === property.formattedAddress));
        if (sameSubject) {
          selectedComps = byIdOnly;
        }
      }
    }
  }

  // If still missing comps, accept comps that belong to any subject with matching address (normalize for comparison)
  const normalizeAddr = (a) => (a && typeof a === 'string' ? a.replace(/\s+/g, ' ').trim().toLowerCase() : '');
  const subjectAddr = normalizeAddr(property.formattedAddress || property.rawAddress || property.address);
  if (selectedComps.length !== selectedCompIds.length && subjectAddr) {
    const byIdOnly = await Comparable.find({ _id: { $in: selectedCompIds } });
    const foundIds = new Set(selectedComps.map((c) => c._id.toString()));
    const missing = byIdOnly.filter((c) => !foundIds.has(c._id.toString()));
    for (const comp of missing) {
      const compSubjectId = comp.subjectPropertyId?.toString();
      if (!compSubjectId) continue;
      const compSubject = await Property.findById(compSubjectId);
      if (compSubject && normalizeAddr(compSubject.formattedAddress || compSubject.rawAddress || compSubject.address) === subjectAddr) {
        selectedComps.push(comp);
      }
    }
  }

  if (selectedComps.length !== selectedCompIds.length) {
    return next(new CustomError(400, 'Some selected comps were not found or do not belong to this property'));
  }

  const address = property.formattedAddress || property.address || property.rawAddress;
  // Use subject images from request (user-uploaded) when provided; otherwise DB property.images (SOP: compare comps to subject using subject photos)
  const propertyImages = (Array.isArray(subjectImages) && subjectImages.length > 0)
    ? subjectImages
    : (property.images || []);

  if (!address) {
    return next(new CustomError(400, 'Property address not found'));
  }

  // Persist subject images to property when provided so DB reflects user-uploaded photos
  if (Array.isArray(subjectImages) && subjectImages.length > 0) {
    property.images = subjectImages;
    await property.save().catch(() => {});
  }

  try {
    // Import comps engine functions (getCompSalePrice used to patch salePrice from rawData when DB has none)
    const { prepareSubjectProperty, calculateARV, calculateMAO, calculateDealScore, generateRecommendation, estimateRepairsFromCondition, estimateRepairsSOP, estimateRepairsSOPWithBreakdown, getCompSalePrice } = await import('../services/compsEngineService.js');
    const { analyzePropertyImages, aggregateImageAnalyses } = await import('../services/geminiService.js');

    // Prepare subject property WITH image analysis (skipImageAnalysis = false); analyzes only subject images for comp-to-subject comparison
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
            
            // Perform room-type alignment comparison with subject property (SOP: comp-to-subject photo comparison)
            if (subjectProperty.imageAnalyses && subjectProperty.imageAnalyses.length > 0) {
              const roomTypeComparisons = alignRoomTypesForComparison(
                subjectProperty.imageAnalyses,
                compImageAnalyses
              );
              comp.roomTypeComparisons = roomTypeComparisons;

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
                comp.conditionAdjustment = roomTypeComparisons.reduce((sum, c) => sum + c.conditionDifference, 0) / roomTypeComparisons.length;

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

    // Resolve sale price from comp (rawData preferred over DB so ARV is not lowered by stale DB salePrice).
    for (const comp of selectedComps) {
      const resolved = getCompSalePrice(comp);
      if (resolved != null && resolved > 0) {
        const prev = comp.salePrice;
        comp.salePrice = resolved;
        if (prev == null || prev <= 0 || prev !== resolved) {
          await Comparable.findByIdAndUpdate(comp._id, { salePrice: resolved }).catch(() => {});
        }
      }
    }

    // SOP Step 5: Subject attributes (beds, baths, sqft, lot, garage) must be set for dollar adjustments.
    // prepareSubjectProperty may return a subject without these if the DB property was never updated from search.
    // Merge the known subject (property from DB) into subjectProperty so ARV uses correct adjustments.
    if (property) {
      if (property.beds != null) subjectProperty.beds = property.beds;
      if (property.baths != null) subjectProperty.baths = property.baths;
      if (property.squareFootage != null) subjectProperty.squareFootage = property.squareFootage;
      if (property.lotSize != null) subjectProperty.lotSize = property.lotSize;
      if (property.yearBuilt != null) subjectProperty.yearBuilt = property.yearBuilt;
      if (property.garageSpaces != null) subjectProperty.garageSpaces = property.garageSpaces;
      if (property.garage != null) subjectProperty.garage = property.garage;
      console.log(`📐 Subject for ARV: ${subjectProperty.beds ?? '?'} bed, ${subjectProperty.baths ?? '?'} bath, ${subjectProperty.squareFootage ?? '?'} sqft`);
    }

    // Calculate ARV using only selected comps (SOP: adjusted prices, weighted average, ceiling max comp + $10K)
    console.log(`💰 Calculating ARV from ${selectedComps.length} selected comps...`);
    const { arv, adjustedComps } = calculateARV(subjectProperty, selectedComps);

    if (arv == null || arv <= 0) {
      const sample = selectedComps[0];
      console.warn('ARV failed: comp sample', {
        _id: sample?._id,
        salePrice: sample?.salePrice,
        compScore: sample?.compScore,
        hasRawData: !!(sample?.rawData),
        priceValue: sample?.rawData?.price?.value ?? sample?.rawData?.property?.price?.value,
        hdpViewPrice: sample?.rawData?.hdpView?.price ?? sample?.rawData?.property?.hdpView?.price,
      });
      return next(new CustomError(400, 'Could not calculate ARV from selected comps. Ensure comps have valid sale prices.'));
    }

    // Build response comp list from selectedComps (full DB + in-memory fields) and overlay adjustedPrice from adjustedComps.
    // This ensures address, saleDate, salePrice, distanceMiles, compScore, dataSource are always present (from DB or rawData).
    const adjustedById = new Map(adjustedComps.map((c) => [c._id?.toString(), c]));
    const resolveCompAddress = (c) => {
      if (c.address && typeof c.address === 'string') return c.address;
      if (c.formattedAddress && typeof c.formattedAddress === 'string') return c.formattedAddress;
      const raw = c.rawData && typeof c.rawData.toObject === 'function' ? c.rawData.toObject() : c.rawData;
      if (raw && typeof raw === 'object') {
        const r = raw.property && typeof raw.property === 'object' ? raw.property : raw.data && typeof raw.data === 'object' ? raw.data : raw;
        const addr = r.address;
        if (addr && typeof addr === 'string') return addr;
        if (addr && typeof addr === 'object' && (addr.streetAddress || addr.street)) {
          const parts = [addr.streetAddress || addr.street];
          if (addr.city) parts.push(addr.city);
          if (addr.state) parts.push(addr.state);
          if (addr.zipcode || addr.zipCode || addr.postalCode) parts.push(addr.zipcode || addr.zipCode || addr.postalCode);
          if (parts.length) return parts.join(', ');
        }
        if (r.streetAddress && r.city) return [r.streetAddress, r.city, r.state, r.zipCode || r.postalCode].filter(Boolean).join(', ');
        if (r.fullAddress) return r.fullAddress;
        if (r.formattedAddress) return r.formattedAddress;
      }
      return null;
    };
    const compsForResponse = selectedComps.map((orig) => {
      const plain = orig.toObject ? orig.toObject() : { ...orig };
      const adj = adjustedById.get(orig._id?.toString());
      const addressResolved = resolveCompAddress(plain) || plain.address || plain.formattedAddress;
      const salePriceResolved = plain.salePrice ?? getCompSalePrice(orig);
      return {
        ...plain,
        address: addressResolved || plain.address,
        formattedAddress: plain.formattedAddress || addressResolved,
        salePrice: salePriceResolved,
        adjustedPrice: adj?.adjustedPrice ?? plain.adjustedPrice,
        roomTypeComparisons: orig.roomTypeComparisons,
        imageAnalyses: orig.imageAnalyses,
        aggregatedImageScores: orig.aggregatedImageScores,
        conditionAdjustmentPercent: orig.conditionAdjustmentPercent,
      };
    });

    const validatedMaoInputs = validateMaoInputs(maoInputs);
    const userEstimatedRepairs = validatedMaoInputs.estimatedRepairs || 0;

    // AI (Gemini) repair estimate: use SOP $/sqft from Gemini condition (light/medium/heavy/full gut) + roof + HVAC + 10% buffer
    let aiEstimatedRepairs = null;
    let aiRepairBreakdown = null;
    let aiRepairCostPerSqft = null;
    if (subjectAggregated) {
      const sopResult = estimateRepairsSOPWithBreakdown(subjectProperty, subjectAggregated);
      if (sopResult != null && sopResult.total > 0) {
        aiEstimatedRepairs = sopResult.total;
        aiRepairCostPerSqft = sopResult.costPerSf;
        aiRepairBreakdown = sopResult.breakdown;
        // Add extra when subject is worse than comps (room-type comparison)
        if (selectedComps.length > 0) {
          const avgConditionAdjustment = selectedComps
            .filter((c) => c.conditionAdjustmentPercent != null)
            .reduce((sum, c) => sum + (c.conditionAdjustmentPercent || 0), 0) / (selectedComps.filter((c) => c.conditionAdjustmentPercent != null).length || 1);
          if (avgConditionAdjustment > 0) {
            const compComparisonExtra = Math.round(arv * Math.min(avgConditionAdjustment, 0.15));
            aiEstimatedRepairs = aiEstimatedRepairs + compComparisonExtra;
          }
        }
      } else if (arv) {
        // Fallback when no square footage: use condition % of ARV
        aiEstimatedRepairs = estimateRepairsFromCondition(arv, subjectAggregated);
        if (aiEstimatedRepairs != null && selectedComps.length > 0) {
          const avgConditionAdjustment = selectedComps
            .filter((c) => c.conditionAdjustmentPercent != null)
            .reduce((sum, c) => sum + (c.conditionAdjustmentPercent || 0), 0) / (selectedComps.filter((c) => c.conditionAdjustmentPercent != null).length || 1);
          if (avgConditionAdjustment > 0) {
            aiEstimatedRepairs = aiEstimatedRepairs + Math.round(arv * Math.min(avgConditionAdjustment, 0.15));
          }
        }
      }
    }

    if (!userEstimatedRepairs && !aiEstimatedRepairs) {
      const sopRehab = estimateRepairsSOP(subjectProperty, subjectAggregated);
      if (sopRehab != null && sopRehab > 0) {
        validatedMaoInputs.estimatedRepairs = sopRehab;
      } else if (subjectAggregated && arv) {
        validatedMaoInputs.estimatedRepairs = estimateRepairsFromCondition(arv, subjectAggregated) || Math.round(arv * 0.12);
      } else if (arv) {
        validatedMaoInputs.estimatedRepairs = Math.round(arv * 0.12);
      }
    } else {
      validatedMaoInputs.estimatedRepairs = Math.max(
        userEstimatedRepairs,
        aiEstimatedRepairs != null ? aiEstimatedRepairs : 0
      );
    }

    if (validatedMaoInputs.useSOP === undefined) {
      validatedMaoInputs.useSOP = (validatedMaoInputs.maoRule === 'sop' || validatedMaoInputs.maoRule == null || validatedMaoInputs.maoRule === '');
    }
    let mao = calculateMAO(arv, validatedMaoInputs);

    // SOP: MAO can never be the listed price — our offer must always be below asking. Cap MAO strictly below list.
    const listedPrice = property.price ?? property.askingPrice ?? property.listPrice ?? 0;
    if (listedPrice > 0 && mao && mao.mao >= listedPrice) {
      const maxMAOBelowList = listedPrice - 1; // strictly below list (e.g. $524,999 when list is $525,000)
      const cappedSuggested = Math.round(maxMAOBelowList * 0.95);
      mao = {
        ...mao,
        mao: maxMAOBelowList,
        suggestedOffer: Math.min(mao.suggestedOffer ?? maxMAOBelowList, cappedSuggested),
        cappedByListedPrice: true,
        breakdown: mao.breakdown ? { ...mao.breakdown, baseMAO: maxMAOBelowList } : mao.breakdown,
      };
    }

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
    analysis.userEstimatedRepairs = userEstimatedRepairs;
    analysis.aiEstimatedRepairs = aiEstimatedRepairs != null ? aiEstimatedRepairs : undefined;
    analysis.aiRepairCostPerSqft = aiRepairCostPerSqft != null ? aiRepairCostPerSqft : undefined;
    analysis.aiRepairBreakdown = aiRepairBreakdown || undefined;
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

    // Get condition scores from subject property image analysis (Gemini); defaults when no images
    if (subjectProperty.imageAnalyses && subjectProperty.imageAnalyses.length > 0 && subjectAggregated) {
      analysis.conditionCategory = subjectAggregated.conditionCategory || 'medium-repairs';
      analysis.interiorScore = subjectAggregated.interiorScore ?? 3;
      analysis.exteriorScore = subjectAggregated.exteriorScore ?? 3;
      analysis.overallConditionScore = subjectAggregated.overallConditionScore ?? 5;
      analysis.renovationScore = subjectAggregated.renovationScore ?? 0;
      analysis.damageRiskScore = subjectAggregated.damageRiskScore ?? 0;
    } else {
      analysis.conditionCategory = analysis.conditionCategory || 'medium-repairs';
      analysis.interiorScore = analysis.interiorScore ?? 3;
      analysis.exteriorScore = analysis.exteriorScore ?? 3;
      analysis.overallConditionScore = analysis.overallConditionScore ?? 5;
      analysis.renovationScore = analysis.renovationScore ?? 0;
      analysis.damageRiskScore = analysis.damageRiskScore ?? 0;
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
          repairExtent: analysis.conditionCategory === 'light-repairs' ? 'Light repairs' : analysis.conditionCategory === 'heavy-repairs' ? 'Heavy repairs' : 'Medium repairs',
          estimatedRepairs: analysis.estimatedRepairs,
          userEstimatedRepairs: analysis.userEstimatedRepairs,
          aiEstimatedRepairs: analysis.aiEstimatedRepairs,
          aiRepairCostPerSqft: analysis.aiRepairCostPerSqft,
          aiRepairBreakdown: analysis.aiRepairBreakdown,
          interiorScore: analysis.interiorScore,
          exteriorScore: analysis.exteriorScore,
          overallConditionScore: analysis.overallConditionScore,
          renovationScore: analysis.renovationScore,
          damageRiskScore: analysis.damageRiskScore,
        },
        comps: {
          total: compsForResponse.length,
          selected: compsForResponse.map((comp) => ({
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
            conditionAdjustmentPercent: comp.conditionAdjustmentPercent != null ? comp.conditionAdjustmentPercent : undefined,
            // Room-by-room comp-to-subject comparison (SOP: align room types, compare condition/renovation/damage)
            roomTypeComparisons: (comp.roomTypeComparisons || []).map((r) => ({
              roomType: r.roomType,
              subjectCondition: r.subjectCondition,
              compCondition: r.compCondition,
              conditionDifference: r.conditionDifference,
              adjustmentPercent: r.adjustmentPercent,
              confidence: r.confidence,
              renovationDifference: r.renovationDifference,
              damageDifference: r.damageDifference,
            })),
            // Gemini image analysis for this comp (for display on analysis results)
            imageAnalyses: (comp.imageAnalyses || []).map((a) => sanitizeImageAnalysisForResponse(a)),
            aggregatedImageScores: comp.aggregatedImageScores ? {
              conditionCategory: comp.aggregatedImageScores.conditionCategory,
              interiorScore: comp.aggregatedImageScores.interiorScore,
              exteriorScore: comp.aggregatedImageScores.exteriorScore,
              overallConditionScore: comp.aggregatedImageScores.overallConditionScore,
              renovationScore: comp.aggregatedImageScores.renovationScore,
              damageRiskScore: comp.aggregatedImageScores.damageRiskScore,
              imageConfidence: comp.aggregatedImageScores.imageConfidence,
            } : undefined,
          })),
        },
        // Gemini image analysis for subject property (for display on analysis results)
        subjectImageAnalysis: (subjectProperty.imageAnalyses && subjectProperty.imageAnalyses.length > 0) ? {
          imageAnalyses: subjectProperty.imageAnalyses.map((a) => sanitizeImageAnalysisForResponse(a)),
          aggregated: subjectAggregated ? {
            conditionCategory: subjectAggregated.conditionCategory,
            interiorScore: subjectAggregated.interiorScore,
            exteriorScore: subjectAggregated.exteriorScore,
            overallConditionScore: subjectAggregated.overallConditionScore,
            renovationScore: subjectAggregated.renovationScore,
            damageRiskScore: subjectAggregated.damageRiskScore,
            imageConfidence: subjectAggregated.imageConfidence,
          } : undefined,
        } : undefined,
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
        comparisonSummary: {
          subjectConditionCategory: analysis.conditionCategory,
          subjectRepairExtent: analysis.conditionCategory === 'light-repairs' ? 'Light repairs' : analysis.conditionCategory === 'heavy-repairs' ? 'Heavy repairs' : 'Medium repairs',
          compsCompared: selectedComps.length,
          conditionAdjustmentsApplied: selectedComps.some((c) => c.conditionAdjustmentPercent !== undefined && c.conditionAdjustmentPercent !== 0),
          // What comps have that subject may be missing (from room-type comparisons)
          subjectVsCompSummary: buildSubjectVsCompSummary(subjectProperty, selectedComps),
        },
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
  const { timeWindowMonths = 12, maxResults = 1000, propertyData } = req.body;

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

    // Prepare subject property (normalize address, get metadata). Use propertyData.images (e.g. user-uploaded) when provided.
    if (propertyData?.images?.length > 0) {
      property.images = propertyData.images;
      await property.save().catch(() => {});
    }
    const subjectImagesForSearch = property.images || [];
    console.log(`🔍 Finding comparables for property: ${address}`);
    console.log(`📍 Available coordinates - propertyData: ${propertyData?.latitude}, ${propertyData?.longitude} | property: ${property.latitude}, ${property.longitude}`);
    
    // Prepare subject property (skip image analysis - will run after comp selection)
    const prepared = await prepareSubjectProperty(address, subjectImagesForSearch, true); // skipImageAnalysis = true
    let subjectProperty = prepared.property;
    
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

    // Accept zipcode from propertyData if postalCode not set
    if (!subjectProperty.postalCode && (propertyData?.zipcode ?? propertyData?.zipCode)) {
      const zip = String(propertyData.zipcode ?? propertyData.zipCode).trim();
      subjectProperty.postalCode = zip;
      subjectProperty.zipCode = zip;
      property.postalCode = zip;
    }

    // Merge propertyData into subjectProperty so comp search uses the scraped/subjected property details
    // (e.g. from URL-scraped detail page: bedrooms, bathrooms, livingArea, price, zestimate)
    const pd = propertyData || {};
    const subjectBeds = subjectProperty.beds ?? pd.beds ?? pd.bedrooms;
    const subjectBaths = subjectProperty.baths ?? pd.baths ?? pd.bathrooms;
    const subjectSqft = subjectProperty.squareFootage ?? pd.squareFootage ?? pd.livingArea;
    const subjectPrice = subjectProperty.price ?? pd.price ?? pd.listPrice;
    const subjectEstimated = subjectProperty.estimatedValue ?? pd.estimatedValue ?? pd.zestimate;
    const subjectType = subjectProperty.propertyType ?? pd.propertyType ?? pd.homeType;

    if (subjectBeds != null) {
      subjectProperty.beds = Number(subjectBeds);
      property.beds = Number(subjectBeds);
    }
    if (subjectBaths != null) {
      subjectProperty.baths = Number(subjectBaths);
      property.baths = Number(subjectBaths);
    }
    if (subjectSqft != null) {
      subjectProperty.squareFootage = Number(subjectSqft);
      property.squareFootage = Number(subjectSqft);
    }
    if (subjectPrice != null) {
      subjectProperty.price = Number(subjectPrice);
      property.price = Number(subjectPrice);
    }
    if (subjectEstimated != null) {
      subjectProperty.estimatedValue = Number(subjectEstimated);
      property.estimatedValue = Number(subjectEstimated);
    }
    if (subjectType != null && String(subjectType).trim()) {
      subjectProperty.propertyType = String(subjectType).trim();
      property.propertyType = String(subjectType).trim();
    }

    let propertyUpdated = propertyData?.city || propertyData?.state || propertyData?.postalCode ||
      propertyData?.zipcode || propertyData?.zipCode;
    if (subjectBeds != null || subjectBaths != null || subjectSqft != null || subjectPrice != null || subjectEstimated != null || subjectType != null) {
      propertyUpdated = true;
    }
    if (propertyUpdated) {
      await property.save();
    }

    // Find comparable properties (SOLD properties only)
    // SOP: Prefer 6 months sold; extend to 12 only when needed (low confidence). Initial search always uses 6 months.
    const matchingCriteria = searchParams.matchingCriteria || {
      propertyType: true,
      bedrooms: { tolerance: 1 },
      bathrooms: { tolerance: 1 },
      squareFootage: { tolerance: 0.2, maxDiff: 300 },
      lotSize: { tolerance: 0.5, oversizedThreshold: 20000 },
      yearBuilt: { tolerance: 15 },
      areaType: prepared.areaType,
    };

    console.log(`🔍 Searching for SOLD comparables near: ${subjectProperty.latitude}, ${subjectProperty.longitude}`);
    console.log(`📊 Search parameters: radius=${searchParams.radius}mi, timeWindow=${searchParams.preferredMonths} months (SOP: prefer 6, extend to 12 if needed), propertyType=${subjectProperty.propertyType || 'any'}`);
    console.log(`📍 Subject property: ${subjectProperty.formattedAddress || subjectProperty.address}`);
    console.log(`🏠 Subject property details: ${subjectProperty.beds || '?'} beds, ${subjectProperty.baths || '?'} baths, ${subjectProperty.squareFootage || '?'} sqft`);

    let comps = await findComparableProperties(subjectProperty, {
      latitude: subjectProperty.latitude,
      longitude: subjectProperty.longitude,
      radius: searchParams.radius,
      timeWindowMonths: searchParams.preferredMonths, // SOP: prefer 6 months first; engine expands to 12 when needed
      maxMonths: searchParams.maxMonths,
      maxRadius: searchParams.maxRadius,
      preferredMonths: searchParams.preferredMonths,
      propertyType: subjectProperty.propertyType,
      maxResults: parseInt(maxResults) || 1000,
      matchingCriteria,
    });

    console.log(`📊 Found ${comps.length} SOLD comparable properties after scraping`);

    // Score the comps using the matching criteria from search params
    let scoredComps = scoreComparables(subjectProperty, comps, matchingCriteria);
    const maxScore = scoredComps.length ? Math.max(...scoredComps.map((c) => c.compScore || 0)) : 0;
    const needMore = scoredComps.length < 3 || maxScore < 65;
    const currentRadius = searchParams.radius ?? 0.5;

    // If fewer than 3 comps or best score < 65, expand to 1.0 mi and up to 12 months (SOP: extend to 12 as last resort)
    if (needMore && currentRadius < 1.0) {
      console.log(`⚠️ Few comps (${scoredComps.length}) or low max score (${maxScore}); expanding to 1.0 mi and up to 12 months per SOP`);
      const compsExpanded = await findComparableProperties(subjectProperty, {
        latitude: subjectProperty.latitude,
        longitude: subjectProperty.longitude,
        radius: 1.0,
        timeWindowMonths: searchParams.maxMonths, // SOP: extend to 12 months when needed
        maxMonths: searchParams.maxMonths,
        maxRadius: Math.max(searchParams.maxRadius || 1, 1),
        preferredMonths: searchParams.preferredMonths,
        propertyType: subjectProperty.propertyType,
        maxResults: parseInt(maxResults) || 1000,
        matchingCriteria,
      });
      if (compsExpanded.length > 0) {
        const seen = new Set();
        const mergeKey = (c) => (c.sourceId || c.formattedAddress || c.address || '').toString().trim().toLowerCase();
        for (const c of comps) {
          const key = mergeKey(c);
          if (key) seen.add(key);
        }
        const beforeCount = comps.length;
        for (const c of compsExpanded) {
          const key = mergeKey(c);
          if (key && !seen.has(key)) {
            seen.add(key);
            comps.push(c);
          }
        }
        console.log(`📊 After 1.0 mi expansion: ${comps.length} total comparables (added ${comps.length - beforeCount} new)`);
        scoredComps = scoreComparables(subjectProperty, comps, matchingCriteria);
      }
    }

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
          timeWindowMonths: `${searchParams.preferredMonths} (SOP: extend to ${searchParams.maxMonths} if needed)`,
          propertyType: subjectProperty.propertyType,
        },
      });
    }

    // Sort by comp score and limit
    const sortedComps = scoredComps
      .sort((a, b) => (b.compScore || 0) - (a.compScore || 0))
      .slice(0, parseInt(maxResults) || 1000);

    // Helper: resolve sale price from comp so we always persist it when data exists (e.g. Zillow Sold price.value / hdpView.price)
    const resolveCompSalePrice = (c) => {
      if (c.salePrice != null && c.salePrice > 0) return c.salePrice;
      const raw = c.rawData && typeof c.rawData.toObject === 'function' ? c.rawData.toObject() : c.rawData;
      if (raw && typeof raw === 'object') {
        const r = raw.property && typeof raw.property === 'object' ? raw.property : raw.data && typeof raw.data === 'object' ? raw.data : raw;
        if (r.price?.value != null) return parseFloat(r.price.value);
        if (r.hdpView?.price != null) return parseFloat(r.hdpView.price);
        if (r.salePrice != null) return typeof r.salePrice === 'object' ? parseFloat(r.salePrice.value) : parseFloat(r.salePrice);
        if (r.lastSoldPrice != null) return parseFloat(r.lastSoldPrice);
        if (r.price != null && typeof r.price === 'object' && r.price.amount != null) return parseFloat(r.price.amount);
        if (typeof r.price === 'number') return parseFloat(r.price);
      }
      return c.price != null && c.price > 0 ? c.price : null;
    };

    // Save comps to database
    // Use property._id (from database) as subjectPropertyId
    const dbPropertyId = property._id.toString();

    const savedComps = await Promise.all(
      sortedComps.map(async (comp) => {
        const resolvedSalePrice = resolveCompSalePrice(comp);
        const payload = {
          ...comp,
          subjectPropertyId: dbPropertyId,
          salePrice: resolvedSalePrice ?? comp.salePrice ?? null,
        };

        const existing = await Comparable.findOne({
          subjectPropertyId: dbPropertyId,
          sourceId: comp.sourceId,
          dataSource: comp.dataSource,
        });

        if (existing) {
          Object.assign(existing, payload);
          await existing.save();
          return existing;
        } else {
          const newComp = new Comparable(payload);
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
        salePrice: comp.salePrice ?? resolveCompSalePrice(comp),
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
