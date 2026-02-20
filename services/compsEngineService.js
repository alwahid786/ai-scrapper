import Property from '../models/property.js';
import Comparable from '../models/comparable.js';
import PropertyAnalysis from '../models/propertyAnalysis.js';
import ImageAnalysis from '../models/imageAnalysis.js';
import { normalizeAddress, calculateDistance, getDefaultRadius, determineAreaType } from './googleMapsService.js';
import {
  scrapeZillowProperties,
  scrapeZillowSoldProperties,
  // scrapeRedfinProperties,
  // scrapeRealtorProperties,
  normalizePropertyData,
} from './apifyService.js';
import { analyzePropertyImages, aggregateImageAnalyses } from './geminiService.js';
import { normalizeImageInputs } from '../utils/imagePreprocessing.js';

// --- Asset Hunters SOP Constants (Underwriting) ---
const SOP = {
  /** Comp search: half-mile default, expand to 1 mi in low-confidence mode */
  RADIUS_DEFAULT_MI: 0.5,
  RADIUS_MAX_MI: 1.0,
  /** Prefer 6 months sold, extend to 12 only if needed */
  PREFERRED_MONTHS: 6,
  MAX_MONTHS: 12,
  /** Square footage: within ±300 SF of subject (SOP 3.1) */
  SQFT_MAX_DIFF: 300,
  /** Year built: within ±15 years (SOP 3.1) */
  YEAR_BUILT_TOLERANCE: 15,
  /** Exclude comps with lot size > subject + 20,000 sqft (oversized lot) */
  LOT_OVERSIZED_THRESHOLD_SQFT: 20000,
  /** ARV weighting: Distance 30%, Recency 30%, Similarity 30%, Condition 10% */
  ARV_WEIGHT_DISTANCE: 0.30,
  ARV_WEIGHT_RECENCY: 0.30,
  ARV_WEIGHT_SIMILARITY: 0.30,
  ARV_WEIGHT_CONDITION: 0.10,
  /** Dollar adjustments per SOP Step 5 */
  ADJUSTMENT_PER_BED_BATH: 10000,
  ADJUSTMENT_ONE_VS_TWO_BATH: 15000,
  ADJUSTMENT_PER_100_SQFT: 10000,
  ADJUSTMENT_PER_10K_LOT_SQFT: 10000,
  ADJUSTMENT_GARAGE: 10000,
  ADJUSTMENT_POOL_MIN: 10000,
  ADJUSTMENT_POOL_MAX: 25000,
  CONDITION_PARTIALLY_UPDATED: 5000,
  CONDITION_OUTDATED: 15000,
  /** ARV ceiling: cannot exceed highest comp sale + $10,000 */
  ARV_CEILING_BUFFER: 10000,
  /** Minimum comp score to include in ARV (automation doc: remove comps with score < 60) */
  MIN_COMP_SCORE_FOR_ARV: 60,
  /** Round ARV down to nearest $5,000 */
  ARV_ROUND_TO: 5000,
  /** Rehab $/SF by level (SOP Step 7) */
  REHAB_LIGHT_PER_SF: 15,
  REHAB_MEDIUM_LOW_PER_SF: 20,
  REHAB_MEDIUM_HIGH_PER_SF: 25,
  REHAB_HEAVY_LOW_PER_SF: 30,
  REHAB_HEAVY_HIGH_PER_SF: 35,
  REHAB_FULL_GUT_PER_SF: 40,
  ROOF_COST_PER_SQFT: 8,
  ROOF_TWO_STORY_MULTIPLIER: 1.5,
  HVAC_ONE_UNIT: 7500,
  HVAC_TWO_UNITS: 15000,
  HVAC_DUCTWORK: 7000,
  HVAC_LARGE_HOME_SQFT: 2300,
  REHAB_MISC_BUFFER_PERCENT: 0.10,
  /** MAO: target buyer ROI 7.5%, minimum $20K spread */
  TARGET_BUYER_ROI: 0.075,
  MIN_SPREAD: 20000,
  /** Fix & Flip sheet: All-in Acq = MAO + transactional lender fee + title. Spread = Buyer Price - All-in Acq. */
  MAO_TRANSACTIONAL_LENDER_PERCENT: 0.01,  // 1% of MAO
  MAO_TITLE_PERCENT: 0.02,                 // 2% of MAO (title cc's)
};

/**
 * SOP: Square footage within ±300 SF of subject. Returns max allowed difference in SF.
 * Also used to derive tolerance ratio for backward compatibility (300/subjectSqft).
 */
const getSqftToleranceSOP = (subjectSqft) => {
  if (!subjectSqft || subjectSqft <= 0) return { maxDiff: SOP.SQFT_MAX_DIFF, tolerance: 0.2 };
  const maxDiff = SOP.SQFT_MAX_DIFF;
  const tolerance = maxDiff / subjectSqft; // e.g. 300/2600 ≈ 0.115
  return { maxDiff, tolerance: Math.min(tolerance, 0.3) };
};

const getSqftTolerance = (subjectSqft) => {
  const { tolerance } = getSqftToleranceSOP(subjectSqft);
  return tolerance;
};

/**
 * SOP Step 7: Rehab by level ($/SF) + roof + HVAC + 10% buffer.
 * Light $15/SF, Medium $20–25/SF, Heavy $30–35/SF, Full gut $40/SF.
 * Roof: 2-story = (SF/2)*1.5*$8, 1-story = SF*$8. HVAC: >2300 SF = $15K (2 units), else $7.5K; no ductwork +$7K.
 * If roof/AC age unknown or >10 years, budget replacement. Add 10% miscellaneous buffer.
 * Uses Gemini conditionCategory/damageRiskScore from aggregatedImageScores to pick $/sqft per SOP.
 */
export const estimateRepairsSOPWithBreakdown = (subjectProperty, aggregatedImageScores = null) => {
  const sqft = subjectProperty.squareFootage || subjectProperty.livingArea || 0;
  if (!sqft || sqft <= 0) return null;

  const conditionCategory = aggregatedImageScores?.conditionCategory || 'medium-repairs';
  const damageRiskScore = aggregatedImageScores?.damageRiskScore || 0;
  // SOP Step 7: Light $15/SF, Medium $20–$25/SF, Heavy $30–35/SF, Full gut $40/SF only for full-gut/major repairs.
  // Do not bump heavy to $40 based on damage risk; SOP says Full Gut = "Fire damage, extensive repairs, full system replacements".
  let costPerSf = SOP.REHAB_MEDIUM_HIGH_PER_SF; // default medium $25 (SOP example: 2,632 SF × $25 = $65,800)
  if (conditionCategory === 'light-repairs') costPerSf = SOP.REHAB_LIGHT_PER_SF;
  else if (conditionCategory === 'medium-repairs') costPerSf = SOP.REHAB_MEDIUM_HIGH_PER_SF; // $25/SF per SOP
  else if (conditionCategory === 'heavy-repairs') {
    // SOP: "Average rehab for an outdated property will be $30" — use $32.5 (mid of $30–$35); high damage risk use upper end.
    costPerSf = damageRiskScore >= 70 ? SOP.REHAB_HEAVY_HIGH_PER_SF : (SOP.REHAB_HEAVY_LOW_PER_SF + SOP.REHAB_HEAVY_HIGH_PER_SF) / 2;
  } else if (conditionCategory === 'full-gut' || conditionCategory === 'full-gut-repairs') {
    costPerSf = SOP.REHAB_FULL_GUT_PER_SF; // $40/SF only for full gut / major repairs per SOP
  }

  let baseRehab = sqft * costPerSf;
  let roofCost = 0;
  let hvacCost = 0;

  const stories = subjectProperty.stories ?? subjectProperty.storyCount ?? 1;
  const roofAge = subjectProperty.roofAge ?? subjectProperty.roofAgeYears ?? null;
  const acAge = subjectProperty.acAge ?? subjectProperty.hvacAge ?? subjectProperty.acAgeYears ?? null;
  const roofUnknownOrOld = roofAge == null || roofAge > 10;
  const acUnknownOrOld = acAge == null || acAge > 10;

  if (roofUnknownOrOld) {
    if (stories >= 2) {
      roofCost = (sqft / 2) * SOP.ROOF_TWO_STORY_MULTIPLIER * SOP.ROOF_COST_PER_SQFT;
    } else {
      roofCost = sqft * SOP.ROOF_COST_PER_SQFT;
    }
    baseRehab += roofCost;
  }

  if (acUnknownOrOld) {
    if (sqft >= SOP.HVAC_LARGE_HOME_SQFT) hvacCost = SOP.HVAC_TWO_UNITS;
    else hvacCost = SOP.HVAC_ONE_UNIT;
    if (subjectProperty.noCentralAC || subjectProperty.noDuctwork) hvacCost += SOP.HVAC_DUCTWORK;
    baseRehab += hvacCost;
  }

  const bufferPercent = SOP.REHAB_MISC_BUFFER_PERCENT * 100;
  const withBuffer = baseRehab * (1 + SOP.REHAB_MISC_BUFFER_PERCENT);
  const total = Math.round(withBuffer);

  return {
    total,
    conditionCategory,
    costPerSf,
    breakdown: {
      baseRehab: Math.round(sqft * costPerSf),
      roofCost: Math.round(roofCost),
      hvacCost,
      bufferPercent,
      totalBeforeBuffer: Math.round(baseRehab),
    },
  };
};

/** Returns total only (backward compatible). Uses Gemini condition → SOP $/sqft + roof + HVAC + 10%. */
export const estimateRepairsSOP = (subjectProperty, aggregatedImageScores = null) => {
  const result = estimateRepairsSOPWithBreakdown(subjectProperty, aggregatedImageScores);
  return result ? result.total : null;
};

export const estimateRepairsFromCondition = (arv, aggregatedImageScores) => {
  if (!arv || !aggregatedImageScores) return null;

  const conditionCategory = aggregatedImageScores.conditionCategory || 'medium-repairs';
  let percent = 0.12;
  if (conditionCategory === 'light-repairs') percent = 0.05;
  if (conditionCategory === 'heavy-repairs') percent = 0.25;

  const damageRiskScore = aggregatedImageScores.damageRiskScore || 0;
  if (damageRiskScore > 60) {
    percent = Math.max(percent, 0.3);
  }

  return Math.round(arv * percent);
};

/**
 * PHASE 1: Subject Property Preparation
 */
export const prepareSubjectProperty = async (address, images = [], skipImageAnalysis = false) => {
  const { urls: inputImageUrls, metas: inputImageMetas } = normalizeImageInputs(images);
  let imageUrls = inputImageUrls;
  let imageMetas = [...inputImageMetas];

  // 1.1 Normalize Address
  const normalized = await normalizeAddress(address);
  if (!normalized) {
    throw new Error('Failed to normalize address');
  }

  // Check for duplicates
  let property = await Property.findOne({
    formattedAddress: normalized.formattedAddress,
  });

  if (!property) {
    property = new Property({
      rawAddress: address,
      formattedAddress: normalized.formattedAddress,
      latitude: normalized.latitude,
      longitude: normalized.longitude,
    });
    await property.save();
  }

  // 1.2 Fetch Property Metadata (using Apify if not already fetched)
  // Also fetch images if not provided
  if (!property.beds || !property.baths || !property.squareFootage || (imageUrls.length === 0 && !property.images)) {
    // Try to fetch metadata from Apify
    const { scrapeZillowProperties, normalizePropertyData } = await import('./apifyService.js');
    // const { scrapeRedfinProperties } = await import('./apifyService.js'); // uncomment for Redfin fallback
    const searchParams = {
      address: normalized.formattedAddress,
      latitude: normalized.latitude,
      longitude: normalized.longitude,
      radiusMiles: 0.1,
      maxResults: 1,
      isSold: false, // Get active listing
    };

    try {
      // Zillow only for now; other platforms commented out
      let results = await scrapeZillowProperties(searchParams);
      // if (!results?.success || !results.data || results.data.length === 0) {
      //   results = await scrapeRedfinProperties(searchParams);
      // }
      if (results?.success && results.data && results.data.length > 0) {
        const normalizedData = normalizePropertyData(results.data[0], results.data[0].source || 'zillow');
        
        // Update property with metadata
        property.beds = normalizedData.beds || property.beds;
        property.baths = normalizedData.baths || property.baths;
        property.squareFootage = normalizedData.squareFootage || property.squareFootage;
        property.lotSize = normalizedData.lotSize || property.lotSize;
        property.yearBuilt = normalizedData.yearBuilt || property.yearBuilt;
        property.propertyType = normalizedData.propertyType || property.propertyType;
        property.price = normalizedData.price || normalizedData.salePrice || property.price;
        property.address = normalizedData.address || property.address;
        property.sourceId = normalizedData.sourceId || property.sourceId;
        property.dataSource = normalizedData.dataSource || property.dataSource;
        
        // Store estimated value (Zestimate or similar) if available
        if (normalizedData.estimatedValue || normalizedData.zestimate) {
          property.estimatedValue = normalizedData.estimatedValue || normalizedData.zestimate;
        }
        
        // Get images from the listing (combine with provided images for storage only)
        if (normalizedData.images && normalizedData.images.length > 0) {
          const allImages = [...imageUrls, ...normalizedData.images];
          property.images = [...new Set(allImages)];
          // Only use scraped images for analysis when caller did not provide any (SOP: analyze subject using user-uploaded photos)
          if (imageUrls.length === 0) {
            imageUrls = property.images;
            imageMetas = property.images.map((url, idx) => ({
              url,
              photoType: null,
              captureOrder: idx,
            }));
          }
        }
        
        await property.save();
      }
    } catch (error) {
      console.warn('Failed to fetch property metadata from Apify:', error.message);
    }
  } else if (property.images && property.images.length > 0 && imageUrls.length === 0) {
    // Use stored images if no new images provided
    imageUrls = property.images;
    imageMetas = property.images.map((url, idx) => ({
      url,
      photoType: null,
      captureOrder: idx,
    }));
  }

  if (imageUrls.length > 0) {
    property.images = [...new Set([...(property.images || []), ...imageUrls])];
  }

  // 1.3 Categorize Property Type
  const areaType = determineAreaType(normalized.types);
  const propertyCategory = categorizePropertyType(property.propertyType || 'single-family');

  // Analyze images if provided (PHASE 1: Image Analysis for Subject Property)
  // Only run image analysis if skipImageAnalysis is false (default: run analysis)
  let imageAnalyses = [];
  let aggregatedImageScores = null;

  const analysisInputs = imageMetas.length > 0 ? imageMetas : imageUrls;
  if (analysisInputs && analysisInputs.length > 0 && !skipImageAnalysis) {
    console.log(`Analyzing ${analysisInputs.length} images for subject property using Gemini...`);
    imageAnalyses = await analyzePropertyImages(analysisInputs, {
      address: normalized.formattedAddress,
      propertyType: property.propertyType,
    });

    // Save image analyses
    for (const analysis of imageAnalyses) {
      await ImageAnalysis.create({
        propertyId: property._id,
        ...analysis,
      });
    }

    aggregatedImageScores = aggregateImageAnalyses(imageAnalyses);
    console.log('Subject property image analysis complete:', aggregatedImageScores);
    
    // Store image analyses on property for room-type comparison later
    property.imageAnalyses = imageAnalyses;
    property.aggregatedImageScores = aggregatedImageScores;
  } else if (skipImageAnalysis) {
    console.log('⏭️ Skipping image analysis for subject property (will run after comp selection)');
  }

  return {
    property,
    normalized,
    areaType,
    propertyCategory,
    imageAnalyses,
    aggregatedImageScores,
  };
};

/**
 * Categorize property type
 */
const categorizePropertyType = (propertyType) => {
  if (!propertyType) return 'single-family';

  const type = propertyType.toLowerCase();
  if (type.includes('condo') || type.includes('condominium')) return 'condo';
  if (type.includes('duplex')) return 'duplex';
  if (type.includes('multi') || type.includes('apartment')) return 'multi-unit';
  if (type.includes('vacant') || type.includes('lot')) return 'vacant-lot';
  if (type.includes('manufactured') || type.includes('mobile')) return 'manufactured';
  return 'single-family';
};

/**
 * PHASE 2: Comp Search Preparation
 * SOP: Half-mile radius (0.5 mi), expand to 1.0 mi if <2 strong comps. Prefer 6 months sold, extend to 12.
 * Sqft ±300 SF, Year built ±15 years. Exclude oversized lots (> subject + 20,000 sqft).
 */
export const prepareCompSearch = (subjectProperty, areaType) => {
  // SOP 2.1: Half-mile default; max 1.0 mi in low-confidence mode (Privy-style)
  const defaultRadius = SOP.RADIUS_DEFAULT_MI; // 0.5 mi
  const minRadius = SOP.RADIUS_DEFAULT_MI;
  const maxRadius = SOP.RADIUS_MAX_MI; // 1.0 mi
  // Legacy fallback if not using SOP (e.g. rural): keep area-based expansion
  const maxRadiusLegacy = areaType === 'rural' ? 1.5 : maxRadius;

  // SOP 2.2: Prefer 6 months, extend to 12 only if needed
  const preferredMonths = SOP.PREFERRED_MONTHS; // 6
  const maxMonths = SOP.MAX_MONTHS; // 12

  // SOP 2.3: ±300 SF, ±15 years, oversized lot exclusion; SOP 3.1: stories ideally same (1-story vs 1-story, 2-story vs 2-story)
  const { maxDiff: sqftMaxDiff, tolerance: sqftTolerance } = getSqftToleranceSOP(subjectProperty.squareFootage || 0);
  const matchingCriteria = {
    propertyType: true,
    bedrooms: { tolerance: 1 },
    bathrooms: { tolerance: 1 },
    squareFootage: { tolerance: sqftTolerance, maxDiff: sqftMaxDiff }, // SOP: ±300 SF
    lotSize: { tolerance: 0.5, oversizedThreshold: SOP.LOT_OVERSIZED_THRESHOLD_SQFT }, // Exclude comp lot > subject + 20k
    yearBuilt: { tolerance: SOP.YEAR_BUILT_TOLERANCE }, // SOP: ±15 years
    stories: { tolerance: 1 }, // SOP: ideally same story count (1-story vs 1-story, 2-story vs 2-story); allow ±1
    areaType: areaType,
  };

  return {
    radius: defaultRadius,
    minRadius,
    maxRadius: maxRadiusLegacy,
    preferredMonths,
    maxMonths,
    matchingCriteria,
  };
};

/**
 * Returns true if the given normalized comp is the subject property (same listing).
 * Used to exclude the subject from the comparables list.
 */
const isSubjectProperty = (subjectProperty, normalized) => {
  if (!subjectProperty || !normalized) return false;
  const subAddr = (subjectProperty.formattedAddress || subjectProperty.address || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
  const compAddr = (normalized.formattedAddress || normalized.address || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
  if (subAddr && compAddr && subAddr === compAddr) return true;
  const subId = (subjectProperty.sourceId || subjectProperty.zpid || '').toString().trim();
  const compId = (normalized.sourceId || normalized.zpid || '').toString().trim();
  if (subId && compId && subId === compId) return true;
  const subLat = subjectProperty.latitude ?? subjectProperty.lat;
  const subLng = subjectProperty.longitude ?? subjectProperty.lng ?? subjectProperty.lon;
  const compLat = normalized.latitude;
  const compLng = normalized.longitude;
  if (typeof subLat === 'number' && typeof subLng === 'number' && typeof compLat === 'number' && typeof compLng === 'number') {
    const dist = calculateDistance(subLat, subLng, compLat, compLng);
    if (dist < 0.001) return true;
  }
  return false;
};

/**
 * SOP: Exclude comps "across major roads or highways" (different value profile).
 * Returns true only if we determine the comp is across a major road from the subject.
 * No geographic/road data in codebase; override or integrate with map/road API or shapefile when available.
 * Same-subdivision preference (SOP low-confidence) would also require subdivision data source.
 */
const isAcrossMajorRoad = (subjectProperty, comp) => {
  // Placeholder: no road network data. When available, e.g. check same side of highway or road class.
  return false;
};

/**
 * PHASE 3: Data Source Priority Flow
 * IMPORTANT: This searches for SOLD properties as comparables.
 * Zillow only for now; Redfin, Realtor, MLS, county are commented out.
 *
 * @param {Object} subjectProperty - The subject property object
 * @param {Object} searchParams - Search parameters
 * @param {boolean} isExpansion - Internal flag to prevent recursive loops (default: false)
 */
export const findComparableProperties = async (subjectProperty, searchParams, isExpansion = false) => {
  const { latitude, longitude, radius, timeWindowMonths, propertyType, maxRadius, preferredMonths, maxMonths } = searchParams;
  const comps = [];
  // Zillow Sold actor first (dedicated sold comps), then Zillow URL scraper; other platforms commented out
  const sources = [
    { name: 'zillow-sold', scraper: scrapeZillowSoldProperties },
    { name: 'zillow', scraper: scrapeZillowProperties },
    // { name: 'redfin', scraper: scrapeRedfinProperties },
    // { name: 'realtor', scraper: scrapeRealtorProperties },
    // { name: 'mls', scraper: scrapeMLSProperties },
    // { name: 'county', scraper: scrapeCountyProperties },
  ];

  console.log('Finding SOLD comparable properties for subject property...');
  console.log(`Search params: radius=${radius}mi, timeWindow=${timeWindowMonths} months, propertyType=${propertyType}`);
  if (isExpansion) {
    console.log('⚠️ This is an expansion search - will not expand further to prevent loops');
  }

  // SOP: Prefer 6 months sold; expand to 12 only if <3 comps
  let currentTimeWindow = timeWindowMonths ?? preferredMonths ?? SOP.PREFERRED_MONTHS;
  let currentRadius = radius;
  const sqftMaxDiff = searchParams.matchingCriteria?.squareFootage?.maxDiff ?? SOP.SQFT_MAX_DIFF;
  let primarySourceConfig = null;
  let foundHigherPrioritySource = false;

  // PHASE 3.1: Check sources in priority order
  // Zillow only; Redfin, Realtor, MLS, county commented out.
  for (let i = 0; i < sources.length; i++) {
    const sourceConfig = sources[i];
    const compsBefore = comps.length;
    const source = sourceConfig.name;
    const scraper = sourceConfig.scraper;

    try {
      let results;
      const subjectBeds = subjectProperty.beds ?? subjectProperty.bedrooms;
      const subjectBaths = subjectProperty.baths ?? subjectProperty.bathrooms;
      const subjectSqft = subjectProperty.squareFootage ?? subjectProperty.livingArea;
      const subjectPrice = subjectProperty.estimatedValue ?? subjectProperty.zestimate ?? subjectProperty.price ?? 0;
      const priceMargin = subjectPrice > 0 ? Math.round(subjectPrice * 0.2) : 0;

      // SOP: Sqft within ±300 SF of subject (min/max in SF)
      const minSqft = subjectSqft != null && subjectSqft > 0 ? Math.max(0, Math.round(subjectSqft - sqftMaxDiff)) : undefined;
      const maxSqft = subjectSqft != null && subjectSqft > 0 ? Math.round(subjectSqft + sqftMaxDiff) : undefined;

      const compSearchParams = {
        address: subjectProperty.formattedAddress || subjectProperty.address,
        city: subjectProperty.city || subjectProperty.addressComponents?.city,
        state: subjectProperty.state || subjectProperty.addressComponents?.state,
        postalCode: subjectProperty.postalCode || subjectProperty.zipCode || subjectProperty.addressComponents?.zipCode,
        latitude,
        longitude,
        radiusMiles: currentRadius,
        propertyType,
        soldWithinMonths: currentTimeWindow,
        isSold: true,
        minBeds: subjectBeds != null && subjectBeds >= 1 ? subjectBeds - 1 : 0,
        maxBeds: subjectBeds != null ? subjectBeds + 1 : 0,
        minBaths: subjectBaths != null && subjectBaths >= 1 ? subjectBaths - 1 : 0,
        minSqft,
        maxSqft,
        minPrice: subjectPrice > 0 ? subjectPrice - priceMargin : undefined,
        maxPrice: subjectPrice > 0 ? subjectPrice + priceMargin : undefined,
      };
      
      console.log(`🔍 Comp search params for ${source} (priority ${i + 1}/${sources.length}):`, {
        address: compSearchParams.address,
        city: compSearchParams.city,
        state: compSearchParams.state,
        postalCode: compSearchParams.postalCode,
        coordinates: `${compSearchParams.latitude}, ${compSearchParams.longitude}`,
        radius: `${compSearchParams.radiusMiles}mi`,
        isSold: compSearchParams.isSold,
        soldWithinMonths: compSearchParams.soldWithinMonths,
      });

      console.log(`Searching ${source} for SOLD comparables with params:`, compSearchParams);

      // Use the appropriate scraper function
      results = await scraper(compSearchParams);

      console.log(`${source} comps search result:`, {
        success: results?.success,
        count: results?.data?.length || 0,
      });

      if (results?.success && results.data && Array.isArray(results.data) && results.data.length > 0) {
        console.log(`📦 ${source} returned ${results.data.length} raw properties, checking for SOLD properties...`);
        
        for (const rawData of results.data) {
          const normalized = normalizePropertyData(rawData, source);
          
          if (!normalized) {
            console.warn(`⚠️ Failed to normalize property data from ${source}`);
            continue;
          }
          
          // Log extracted data for debugging
          console.log(`  📊 Normalized comp data from ${source}:`, {
            address: normalized.address,
            price: normalized.price,
            salePrice: normalized.salePrice,
            listingStatus: normalized.listingStatus,
            imagesCount: normalized.images?.length || 0,
            beds: normalized.beds,
            baths: normalized.baths,
            sqft: normalized.squareFootage,
          });
          
          // Only include SOLD properties as comparables
          // Check multiple indicators that a property is sold
          const listingStatus = normalized.listingStatus?.toLowerCase() || '';
          const hasSaleDate = normalized.saleDate !== null && normalized.saleDate !== undefined;
          const hasSalePrice = normalized.salePrice !== null && normalized.salePrice !== undefined && normalized.salePrice > 0;
          
          // For sold properties, salePrice should be set (from price.value when listingStatus is sold)
          // If we're searching for sold properties (isSold: true), and we have a price but no salePrice,
          // check if the listingStatus indicates it's sold, then use price as salePrice
          if (!hasSalePrice && normalized.price && listingStatus === 'sold') {
            normalized.salePrice = normalized.price;
            console.log(`  📝 Using price as salePrice for sold property: ${normalized.address} - $${normalized.salePrice}`);
          }
          
          // Property is considered SOLD if:
          // 1. listingStatus contains "sold"
          // 2. OR has a saleDate
          // 3. OR has a salePrice (and no current price, or salePrice is different from price)
          // 4. OR we're searching for sold properties and listingStatus is "sold" (even if salePrice not yet set)
          const isSold = listingStatus === 'sold' || 
                        listingStatus.includes('sold') ||
                        hasSaleDate ||
                        (hasSalePrice && (!normalized.price || normalized.salePrice !== normalized.price)) ||
                        (listingStatus === 'sold' && normalized.price); // If status is sold and we have a price, treat as sold
          
          console.log(`  Checking property: ${normalized.address || 'unknown'}`, {
            listingStatus,
            hasSaleDate,
            hasSalePrice,
            saleDate: normalized.saleDate,
            salePrice: normalized.salePrice,
            price: normalized.price,
            isSold,
            rawListingStatus: rawData.listing?.listingStatus || rawData.listingStatus || rawData.status,
          });
          
          if (!isSold) {
            console.log(`  ❌ Skipping non-sold property from ${source}:`, normalized.address, `(status: ${listingStatus}, saleDate: ${normalized.saleDate}, salePrice: ${normalized.salePrice})`);
            continue;
          }
          
          // Ensure salePrice is set for sold properties (use price if salePrice not available)
          if (!normalized.salePrice && normalized.price) {
            normalized.salePrice = normalized.price;
            console.log(`  📝 Setting salePrice from price for sold property: ${normalized.address} - $${normalized.salePrice}`);
          }
          
          console.log(`  ✅ Found SOLD property: ${normalized.address} - Sale: $${normalized.salePrice || normalized.price || 'N/A'} on ${normalized.saleDate || 'N/A'}`);

          // Ensure latitude/longitude for DB (required by Comparable model)
          const compLat = normalized.latitude ?? rawData.location?.latitude ?? rawData.latitude;
          const compLng = normalized.longitude ?? rawData.location?.longitude ?? rawData.longitude;
          const hasValidCoords = typeof compLat === 'number' && !Number.isNaN(compLat) && typeof compLng === 'number' && !Number.isNaN(compLng);
          if (!hasValidCoords) {
            console.warn(`  ⚠️ Skipping comp (missing lat/lng): ${normalized.address}`);
            continue;
          }
          normalized.latitude = compLat;
          normalized.longitude = compLng;

          const distance = calculateDistance(
            latitude,
            longitude,
            normalized.latitude,
            normalized.longitude
          );

          // Only show comps within the configured radius (document: Urban 0.25–0.5, Suburban 0.5–1.0, Rural 1–2 mi)
          if (distance > currentRadius) {
            console.log(`  ⏭️ Skipping comp outside radius: ${normalized.address} (${distance.toFixed(2)} mi > ${currentRadius} mi)`);
            continue;
          }

          // SOP: Comps must be in same ZIP (immediate neighborhood). Apply to both initial and expanded search.
          const subjectZip = (subjectProperty.postalCode || subjectProperty.zipCode || subjectProperty.addressComponents?.zipCode || '').toString().trim();
          const compZipRaw = normalized.postalCode || normalized.zipCode || normalized.zipcode || (normalized.addressComponents && (normalized.addressComponents.zipCode || normalized.addressComponents.postalCode)) || '';
          const compZip = compZipRaw ? compZipRaw.toString().trim() : (normalized.formattedAddress || normalized.address || '').match(/\b(\d{5})(-\d{4})?$/)?.[1] || '';
          if (subjectZip && compZip) {
            const subjectZip5 = subjectZip.replace(/-?\d{4}$/, '').slice(0, 5);
            const compZip5 = compZip.replace(/-?\d{4}$/, '').slice(0, 5);
            if (subjectZip5 !== compZip5) {
              console.log(`  ⏭️ Skipping comp in different ZIP: ${normalized.address} (comp ZIP ${compZip5} ≠ subject ${subjectZip5})`);
              continue;
            }
          }

          // SOP: Exclude properties across major roads/highways (different value profile). No geographic data available;
          // plug in isAcrossMajorRoad when road/same-side data exists (e.g. map API or shapefile).
          if (isAcrossMajorRoad(subjectProperty, normalized)) {
            console.log(`  ⏭️ Skipping comp across major road: ${normalized.address}`);
            continue;
          }

          // Fetch full property details by URL only when comps did NOT come from Zillow Sold actor
          // (Zillow Sold actor already returns full details: address, beds, baths, sqft, price, photos, etc.)
          const skipDetailFetch = source === 'zillow-sold';
          if (!skipDetailFetch) {
            let fullCompDetails = null;
            const compPropertyUrl = normalized.propertyUrl || normalized.zillowUrl || normalized.url;
            const compZpid = normalized.zpid || normalized.sourceId;

            if (compPropertyUrl || compZpid) {
              try {
                console.log(`  🔍 Fetching full details for comp: ${normalized.address}`);
                const { fetchZillowPropertyDetailsByUrl } = await import('../services/apifyService.js');

                let detailUrl = compPropertyUrl;
                if (!detailUrl && compZpid) {
                  detailUrl = `https://www.zillow.com/homedetails/${compZpid}_zpid/`;
                }

                if (detailUrl) {
                  const detailResult = await fetchZillowPropertyDetailsByUrl(detailUrl);

                  if (detailResult && detailResult.property) {
                    fullCompDetails = detailResult.property;

                    if (detailResult.images && detailResult.images.length > 0) {
                      normalized.images = detailResult.images;
                      console.log(`  ✅ Fetched ${detailResult.images.length} images from property detail page`);
                    }

                    if (!normalized.beds && fullCompDetails.beds) normalized.beds = fullCompDetails.beds;
                    if (!normalized.baths && fullCompDetails.baths) normalized.baths = fullCompDetails.baths;
                    if (!normalized.squareFootage && fullCompDetails.squareFootage) normalized.squareFootage = fullCompDetails.squareFootage;
                    if (!normalized.lotSize && fullCompDetails.lotSize) normalized.lotSize = fullCompDetails.lotSize;
                    if (!normalized.yearBuilt && fullCompDetails.yearBuilt) normalized.yearBuilt = fullCompDetails.yearBuilt;
                    if (!normalized.propertyType && fullCompDetails.propertyType) normalized.propertyType = fullCompDetails.propertyType;

                    console.log(`  ✅ Successfully fetched full details for comp: ${normalized.address}`);
                  } else {
                    console.warn(`  ⚠️ Could not fetch full details for comp: ${normalized.address}`);
                  }
                }
              } catch (detailError) {
                console.warn(`  ⚠️ Error fetching full details for comp ${normalized.address}:`, detailError.message);
              }
            }
          } else {
            console.log(`  ⏭️ Skipping detail-by-URL fetch for comp (source is zillow-sold; already have full details)`);
          }

          // SKIP image analysis when finding comps - will run after user selects comps
          // Image analysis will be performed in analyzeSelectedComps for selected comps only
          console.log(`  ⏭️ Skipping image analysis for comp ${normalized.address} (will run after comp selection)`);
          
          // Set default condition rating (will be updated after image analysis)
          normalized.conditionRating = 3; // Default to average
          normalized.renovationIndicators = [];
          normalized.damageFlags = [];
          
          // No room-type comparison at this stage (will be done after comp selection)
          let roomTypeComparisons = [];

          // Skip if this comp is the subject property (same listing)
          if (isSubjectProperty(subjectProperty, normalized)) {
            console.log(`  ⏭️ Skipping subject property from comparables: ${normalized.address || normalized.formattedAddress}`);
            continue;
          }

          // Ensure all required fields are present
          const compData = {
            ...normalized,
            distanceMiles: distance,
            subjectPropertyId: subjectProperty._id,
            conditionRating: normalized.conditionRating || 3, // Default to average if no images
            renovationIndicators: normalized.renovationIndicators || [],
            damageFlags: normalized.damageFlags || [],
            roomTypeComparisons: roomTypeComparisons.length > 0 ? roomTypeComparisons : undefined,
            conditionAdjustment: normalized.conditionAdjustment || 0,
            conditionAdjustmentPercent: normalized.conditionAdjustmentPercent || 0,
            // Ensure salePrice is set for sold properties
            salePrice: normalized.salePrice || normalized.price || null,
            // Ensure images array is present
            images: normalized.images || [],
            // Ensure listingStatus is set
            listingStatus: normalized.listingStatus || 'sold',
          };
          
          console.log(`  💾 Saving comp: ${compData.address} - Sale: $${compData.salePrice}, Images: ${compData.images.length}, Status: ${compData.listingStatus}`);
          
          comps.push(compData);
        }

        // If this source returned SOLD comps, mark it as primary and skip lower-priority sources
        if (comps.length > compsBefore) {
          primarySourceConfig = sourceConfig;
          foundHigherPrioritySource = true;
          console.log(`✅ Found ${comps.length - compsBefore} SOLD comparables from ${source} (priority ${i + 1}/${sources.length})`);
          console.log(`✅ Using ${source} as primary source; skipping lower-priority sources as per document requirement`);
          break; // Stop checking lower-priority sources per document: "If a higher-source dataset is available, lower sources are ignored"
        } else {
          console.log(`⚠️ ${source} returned results but no valid SOLD comparables found. Continuing to next source...`);
        }
      } else {
        console.log(`⚠️ ${source} returned no results. Continuing to next source...`);
      }
    } catch (error) {
      console.error(`Error fetching SOLD comps from ${source}:`, error.message);
      // Continue to next source even on error
      console.log(`Continuing to next source after error from ${source}...`);
    }
  }

  console.log(`Total SOLD comparables found: ${comps.length}`);

  // SOP Low Confidence: "strong comp" = within 0.5 mi AND sold within 6 months. Expand when <2 strong comps or <3 total.
  const countStrongComps = (compList) => {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    return compList.filter((c) => {
      const distOk = (c.distanceMiles ?? 999) <= SOP.RADIUS_DEFAULT_MI;
      const saleDate = c.saleDate ? new Date(c.saleDate) : null;
      const recencyOk = saleDate && saleDate >= sixMonthsAgo;
      return distOk && recencyOk;
    }).length;
  };
  const strongCount = countStrongComps(comps);
  const needsExpansion = strongCount < 2 || comps.length < 3;

  // IMPORTANT: Only expand if this is NOT already an expansion search
  // SOP: Expand when <2 strong comps within 0.5 mi (or <3 comps total)
  if (needsExpansion && !isExpansion && primarySourceConfig) {
    console.log(`⚠️ Low confidence: ${strongCount} strong comps (within 0.5 mi, ≤6 mo), ${comps.length} total. Attempting to expand search...`);
    const source = primarySourceConfig.name;
    const scraper = primarySourceConfig.scraper;
    const effectiveMaxRadius = maxRadius || 2.5;

    // Try to expand, but don't require 3 comps - return whatever we find
    while (comps.length < 3 && (currentTimeWindow < (maxMonths || 12) || currentRadius < effectiveMaxRadius)) {
      if (currentTimeWindow < (maxMonths || 12)) {
        const prev = currentTimeWindow;
        currentTimeWindow = Math.min(currentTimeWindow + 3, maxMonths || 12);
        console.log(`Expanding time window from ${prev} to ${currentTimeWindow} months`);
      } else if (currentRadius < effectiveMaxRadius) {
        const expansionIncrement = currentRadius >= 1.5 ? 0.5 : 0.25;
        const prev = currentRadius;
        currentRadius = Math.min(currentRadius + expansionIncrement, effectiveMaxRadius);
        console.log(`Expanding radius from ${prev} to ${currentRadius} miles`);
      }

      try {
        const subjectBeds = subjectProperty.beds ?? subjectProperty.bedrooms;
        const subjectBaths = subjectProperty.baths ?? subjectProperty.bathrooms;
        const subjectSqft = subjectProperty.squareFootage ?? subjectProperty.livingArea;
        const subjectPrice = subjectProperty.estimatedValue ?? subjectProperty.zestimate ?? subjectProperty.price ?? 0;
        const priceMargin = subjectPrice > 0 ? Math.round(subjectPrice * 0.2) : 0;

        const sqftMaxDiffExp = searchParams.matchingCriteria?.squareFootage?.maxDiff ?? SOP.SQFT_MAX_DIFF;
        const minSqftExp = subjectSqft != null && subjectSqft > 0 ? Math.max(0, Math.round(subjectSqft - sqftMaxDiffExp)) : undefined;
        const maxSqftExp = subjectSqft != null && subjectSqft > 0 ? Math.round(subjectSqft + sqftMaxDiffExp) : undefined;
        const compSearchParams = {
          address: subjectProperty.formattedAddress || subjectProperty.address,
          city: subjectProperty.city || subjectProperty.addressComponents?.city,
          state: subjectProperty.state || subjectProperty.addressComponents?.state,
          postalCode: subjectProperty.postalCode || subjectProperty.zipCode || subjectProperty.addressComponents?.zipCode,
          latitude,
          longitude,
          radiusMiles: currentRadius,
          propertyType,
          soldWithinMonths: currentTimeWindow,
          isSold: true,
          minBeds: subjectBeds != null && subjectBeds >= 1 ? subjectBeds - 1 : 0,
          maxBeds: subjectBeds != null ? subjectBeds + 1 : 0,
          minBaths: subjectBaths != null && subjectBaths >= 1 ? subjectBaths - 1 : 0,
          minSqft: minSqftExp,
          maxSqft: maxSqftExp,
          minPrice: subjectPrice > 0 ? subjectPrice - priceMargin : undefined,
          maxPrice: subjectPrice > 0 ? subjectPrice + priceMargin : undefined,
        };

        console.log(`Expansion search: ${source} with radius ${currentRadius}mi, window ${currentTimeWindow} months`);
        const results = await scraper(compSearchParams);

        if (results?.success && results.data && Array.isArray(results.data) && results.data.length > 0) {
          for (const rawData of results.data) {
            const normalized = normalizePropertyData(rawData, source);
            if (!normalized) continue;

            const listingStatus = normalized.listingStatus?.toLowerCase() || '';
            const hasSaleDate = normalized.saleDate !== null && normalized.saleDate !== undefined;
            const hasSalePrice = normalized.salePrice !== null && normalized.salePrice !== undefined && normalized.salePrice > 0;
            
            if (!hasSalePrice && normalized.price && listingStatus === 'sold') {
              normalized.salePrice = normalized.price;
            }
            
            const isSold = listingStatus === 'sold' || 
                          listingStatus.includes('sold') ||
                          hasSaleDate ||
                          (hasSalePrice && (!normalized.price || normalized.salePrice !== normalized.price)) ||
                          (listingStatus === 'sold' && normalized.price);
            
            if (!isSold) continue;
            
            if (!normalized.salePrice && normalized.price) {
              normalized.salePrice = normalized.price;
            }

            const compLat = normalized.latitude ?? rawData.location?.latitude ?? rawData.latitude;
            const compLng = normalized.longitude ?? rawData.location?.longitude ?? rawData.longitude;
            const hasValidCoords = typeof compLat === 'number' && !Number.isNaN(compLat) && typeof compLng === 'number' && !Number.isNaN(compLng);
            if (!hasValidCoords) continue;
            normalized.latitude = compLat;
            normalized.longitude = compLng;

            const distance = calculateDistance(latitude, longitude, normalized.latitude, normalized.longitude);
            if (distance > currentRadius) continue;

            // Skip if this comp is the subject property (same listing)
            if (isSubjectProperty(subjectProperty, normalized)) {
              console.log(`  ⏭️ [Expansion] Skipping subject property from comparables: ${normalized.address || normalized.formattedAddress}`);
              continue;
            }

            // SOP Low Confidence: when expanded (up to 1 mi), comps must be in same ZIP as subject
            const subjectZip = (subjectProperty.postalCode || subjectProperty.zipCode || '').toString().trim();
            const compZipRaw = normalized.postalCode || normalized.zipCode || normalized.zipcode || '';
            const compZip = compZipRaw ? compZipRaw.toString().trim() : (normalized.formattedAddress || normalized.address || '').match(/\b(\d{5})(-\d{4})?$/)?.[1] || '';
            if (subjectZip && compZip) {
              const subjectZip5 = subjectZip.replace(/-?\d{4}$/, '').slice(0, 5);
              const compZip5 = compZip.replace(/-?\d{4}$/, '').slice(0, 5);
              if (subjectZip5 !== compZip5) {
                continue; // Skip comp in different ZIP
              }
            }

            const existingAddress = comps.find(c =>
              c.formattedAddress?.toLowerCase() === normalized.formattedAddress?.toLowerCase()
            );

            if (!existingAddress) {
              comps.push({
                ...normalized,
                distanceMiles: distance,
                subjectPropertyId: subjectProperty._id,
                conditionRating: normalized.conditionRating || 3,
                renovationIndicators: normalized.renovationIndicators || [],
                damageFlags: normalized.damageFlags || [],
                salePrice: normalized.salePrice || normalized.price || null,
                images: normalized.images || [],
                listingStatus: normalized.listingStatus || 'sold',
              });
            }
          }
        }
      } catch (error) {
        console.error(`Error in expansion search from ${source}:`, error.message);
      }

      console.log(`After expansion step: ${comps.length} total comps`);
    }

    if (comps.length < 3) {
      console.warn(`⚠️ Only found ${comps.length} comps after expansions. Returning available comps.`);
    }
  } else if (comps.length < 3 && isExpansion) {
    console.log(`⚠️ Expansion search found ${comps.length} comps. No further expansion to prevent loops.`);
  }

  return comps;
};

/**
 * Check if a comp meets minimum attribute matching requirements
 * Returns true if comp passes all required filters
 */
const meetsAttributeMatchingCriteria = (subjectProperty, comp, matchingCriteria) => {
  // Property type must match (required)
  if (matchingCriteria.propertyType === true) {
    const subjectType = (subjectProperty.propertyType || '').toLowerCase();
    const compType = (comp.propertyType || '').toLowerCase();
    
    // Normalize property types for comparison
    const normalizeType = (type) => {
      if (!type) return '';
      type = type.toLowerCase();
      if (type.includes('single') || type.includes('family') || type.includes('house')) return 'single-family';
      if (type.includes('condo') || type.includes('condominium')) return 'condo';
      if (type.includes('duplex')) return 'duplex';
      if (type.includes('multi') || type.includes('apartment')) return 'multi-unit';
      if (type.includes('vacant') || type.includes('lot')) return 'vacant-lot';
      if (type.includes('manufactured') || type.includes('mobile')) return 'manufactured';
      return type;
    };
    
    const normalizedSubject = normalizeType(subjectType);
    const normalizedComp = normalizeType(compType);
    
    if (normalizedSubject && normalizedComp && normalizedSubject !== normalizedComp) {
      return false; // Property type doesn't match
    }
  }
  
  // Bedrooms: ±1 tolerance
  if (matchingCriteria.bedrooms && matchingCriteria.bedrooms.tolerance !== undefined) {
    const subjectBeds = subjectProperty.beds || 0;
    const compBeds = comp.beds || 0;
    const bedDiff = Math.abs(compBeds - subjectBeds);
    if (bedDiff > matchingCriteria.bedrooms.tolerance) {
      return false;
    }
  }
  
  // Bathrooms: ±1 tolerance
  if (matchingCriteria.bathrooms && matchingCriteria.bathrooms.tolerance !== undefined) {
    const subjectBaths = subjectProperty.baths || 0;
    const compBaths = comp.baths || 0;
    const bathDiff = Math.abs(compBaths - subjectBaths);
    if (bathDiff > matchingCriteria.bathrooms.tolerance) {
      return false;
    }
  }
  
  // Square footage: SOP ±300 SF (use maxDiff if provided, else tolerance ratio)
  if (matchingCriteria.squareFootage) {
    const subjectSqft = subjectProperty.squareFootage || 0;
    const compSqft = comp.squareFootage || 0;
    if (subjectSqft > 0 && compSqft > 0) {
      const diff = Math.abs(compSqft - subjectSqft);
      if (matchingCriteria.squareFootage.maxDiff != null) {
        if (diff > matchingCriteria.squareFootage.maxDiff) return false;
      } else if (matchingCriteria.squareFootage.tolerance != null) {
        if (diff / subjectSqft > matchingCriteria.squareFootage.tolerance) return false;
      }
    }
  }

  // Lot size: SOP exclude oversized lots (comp lot > subject + 20,000 sqft)
  if (matchingCriteria.lotSize) {
    const subjectLot = Number(subjectProperty.lotSize) || 0;
    const compLot = Number(comp.lotSize) || 0;
    const oversizedThreshold = matchingCriteria.lotSize.oversizedThreshold ?? SOP.LOT_OVERSIZED_THRESHOLD_SQFT;
    if (subjectLot > 0 && compLot > 0 && compLot > subjectLot + oversizedThreshold) {
      return false; // Luxury/oversized lot - exclude per SOP
    }
    // Optional: ±50% tolerance when no oversized threshold (legacy)
    if (matchingCriteria.lotSize.tolerance != null && matchingCriteria.lotSize.tolerance < 1 && !matchingCriteria.lotSize.oversizedThreshold) {
      const areaType = matchingCriteria.areaType || 'suburban';
      if (areaType !== 'urban' && subjectLot > 0 && compLot > 0) {
        const lotDiff = Math.abs(compLot - subjectLot) / subjectLot;
        if (lotDiff > matchingCriteria.lotSize.tolerance) return false;
      }
    }
  }

  // Year built: SOP ±15 years
  if (matchingCriteria.yearBuilt && matchingCriteria.yearBuilt.tolerance !== undefined) {
    const subjectYear = subjectProperty.yearBuilt || 0;
    const compYear = comp.yearBuilt || 0;
    const tolerance = matchingCriteria.yearBuilt.tolerance; // SOP: 15
    if (subjectYear > 0 && compYear > 0) {
      const yearDiff = Math.abs(compYear - subjectYear);
      if (yearDiff > tolerance) return false;
    }
  }

  // Stories: SOP ideally same (1-story vs 1-story, 2-story vs 2-story); allow ±1 when both have data
  if (matchingCriteria.stories && matchingCriteria.stories.tolerance !== undefined) {
    const subjectStories = subjectProperty.stories ?? subjectProperty.storyCount ?? null;
    const compStories = comp.stories ?? comp.storyCount ?? null;
    if (subjectStories != null && compStories != null) {
      const tolerance = matchingCriteria.stories.tolerance; // 1
      if (Math.abs(compStories - subjectStories) > tolerance) return false;
    }
  }

  return true; // Passes all criteria
};

/**
 * Align room types for comp-to-subject photo comparison
 * Matches images by room type (Kitchen vs Kitchen, Bathroom vs Bathroom, etc.)
 */
export const alignRoomTypesForComparison = (subjectImageAnalyses, compImageAnalyses) => {
  const roomTypeMap = {
    'kitchen': 'kitchen',
    'bathroom': 'bathroom',
    'bedroom': 'bedroom',
    'living-room': 'living-room',
    'exterior-front': 'exterior-front',
    'exterior-back': 'exterior-back',
    'basement': 'basement',
    'garage': 'garage',
    'backyard': 'backyard',
    'roof': 'roof',
  };
  
  const alignedComparisons = [];
  
  // Group images by room type
  const subjectByType = {};
  const compByType = {};
  
  subjectImageAnalyses.forEach(analysis => {
    const type = analysis.imageType || 'uncertain';
    if (!subjectByType[type]) subjectByType[type] = [];
    subjectByType[type].push(analysis);
  });
  
  compImageAnalyses.forEach(analysis => {
    const type = analysis.imageType || 'uncertain';
    if (!compByType[type]) compByType[type] = [];
    compByType[type].push(analysis);
  });
  
  // Compare matching room types
  for (const roomType in roomTypeMap) {
    const subjectImages = subjectByType[roomType] || [];
    const compImages = compByType[roomType] || [];
    
    if (subjectImages.length > 0 && compImages.length > 0) {
      // Compare best quality images from each
      const bestSubject = subjectImages.reduce((best, current) => 
        (current.confidence || 0) > (best.confidence || 0) ? current : best
      );
      const bestComp = compImages.reduce((best, current) => 
        (current.confidence || 0) > (best.confidence || 0) ? current : best
      );
      
      const subjectScore = bestSubject.conditionScore || 3;
      const compScore = bestComp.conditionScore || 3;
      const conditionDifference = compScore - subjectScore;
      
      // Calculate confidence-weighted difference (use average confidence of both images)
      const avgConfidence = ((bestSubject.confidence || 50) + (bestComp.confidence || 50)) / 2;
      const confidenceWeight = avgConfidence / 100; // Normalize to 0-1
      
      // Calculate adjustment percentage based on condition difference
      // Each point of difference (on 1-5 scale) = 3% adjustment (more granular than before)
      // Positive difference = comp is better = adjust comp value down (subject needs work)
      // Negative difference = subject is better = adjust comp value up (subject is nicer)
      const baseAdjustmentPercent = conditionDifference * 0.03; // 3% per point
      const adjustedPercent = baseAdjustmentPercent * confidenceWeight; // Weight by confidence
      
      alignedComparisons.push({
        roomType,
        subjectImage: bestSubject,
        compImage: bestComp,
        conditionDifference,
        adjustmentPercent: adjustedPercent,
        confidence: avgConfidence,
        // Additional details for better analysis
        subjectCondition: subjectScore,
        compCondition: compScore,
        renovationDifference: {
          subject: (bestSubject.renovationIndicators || []).length,
          comp: (bestComp.renovationIndicators || []).length,
        },
        damageDifference: {
          subject: (bestSubject.damageFlags || []).length,
          comp: (bestComp.damageFlags || []).length,
        },
      });
    }
  }
  
  return alignedComparisons;
};

/**
 * PHASE 4: Comp Scoring Algorithm
 * Filters comps by attribute matching criteria before scoring
 */
export const scoreComparables = (subjectProperty, comps, matchingCriteria) => {
  if (!comps || comps.length === 0) {
    return [];
  }

  // Filter comps that don't meet minimum matching criteria
  const filteredComps = comps.filter(comp => {
    const meetsCriteria = meetsAttributeMatchingCriteria(subjectProperty, comp, matchingCriteria);
    if (!meetsCriteria) {
      console.log(`Comp filtered out (doesn't meet criteria): ${comp.address || comp.formattedAddress}`);
    }
    return meetsCriteria;
  });
  
  console.log(`Filtered ${comps.length} comps to ${filteredComps.length} that meet attribute matching criteria`);
  
  if (filteredComps.length === 0) {
    console.warn('No comps meet the attribute matching criteria - returning all comps with lower scores');
    // Fallback: return all comps but mark them as low quality
    return comps.map(comp => ({
      ...comp,
      compScore: 0,
      filteredOut: true,
    }));
  }

  // SOP Step 6: Comp Score = Distance 30% + Recency 30% + Similarity 30% + Condition 10%
  // Distance: 0–0.25 mi = strongest (100), 0.25–0.5 = strong (70), 0.5–1.0 = weak (40)
  // Recency: <3 mo = strongest (100), 3–6 = strong (70), 6–12 = weak (40)
  // Similarity: Beds/Baths, SqFt (±300 SF), Year built (±15 yr), Story count (SOP: ideally same)
  const scoredComps = filteredComps.map((comp) => {
    const distMi = comp.distanceMiles || 0;
    let distanceScore = 40;
    if (distMi <= 0.25) distanceScore = 100;
    else if (distMi <= 0.5) distanceScore = 70;
    else if (distMi <= 1.0) distanceScore = 40;
    else distanceScore = Math.max(0, 40 - (distMi - 1) * 20);

    const saleDate = comp.saleDate ? new Date(comp.saleDate) : null;
    const monthsAgo = saleDate
      ? (Date.now() - saleDate.getTime()) / (1000 * 60 * 60 * 24 * 30)
      : 12;
    let recencyScore = 40;
    if (monthsAgo < 3) recencyScore = 100;
    else if (monthsAgo < 6) recencyScore = 70;
    else if (monthsAgo <= 12) recencyScore = 40;
    else recencyScore = Math.max(0, 40 - (monthsAgo - 12) * 5);

    // Similarity sub-scores (SOP: beds/baths, sqft, year built, story count)
    const subjectSqft = subjectProperty.squareFootage || subjectProperty.livingArea || 0;
    const compSqft = comp.squareFootage || 0;
    const sqftDiffAbs = subjectSqft > 0 && compSqft > 0 ? Math.abs(compSqft - subjectSqft) : 300;
    const sqftScore = subjectSqft > 0 && compSqft > 0
      ? Math.max(0, 100 - (Math.min(sqftDiffAbs, SOP.SQFT_MAX_DIFF) / SOP.SQFT_MAX_DIFF) * 100)
      : 50;

    const bedDiff = Math.abs((comp.beds || 0) - (subjectProperty.beds || subjectProperty.bedrooms || 0));
    const bathDiff = Math.abs((comp.baths || 0) - (subjectProperty.baths || subjectProperty.bathrooms || 0));
    const bedBathScore = Math.max(0, 100 - (bedDiff + bathDiff) * 25);

    const subjectYear = subjectProperty.yearBuilt || 0;
    const compYear = comp.yearBuilt || 0;
    const yearDiff = subjectYear > 0 && compYear > 0 ? Math.abs(compYear - subjectYear) : SOP.YEAR_BUILT_TOLERANCE;
    const yearBuiltScore = subjectYear > 0 && compYear > 0
      ? Math.max(0, 100 - (Math.min(yearDiff, SOP.YEAR_BUILT_TOLERANCE) / SOP.YEAR_BUILT_TOLERANCE) * 100)
      : 50;

    const subjectStories = subjectProperty.stories ?? subjectProperty.storyCount ?? null;
    const compStories = comp.stories ?? comp.storyCount ?? null;
    let storyScore = 100;
    if (subjectStories != null && compStories != null) {
      const storyDiff = Math.abs(compStories - subjectStories);
      storyScore = storyDiff === 0 ? 100 : (storyDiff === 1 ? 50 : 0);
    }

    const similarityScore = (sqftScore + bedBathScore + yearBuiltScore + storyScore) / 4;

    let conditionScore = comp.conditionRating ? (comp.conditionRating / 5) * 100 : 50;
    if (comp.images && comp.images.length > 0 && comp.conditionRating) {
      const imageConfidence = 70;
      conditionScore = conditionScore * (0.8 + 0.2 * (imageConfidence / 100));
      conditionScore = Math.min(100, conditionScore);
    }

    const compScore =
      distanceScore * SOP.ARV_WEIGHT_DISTANCE +
      recencyScore * SOP.ARV_WEIGHT_RECENCY +
      similarityScore * SOP.ARV_WEIGHT_SIMILARITY +
      conditionScore * SOP.ARV_WEIGHT_CONDITION;

    return {
      ...comp,
      compScore: Math.round(compScore * 100) / 100,
      distanceScore: Math.round(distanceScore * 100) / 100,
      recencyScore: Math.round(recencyScore * 100) / 100,
      sqftScore: Math.round(sqftScore * 100) / 100,
      bedBathScore: Math.round(bedBathScore * 100) / 100,
      yearBuiltScore: Math.round(yearBuiltScore * 100) / 100,
      storyScore: Math.round(storyScore * 100) / 100,
      conditionScore: Math.round(conditionScore * 100) / 100,
    };
  });

  // Sort by comp score descending
  return scoredComps.sort((a, b) => b.compScore - a.compScore);
};

/**
 * Get the best available sale/listing price from a comp.
 * Prefers rawData (source/scraped price) when present so ARV is not lowered by stale DB salePrice.
 * Falls back to comp.salePrice when rawData has no price.
 */
export function getCompSalePrice(comp) {
  // rawData may be a Mongoose subdocument – get plain object if needed
  let raw = comp.rawData;
  if (raw && typeof raw.toObject === 'function') raw = raw.toObject();
  const unwrap = (r) => r?.property && typeof r.property === 'object' ? r.property : r?.data && typeof r.data === 'object' ? r.data : r;
  const extract = (r) => {
    if (!r) return null;
    if (r.price != null && typeof r.price === 'object' && r.price.value != null) return parseFloat(r.price.value);
    if (r.hdpView != null && r.hdpView.price != null) return parseFloat(r.hdpView.price);
    if (r.salePrice != null) {
      if (typeof r.salePrice === 'object' && r.salePrice.value != null) return parseFloat(r.salePrice.value);
      return parseFloat(r.salePrice);
    }
    if (r.lastSoldPrice != null) return parseFloat(r.lastSoldPrice);
    if (r.soldPrice != null) return parseFloat(r.soldPrice);
    if (r.closingPrice != null) return parseFloat(r.closingPrice);
    if (r.price != null) {
      if (typeof r.price === 'object' && r.price.amount != null) return parseFloat(r.price.amount);
      return parseFloat(r.price);
    }
    if (r.listPrice != null) return parseFloat(r.listPrice);
    return null;
  };
  const fromRaw = raw && typeof raw === 'object' ? (extract(unwrap(raw)) ?? extract(raw)) : null;
  if (fromRaw != null && fromRaw > 0) return fromRaw;
  if (comp.salePrice != null && comp.salePrice > 0) return comp.salePrice;
  return null;
}

/**
 * SOP Step 5: Dollar adjustments to comp sale price to reflect subject property.
 * Bed/Bath ±$10K each (or $15K for 1↔2 bath), Garage ±$10K, ±$10K per 100 SF, ±$10K per 10k lot, Pool ±$10–25K.
 * Condition: Partially updated +$5K, Outdated +$15K (bring comp to "updated" baseline).
 * Exported for use in find-comparables response (show adjusted ARV on comp cards).
 */
export function getSOPAdjustedCompPrice(subjectProperty, comp) {
  const salePrice = getCompSalePrice(comp);
  if (salePrice == null || salePrice <= 0) return null;

  const subjectSqft = subjectProperty.squareFootage || 0;
  const compSqft = comp.squareFootage || 0;
  const subjectBeds = subjectProperty.beds ?? subjectProperty.bedrooms ?? 0;
  const compBeds = comp.beds ?? 0;
  const subjectBaths = subjectProperty.baths ?? subjectProperty.bathrooms ?? 0;
  const compBaths = comp.baths ?? 0;
  const subjectLot = Number(subjectProperty.lotSize) || 0;
  const compLot = Number(comp.lotSize) || 0;
  const subjectGarage = subjectProperty.garageSpaces ?? subjectProperty.garage ?? 0;
  const compGarage = comp.garageSpaces ?? comp.garage ?? 0;
  const compHasPool = comp.hasPool ?? comp.pool ?? (Array.isArray(comp.poolFeatures) && comp.poolFeatures.length > 0);
  const subjectHasPool = subjectProperty.hasPool ?? subjectProperty.pool ?? false;

  let adj = salePrice;

  const sqftDiff = subjectSqft - compSqft;
  adj += (sqftDiff / 100) * SOP.ADJUSTMENT_PER_100_SQFT;

  const bedDiff = subjectBeds - compBeds;
  const bathDiff = subjectBaths - compBaths;
  const oneVsTwoBath = (subjectBaths === 1 && compBaths === 2) || (subjectBaths === 2 && compBaths === 1);
  adj += bedDiff * SOP.ADJUSTMENT_PER_BED_BATH;
  if (oneVsTwoBath) adj += (bathDiff > 0 ? 1 : -1) * (SOP.ADJUSTMENT_ONE_VS_TWO_BATH - SOP.ADJUSTMENT_PER_BED_BATH);
  else adj += bathDiff * SOP.ADJUSTMENT_PER_BED_BATH;

  const garageDiff = subjectGarage - compGarage;
  if (garageDiff !== 0) adj += garageDiff * SOP.ADJUSTMENT_GARAGE;

  const lotDiffSqft = subjectLot - compLot;
  if (subjectLot > 0 || compLot > 0) adj += (lotDiffSqft / 10000) * SOP.ADJUSTMENT_PER_10K_LOT_SQFT;

  if (compHasPool && !subjectHasPool) adj -= (SOP.ADJUSTMENT_POOL_MIN + SOP.ADJUSTMENT_POOL_MAX) / 2;
  if (!compHasPool && subjectHasPool) adj += (SOP.ADJUSTMENT_POOL_MIN + SOP.ADJUSTMENT_POOL_MAX) / 2;

  const conditionLabel = (comp.conditionLabel || comp.condition || '').toLowerCase();
  const conditionCat = (comp.aggregatedImageScores?.conditionCategory || '').toLowerCase();
  // SOP: Updated = baseline, Partially updated = +$5K, Outdated = +$15K
  if (conditionLabel.includes('partial') || conditionLabel === 'partially updated') adj += SOP.CONDITION_PARTIALLY_UPDATED;
  else if (conditionLabel.includes('outdated') || conditionLabel === 'fair' || conditionLabel === 'old') adj += SOP.CONDITION_OUTDATED;
  else if (conditionCat === 'heavy-repairs') adj += SOP.CONDITION_OUTDATED; // Gemini: heavy → treat as outdated
  else if (conditionCat === 'medium-repairs') adj += SOP.CONDITION_PARTIALLY_UPDATED; // Gemini: medium → partially updated

  if (comp.conditionRating != null && comp.conditionRating < 3 && !conditionLabel && !conditionCat) adj += SOP.CONDITION_OUTDATED;
  else if (comp.conditionRating != null && comp.conditionRating === 3 && !conditionLabel && !conditionCat) adj += SOP.CONDITION_PARTIALLY_UPDATED;

  return Math.round(adj);
}

/**
 * PHASE 5: ARV Calculation
 * SOP: Dollar adjustments per comp (Step 5), weighted average by Distance/Recency/Similarity/Condition (Step 6),
 * ARV ceiling = max(raw comp sale price) + $10K, round down to nearest $5,000.
 * We do NOT reduce comp value when comp is in better condition than subject — per SOP we "favor updated comps"
 * and the adjusted price represents what the subject would sell for after repair (i.e. comparable to the comp).
 */
export const calculateARV = (subjectProperty, topComps) => {
  if (!topComps || topComps.length === 0) {
    return { arv: null, adjustedComps: [] };
  }

  const subjectSqft = subjectProperty.squareFootage || 0;

  // 5.1 Adjust Raw Comps — SOP Step 5: dollar adjustments (bed/bath/sf/lot/garage/pool/condition)
  // Do NOT apply conditionAdjustmentPercent here: SOP says favor updated comps; subject after repair = comp level.
  const adjustedComps = topComps.map((comp) => {
    let adjustedPrice = getSOPAdjustedCompPrice(subjectProperty, comp);

    if (adjustedPrice == null || adjustedPrice <= 0) {
      const compSqft = comp.squareFootage || 1;
      const adjustmentFactor = subjectSqft > 0 ? subjectSqft / compSqft : 1;
      const salePrice = getCompSalePrice(comp);
      adjustedPrice = salePrice && salePrice > 0 ? salePrice * adjustmentFactor : null;
    }

    return {
      ...comp,
      adjustedPrice: adjustedPrice != null ? Math.round(adjustedPrice) : null,
    };
  });

  const prices = adjustedComps.map((c) => c.adjustedPrice).filter((p) => p != null);
  if (prices.length === 0) return { arv: null, adjustedComps };

  // SOP: Remove comps with score < 60 before ARV (automation doc)
  const scoreFiltered = adjustedComps.filter((c) => {
    if (c.adjustedPrice == null || c.adjustedPrice <= 0) return false;
    const score = c.compScore != null ? c.compScore : 100;
    return score >= SOP.MIN_COMP_SCORE_FOR_ARV;
  });
  const compsForARV = scoreFiltered.length > 0 ? scoreFiltered : adjustedComps;
  if (scoreFiltered.length === 0 && adjustedComps.length > 0) {
    console.warn(`⚠️ No comps with score >= ${SOP.MIN_COMP_SCORE_FOR_ARV}; using all comps for ARV (per automation fallback).`);
  }

  // SOP Step 6: Weighted ARV (Distance 30%, Recency 30%, Similarity 30%, Condition 10%) — no median filter
  let arv = calculateWeightedARV(compsForARV);
  if (arv == null || arv <= 0) arv = calculateAverageARV(compsForARV);
  if (arv == null || arv <= 0) return { arv: null, adjustedComps };

  // SOP: ARV cannot exceed highest verified comp SALE PRICE (raw) + $10,000
  const rawSalePrices = compsForARV.map((c) => getCompSalePrice(c)).filter((p) => p != null && p > 0);
  const maxRawSalePrice = rawSalePrices.length > 0 ? Math.max(...rawSalePrices) : null;
  const ceiling = maxRawSalePrice != null ? maxRawSalePrice + SOP.ARV_CEILING_BUFFER : null;
  if (ceiling != null && arv > ceiling) arv = ceiling;

  // SOP: Round ARV down to nearest $5,000
  arv = Math.floor(arv / SOP.ARV_ROUND_TO) * SOP.ARV_ROUND_TO;
  return { arv, adjustedComps };
};

const calculateAverageARV = (comps) => {
  const validPrices = comps.map((c) => c.adjustedPrice).filter((p) => p != null);
  if (validPrices.length === 0) return null;
  return validPrices.reduce((sum, p) => sum + p, 0) / validPrices.length;
};

const calculateWeightedARV = (comps) => {
  let totalWeightedPrice = 0;
  let totalWeight = 0;

  for (const comp of comps) {
    if (comp.adjustedPrice == null || comp.adjustedPrice <= 0) continue;
    // Weight by comp score per document; when compScore is missing/0 (e.g. not persisted), use 1 so we still compute ARV
    const weight = (comp.compScore != null && comp.compScore > 0) ? comp.compScore : 1;
    totalWeightedPrice += comp.adjustedPrice * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? totalWeightedPrice / totalWeight : null;
};

/**
 * SOP Step 8 / Fix & Flip Offer Sheet: Calculate MAO (Maximum Allowable Offer).
 *
 * SOP: "Input ARV and Rehab in the sheet. Tweak Purchase Price until ROI = 7.5%. Then in Acquisition
 * Section, input the potential offer (MAO); the sheet adds transactional lender fees and title costs,
 * and ensures a $20,000 spread between the buyer's purchase price and our total acquisition cost."
 *
 * Sheet layout (matches Google Sheet):
 *   Main Numbers: ARV, Dispo Price (buyer purchase @ 7.5% ROI), Repairs Cost
 *   MAO section: MAO (our offer) → + 1% Transactional Lender → + 2% Title cc's → All in Acq cost
 *   Spread = Dispo Price − All in Acq cost = $20,000
 *
 * Formula:
 *   1. Buyer Purchase Price (Dispo) = (ARV − (1+7.5%)×(Rehab + buyerCosts)) / (1+7.5%)
 *   2. All-in Acq target = Buyer Price − $20,000
 *   3. All-in = MAO + 1%×MAO + 2%×MAO = MAO × 1.03  =>  MAO = All-in target / 1.03
 */
export const calculateMAOSOP = (arv, inputs) => {
  const {
    estimatedRepairs = 0,
    holdingCost = 0,
    closingCost = 0,
    wholesaleFee = 0,
  } = inputs;
  if (!arv || arv <= 0) return null;

  const rehab = estimatedRepairs;
  const buyerCosts = holdingCost + closingCost;
  const roi = SOP.TARGET_BUYER_ROI;
  const buyerPriceAt75ROI = (arv - (1 + roi) * (rehab + buyerCosts)) / (1 + roi);
  if (buyerPriceAt75ROI <= 0) return null;

  const allInAcqTarget = buyerPriceAt75ROI - SOP.MIN_SPREAD;
  const maoMultiplier = 1 + SOP.MAO_TRANSACTIONAL_LENDER_PERCENT + SOP.MAO_TITLE_PERCENT;
  const baseMAOVal = allInAcqTarget / maoMultiplier;
  const mao = Math.max(0, Math.round(baseMAOVal));
  const transactionalLenderFee = Math.round(mao * SOP.MAO_TRANSACTIONAL_LENDER_PERCENT);
  const titleCost = Math.round(mao * SOP.MAO_TITLE_PERCENT);
  const allInAcqCost = mao + transactionalLenderFee + titleCost;
  const totalFeesVal = Math.round(estimatedRepairs + holdingCost + closingCost + wholesaleFee);
  const suggestedOffer = Math.max(0, Math.round(mao * 0.95));

  return {
    mao,
    suggestedOffer,
    baseMAO: mao,
    allInAcqCost,
    transactionalLenderFee,
    titleCost,
    totalFees: totalFeesVal,
    breakdown: {
      arv,
      baseMAO: mao,
      buyerPriceAt75ROI: Math.round(buyerPriceAt75ROI),
      minSpread: SOP.MIN_SPREAD,
      allInAcqCost,
      transactionalLenderFee,
      titleCost,
      estimatedRepairs,
      holdingCost,
      closingCost,
      wholesaleFee,
      totalFees: totalFeesVal,
      useSOP: true,
    },
    useSOP: true,
  };
};

/**
 * PHASE 6: MAO Calculation
 * When maoRule === 'sop', uses ROI-based 7.5% and $20K spread (Asset Hunters SOP). Otherwise 65%/70%/75%/custom.
 */
export const calculateMAO = (arv, inputs) => {
  const {
    estimatedRepairs = 0,
    holdingCost = 0,
    closingCost = 0,
    wholesaleFee = 0,
    maoRule = '70%',
    maoRulePercent = null,
    useSOP = false,
  } = inputs;

  if (!arv) {
    return null;
  }

  if (maoRule === 'sop' || useSOP) {
    const sopResult = calculateMAOSOP(arv, {
      estimatedRepairs,
      holdingCost,
      closingCost,
      wholesaleFee,
    });
    if (sopResult) return sopResult;
  }

  const rulePercent =
    maoRule === 'custom' && maoRulePercent
      ? maoRulePercent / 100
      : parseFloat(String(maoRule).replace('%', '')) / 100;
  const baseMAO = arv * rulePercent;
  const totalFees = estimatedRepairs + holdingCost + closingCost + wholesaleFee;

  const mao = baseMAO - totalFees;
  const suggestedOffer = Math.max(0, mao * 0.95); // 5% buffer

  return {
    mao: Math.round(mao),
    suggestedOffer: Math.round(suggestedOffer),
    baseMAO: Math.round(baseMAO),
    totalFees: Math.round(totalFees),
    breakdown: {
      arv,
      rulePercent,
      baseMAO: Math.round(baseMAO),
      estimatedRepairs,
      holdingCost,
      closingCost,
      wholesaleFee,
      totalFees: Math.round(totalFees),
    },
  };
};

/**
 * PHASE 7: Deal Score Calculation
 * Enhanced with neighborhood rating from Google Places API and DOM trend analysis
 */
export const calculateDealScore = async (subjectProperty, analysis, comps) => {
  const askingPrice = subjectProperty.price || 0;
  const arv = analysis.arv || 0;
  const estimatedRepairs = analysis.estimatedRepairs || 0;
  const areaType = analysis.areaType || 'suburban';

  // Spread Score (40%)
  const spread = arv - askingPrice;
  const spreadPercent = askingPrice > 0 ? (spread / askingPrice) * 100 : 0;
  const spreadScore = Math.min(100, Math.max(0, 50 + spreadPercent * 2));

  // Repair Score (20%)
  const repairPercent = arv > 0 ? (estimatedRepairs / arv) * 100 : 100;
  const repairScore = Math.max(0, 100 - repairPercent * 2);

  // Market Score (20%) - based on days on market trend analysis and demand indicators
  // Compare subject property DOM to comps' average DOM to determine market trend
  const daysOnMarket = analysis.daysOnMarket || 90;
  
  // Calculate average DOM from comps (if available)
  let avgCompDOM = null;
  let demandIndicators = {
    priceTrend: null,
    inventoryLevel: null,
    saleVelocity: null,
  };
  
  if (comps && comps.length > 0) {
    const compDOMs = comps
      .map(c => c.daysOnMarket)
      .filter(dom => dom != null && dom > 0);
    
    if (compDOMs.length > 0) {
      avgCompDOM = compDOMs.reduce((sum, dom) => sum + dom, 0) / compDOMs.length;
      console.log(`Market trend: Subject DOM: ${daysOnMarket}, Average comp DOM: ${avgCompDOM.toFixed(1)}`);
    }
    
    // Calculate demand indicators from comp data
    // 1. Price Trend: Compare recent sales to older sales (if we have sale dates)
    const compsWithDates = comps
      .filter(c => c.saleDate && c.salePrice)
      .sort((a, b) => new Date(b.saleDate) - new Date(a.saleDate));
    
    if (compsWithDates.length >= 4) {
      // Split into recent (first half) and older (second half)
      const midPoint = Math.floor(compsWithDates.length / 2);
      const recentComps = compsWithDates.slice(0, midPoint);
      const olderComps = compsWithDates.slice(midPoint);
      
      const recentAvgPrice = recentComps.reduce((sum, c) => sum + (c.salePrice || 0), 0) / recentComps.length;
      const olderAvgPrice = olderComps.reduce((sum, c) => sum + (c.salePrice || 0), 0) / olderComps.length;
      
      if (olderAvgPrice > 0) {
        const priceChangePercent = ((recentAvgPrice - olderAvgPrice) / olderAvgPrice) * 100;
        demandIndicators.priceTrend = priceChangePercent;
        console.log(`Price trend: ${priceChangePercent > 0 ? '+' : ''}${priceChangePercent.toFixed(2)}% (recent avg: $${recentAvgPrice.toFixed(0)}, older avg: $${olderAvgPrice.toFixed(0)})`);
      }
    }
    
    // 2. Inventory Level: Number of comps found indicates inventory (more comps = more inventory = lower demand)
    // Normalize: 0-5 comps = high demand (low inventory), 6-10 = medium, 11+ = low demand (high inventory)
    const compCount = comps.length;
    if (compCount <= 5) {
      demandIndicators.inventoryLevel = 'low'; // Low inventory = high demand
    } else if (compCount <= 10) {
      demandIndicators.inventoryLevel = 'medium';
    } else {
      demandIndicators.inventoryLevel = 'high'; // High inventory = low demand
    }
    console.log(`Inventory level: ${demandIndicators.inventoryLevel} (${compCount} comps found)`);
    
    // 3. Sale Velocity: Average days on market (lower DOM = faster sales = higher demand)
    if (avgCompDOM && avgCompDOM > 0) {
      // Lower DOM = higher demand
      // 0-30 days = very high demand (100), 31-60 = high (75), 61-90 = medium (50), 90+ = low (25)
      if (avgCompDOM <= 30) {
        demandIndicators.saleVelocity = 100;
      } else if (avgCompDOM <= 60) {
        demandIndicators.saleVelocity = 75;
      } else if (avgCompDOM <= 90) {
        demandIndicators.saleVelocity = 50;
      } else {
        demandIndicators.saleVelocity = 25;
      }
      console.log(`Sale velocity: ${demandIndicators.saleVelocity} (avg DOM: ${avgCompDOM.toFixed(1)} days)`);
    }
  }
  
  // Calculate market score based on trend and demand indicators
  let marketScore = 100;
  let domBasedScore = 100;
  let demandBasedScore = 100;
  
  if (avgCompDOM && avgCompDOM > 0) {
    // Compare subject DOM to market average (comps)
    const domDifference = daysOnMarket - avgCompDOM;
    const domDifferencePercent = (domDifference / avgCompDOM) * 100;
    
    // If subject DOM is lower than average = fast market = better score
    // If subject DOM is higher than average = slow market = lower score
    if (domDifferencePercent <= -20) {
      // Subject is 20%+ faster than market = excellent (100)
      domBasedScore = 100;
    } else if (domDifferencePercent <= -10) {
      // Subject is 10-20% faster = very good (90-100)
      domBasedScore = 90 + (Math.abs(domDifferencePercent) - 10) * 1;
    } else if (domDifferencePercent <= 0) {
      // Subject is 0-10% faster = good (80-90)
      domBasedScore = 80 + Math.abs(domDifferencePercent) * 1;
    } else if (domDifferencePercent <= 20) {
      // Subject is 0-20% slower = average (60-80)
      domBasedScore = 80 - domDifferencePercent * 1;
    } else if (domDifferencePercent <= 50) {
      // Subject is 20-50% slower = below average (30-60)
      domBasedScore = 60 - ((domDifferencePercent - 20) / 30) * 30;
    } else {
      // Subject is 50%+ slower = poor (0-30)
      domBasedScore = Math.max(0, 30 - ((domDifferencePercent - 50) / 50) * 30);
    }
  } else {
    // Fallback to static calculation if no comp DOM data
    // Lower DOM = faster market = better score
    if (daysOnMarket <= 30) {
      domBasedScore = 100 - (daysOnMarket / 30) * 20; // 100 to 80
    } else if (daysOnMarket <= 60) {
      domBasedScore = 80 - ((daysOnMarket - 30) / 30) * 30; // 80 to 50
    } else if (daysOnMarket <= 90) {
      domBasedScore = 50 - ((daysOnMarket - 60) / 30) * 30; // 50 to 20
    } else {
      domBasedScore = Math.max(0, 20 - ((daysOnMarket - 90) / 30) * 20); // 20 to 0
    }
  }
  
  // Calculate demand-based score from demand indicators
  if (demandIndicators.priceTrend !== null || demandIndicators.inventoryLevel || demandIndicators.saleVelocity !== null) {
    let demandScoreComponents = [];
    
    // Price trend: positive trend = higher demand (up to 30 points)
    if (demandIndicators.priceTrend !== null) {
      const priceTrendScore = Math.min(30, Math.max(0, 15 + (demandIndicators.priceTrend / 2)));
      demandScoreComponents.push(priceTrendScore);
      console.log(`Price trend contribution: ${priceTrendScore.toFixed(1)} (${demandIndicators.priceTrend > 0 ? 'rising' : 'falling'} prices)`);
    }
    
    // Inventory level: low inventory = high demand (up to 30 points)
    if (demandIndicators.inventoryLevel) {
      let inventoryScore = 0;
      if (demandIndicators.inventoryLevel === 'low') inventoryScore = 30; // High demand
      else if (demandIndicators.inventoryLevel === 'medium') inventoryScore = 15; // Medium demand
      else inventoryScore = 0; // Low demand
      demandScoreComponents.push(inventoryScore);
      console.log(`Inventory level contribution: ${inventoryScore.toFixed(1)} (${demandIndicators.inventoryLevel} inventory)`);
    }
    
    // Sale velocity: faster sales = higher demand (up to 40 points)
    if (demandIndicators.saleVelocity !== null) {
      demandScoreComponents.push(demandIndicators.saleVelocity * 0.4); // Scale 0-100 to 0-40
      console.log(`Sale velocity contribution: ${(demandIndicators.saleVelocity * 0.4).toFixed(1)}`);
    }
    
    // Average demand components (weighted by availability)
    if (demandScoreComponents.length > 0) {
      const totalWeight = demandScoreComponents.length;
      demandBasedScore = demandScoreComponents.reduce((sum, score) => sum + score, 0) / totalWeight;
      // Scale to 0-100 range
      demandBasedScore = (demandBasedScore / 40) * 100; // Max component score is 40, scale to 100
      demandBasedScore = Math.max(0, Math.min(100, demandBasedScore));
    }
  }
  
  // Combine DOM-based score (60%) with demand-based score (40%)
  marketScore = (domBasedScore * 0.6) + (demandBasedScore * 0.4);
  marketScore = Math.max(0, Math.min(100, marketScore));
  
  console.log(`Market score: ${marketScore.toFixed(1)} (DOM-based: ${domBasedScore.toFixed(1)}, Demand-based: ${demandBasedScore.toFixed(1)})`);

  // Area Score (10%) - based on neighborhood rating (crime, schools, demand)
  // Use Google Places API neighborhood rating if available, otherwise use proxy
  let areaScore = analysis.neighborhoodRating;
  
  // Helper function for proxy calculation
  const calculateNeighborhoodProxy = (subjectProperty, areaType, analysis) => {
    // Calculate neighborhood rating based on available data
    // Urban areas typically have higher demand, suburban have better schools
    const propertyValue = subjectProperty.price || analysis.arv || 0;
    
    // Base score on area type
    let baseScore = 50;
    if (areaType === 'urban') {
      baseScore = 65; // Urban areas: higher demand, more amenities
    } else if (areaType === 'suburban') {
      baseScore = 70; // Suburban: good schools, safe, family-friendly
    } else {
      baseScore = 45; // Rural: less demand, fewer amenities
    }
    
    // Adjust based on property value (higher value = better area typically)
    if (propertyValue > 0) {
      if (propertyValue > 500000) {
        baseScore += 15; // High-value properties in good areas
      } else if (propertyValue > 300000) {
        baseScore += 10; // Mid-high value
      } else if (propertyValue < 150000) {
        baseScore -= 10; // Lower value areas
      }
    }
    
    return Math.max(0, Math.min(100, baseScore));
  };
  
  if (!areaScore || areaScore === 50) {
    // Try to calculate neighborhood rating using Google Places API
    const { calculateNeighborhoodRating } = await import('./googleMapsService.js');
    
    if (subjectProperty.latitude && subjectProperty.longitude) {
      try {
        const neighborhoodRating = await calculateNeighborhoodRating(
          subjectProperty.latitude,
          subjectProperty.longitude,
          subjectProperty.formattedAddress || subjectProperty.address
        );
        
        if (neighborhoodRating && neighborhoodRating !== 50) {
          areaScore = neighborhoodRating;
          console.log(`Using Google Places API neighborhood rating: ${areaScore}`);
        } else {
          // Fallback to proxy calculation
          areaScore = calculateNeighborhoodProxy(subjectProperty, areaType, analysis);
        }
      } catch (error) {
        console.warn('Failed to calculate neighborhood rating from Google Places API:', error.message);
        // Fallback to proxy calculation
        areaScore = calculateNeighborhoodProxy(subjectProperty, areaType, analysis);
      }
    } else {
      // No coordinates, use proxy calculation
      areaScore = calculateNeighborhoodProxy(subjectProperty, areaType, analysis);
    }
  }

  // Comp Strength Score (10%)
  const avgCompScore =
    comps.length > 0
      ? comps.slice(0, 5).reduce((sum, c) => sum + (c.compScore || 0), 0) / comps.length
      : 0;
  const compStrengthScore = avgCompScore;

  // Calculate Deal Score
  const dealScore =
    spreadScore * 0.4 +
    repairScore * 0.2 +
    marketScore * 0.2 +
    areaScore * 0.1 +
    compStrengthScore * 0.1;

  return {
    dealScore: Math.round(dealScore * 100) / 100,
    spreadScore: Math.round(spreadScore * 100) / 100,
    repairScore: Math.round(repairScore * 100) / 100,
    marketScore: Math.round(marketScore * 100) / 100,
    areaScore: Math.round(areaScore * 100) / 100,
    compStrengthScore: Math.round(compStrengthScore * 100) / 100,
  };
};

/**
 * PHASE 8: Generate Recommendation
 */
export const generateRecommendation = (dealScore) => {
  if (dealScore >= 80) {
    return {
      recommendation: 'strong-deal',
      recommendationReason: 'Excellent spread and low repair costs. Strong comps support this valuation.',
    };
  } else if (dealScore >= 60) {
    return {
      recommendation: 'good-negotiate',
      recommendationReason: 'Good potential deal. Consider negotiating price or terms.',
    };
  } else if (dealScore >= 40) {
    return {
      recommendation: 'weak-lowball',
      recommendationReason: 'Weak deal metrics. Only proceed with aggressive lowball offer.',
    };
  } else {
    return {
      recommendation: 'pass',
      recommendationReason: 'Deal metrics do not meet investment criteria. Recommend passing.',
    };
  }
};

/**
 * Determine condition category based on repair estimates and image analysis
 * Enhanced to incorporate image analysis results
 */
export const determineConditionCategory = (estimatedRepairs, arv, aggregatedImageScores = null) => {
  // If we have image analysis, use it to enhance the determination
  if (aggregatedImageScores) {
    const overallConditionScore = aggregatedImageScores.overallConditionScore || 5; // 1-10 scale
    const damageRiskScore = aggregatedImageScores.damageRiskScore || 0; // 0-100, higher = more risk
    const renovationScore = aggregatedImageScores.renovationScore || 0; // 0-100
    
    // High damage risk = heavy repairs
    if (damageRiskScore > 60) {
      return 'heavy-repairs';
    }
    
    // Low condition score = needs work
    if (overallConditionScore < 4) {
      return 'heavy-repairs';
    }
    
    // If repair estimate is high relative to ARV
    if (arv && arv > 0) {
      const repairPercent = (estimatedRepairs / arv) * 100;
      if (repairPercent >= 25) return 'heavy-repairs';
      if (repairPercent >= 10) return 'medium-repairs';
    }
    
    // Moderate condition with some damage = medium repairs
    if (overallConditionScore < 6 && damageRiskScore > 30) {
      return 'medium-repairs';
    }
    
    // Good condition and low damage = light repairs
    if (overallConditionScore >= 6 && damageRiskScore < 30) {
      return 'light-repairs';
    }
  }
  
  // Fallback to repair estimate only if no image analysis
  if (!arv || arv === 0) return 'medium-repairs';

  const repairPercent = (estimatedRepairs / arv) * 100;

  if (repairPercent < 10) return 'light-repairs';
  if (repairPercent < 25) return 'medium-repairs';
  return 'heavy-repairs';
};

/**
 * Main orchestration function - runs the complete workflow
 */
export const runCompsAnalysis = async (address, images = [], maoInputs = {}) => {
  try {
    // PHASE 1: Subject Property Preparation
    const { property, areaType, propertyCategory, aggregatedImageScores } =
      await prepareSubjectProperty(address, images, false); // Run image analysis in runCompsAnalysis

    // PHASE 2: Comp Search Preparation
    const searchParams = prepareCompSearch(property, areaType);

    // PHASE 3: Find Comparable Properties
    // IMPORTANT: Search for SOLD properties as comparables
    console.log('Starting comps search for SOLD properties...');
    let comps = await findComparableProperties(property, {
      latitude: property.latitude,
      longitude: property.longitude,
      radius: searchParams.radius,
      timeWindowMonths: searchParams.preferredMonths,
      propertyType: property.propertyType,
      maxRadius: searchParams.maxRadius,
    });

    console.log(`Found ${comps.length} SOLD comparable properties`);

    // PHASE 4: Score Comparables (with attribute matching criteria)
    const matchingCriteria = searchParams.matchingCriteria || {
      propertyType: true,
      bedrooms: { tolerance: 1 },
      bathrooms: { tolerance: 1 },
      squareFootage: { tolerance: 0.2 },
      lotSize: { tolerance: 0.5 },
      yearBuilt: { tolerance: 10 },
    };
    const scoredComps = scoreComparables(property, comps, matchingCriteria);

    // Save comps to database
    const savedComps = await Comparable.insertMany(
      scoredComps.map((comp) => ({
        ...comp,
        subjectPropertyId: property._id,
      }))
    );

    // NOTE: ARV calculation is NOT done here automatically
    // User must select 3-5 comps and call analyzeSelectedComps endpoint
    // This function only finds and scores comps for user selection

    return {
      property,
      comps: scoredComps,
      savedComps: savedComps,
      areaType,
      propertyCategory,
      searchParams,
      matchingCriteria,
      aggregatedImageScores,
    };
  } catch (error) {
    console.error('Comps Analysis Error:', error);
    throw error;
  }
};
