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

const getSqftTolerance = (subjectSqft) => {
  if (!subjectSqft || subjectSqft <= 0) return 0.2;
  if (subjectSqft < 800) return 0.1;
  if (subjectSqft < 1200) return 0.15;
  return 0.2;
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
        
        // Get images from the property (combine with provided images, remove duplicates)
        if (normalizedData.images && normalizedData.images.length > 0) {
          const allImages = [...imageUrls, ...normalizedData.images];
          property.images = [...new Set(allImages)]; // Remove duplicates
          const appendedMetas = normalizedData.images.map((url, idx) => ({
            url,
            photoType: null,
            captureOrder: imageMetas.length + idx,
          }));
          imageMetas = [...imageMetas, ...appendedMetas];
          imageUrls = property.images; // Update images array for analysis
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
 */
export const prepareCompSearch = (subjectProperty, areaType) => {
  // 2.1 Define Comp Search Radius
  const defaultRadius = getDefaultRadius(areaType);
  const minRadius = areaType === 'urban' ? 0.25 : areaType === 'suburban' ? 0.5 : 1.0;
  // Max radius allows for expansion: urban can expand to 0.75, suburban to 1.5, rural to 2.5
  const maxRadius = areaType === 'urban' ? 0.75 : areaType === 'suburban' ? 1.5 : 2.5;

  // 2.2 Define Time Window - prefer sold within 12 months (doc: expand to 12 months if necessary)
  const preferredMonths = 12;
  const maxMonths = 12;

  // 2.3 Attribute Matching Requirements
  const sqftTolerance = getSqftTolerance(subjectProperty.squareFootage);
  const matchingCriteria = {
    propertyType: true, // Must match
    bedrooms: { tolerance: 1 },
    bathrooms: { tolerance: 1 },
    squareFootage: { tolerance: sqftTolerance }, // Smaller homes get tighter ranges
    lotSize: { tolerance: 0.5 }, // ±50% (only if lots matter)
    yearBuilt: { tolerance: 10 }, // ±10 years (optional for older areas)
    areaType: areaType, // Pass area type for conditional matching
  };

  return {
    radius: defaultRadius,
    minRadius,
    maxRadius,
    preferredMonths,
    maxMonths,
    matchingCriteria,
  };
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

  let currentTimeWindow = timeWindowMonths || preferredMonths || 6;
  let currentRadius = radius;
  let primarySourceConfig = null;
  let foundHigherPrioritySource = false;

  // PHASE 3.1: Check sources in priority order
  // According to document: "If a higher-source dataset is available, lower sources are ignored"
  // This means we check all sources in priority order, and use the FIRST source that returns results
  for (let i = 0; i < sources.length; i++) {
    const sourceConfig = sources[i];
    const compsBefore = comps.length;
    const source = sourceConfig.name;
    const scraper = sourceConfig.scraper;
    
    try {
      let results;
      // IMPORTANT: Search for SOLD properties only (for comps analysis)
      // Include address from subject property for better search results
      // Also include city, state, postalCode if available from property data
      // Use subject details for comp filters (doc: Beds ±1, Baths ±1, SqFt ±20%, price range)
      // Support both DB names (beds, baths, squareFootage) and URL-scraped names (bedrooms, bathrooms, livingArea)
      const subjectBeds = subjectProperty.beds ?? subjectProperty.bedrooms;
      const subjectBaths = subjectProperty.baths ?? subjectProperty.bathrooms;
      const subjectSqft = subjectProperty.squareFootage ?? subjectProperty.livingArea;
      const subjectPrice = subjectProperty.estimatedValue ?? subjectProperty.zestimate ?? subjectProperty.price ?? 0;
      const priceMargin = subjectPrice > 0 ? Math.round(subjectPrice * 0.2) : 0;

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
        isSold: true, // Always search for SOLD properties as comparables
        minBeds: subjectBeds != null && subjectBeds >= 1 ? subjectBeds - 1 : 0,
        maxBeds: subjectBeds != null ? subjectBeds + 1 : 0,
        minBaths: subjectBaths != null && subjectBaths >= 1 ? subjectBaths - 1 : 0,
        minSqft: subjectSqft != null && subjectSqft > 0 ? Math.round(subjectSqft * 0.8) : undefined,
        maxSqft: subjectSqft != null && subjectSqft > 0 ? Math.round(subjectSqft * 1.2) : undefined,
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

  // IMPORTANT: Only expand if this is NOT already an expansion search
  // This prevents infinite loops and multiple actor runs
  // Try to expand if we have less than 3 comps, but still return whatever we found
  if (comps.length < 3 && !isExpansion && primarySourceConfig) {
    console.log(`⚠️ Only found ${comps.length} comps. Attempting to expand search to find more...`);
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
          minSqft: subjectSqft != null && subjectSqft > 0 ? Math.round(subjectSqft * 0.8) : undefined,
          maxSqft: subjectSqft != null && subjectSqft > 0 ? Math.round(subjectSqft * 1.2) : undefined,
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
  
  // Square footage: ±20% tolerance
  if (matchingCriteria.squareFootage && matchingCriteria.squareFootage.tolerance !== undefined) {
    const subjectSqft = subjectProperty.squareFootage || 0;
    const compSqft = comp.squareFootage || 0;
    if (subjectSqft > 0 && compSqft > 0) {
      const sqftDiff = Math.abs(compSqft - subjectSqft) / subjectSqft;
      if (sqftDiff > matchingCriteria.squareFootage.tolerance) {
        return false;
      }
    }
  }
  
  // Lot size: ±50% tolerance (only if lots matter in the area)
  // In urban areas, lot size typically matters less; in suburban/rural, it matters more
  if (matchingCriteria.lotSize && matchingCriteria.lotSize.tolerance !== undefined) {
    const areaType = matchingCriteria.areaType || 'suburban'; // Default to suburban
    const lotsMatter = areaType !== 'urban'; // Urban areas: lots don't matter much
    
    if (lotsMatter) {
      const subjectLot = subjectProperty.lotSize || 0;
      const compLot = comp.lotSize || 0;
      if (subjectLot > 0 && compLot > 0) {
        const lotDiff = Math.abs(compLot - subjectLot) / subjectLot;
        if (lotDiff > matchingCriteria.lotSize.tolerance) {
          return false;
        }
      }
    }
    // If lots don't matter (urban), skip this check
  }
  
  // Year built: ±10 years tolerance (optional for older areas)
  // For properties built before 1980, year built is less relevant
  if (matchingCriteria.yearBuilt && matchingCriteria.yearBuilt.tolerance !== undefined) {
    const subjectYear = subjectProperty.yearBuilt || 0;
    const compYear = comp.yearBuilt || 0;
    
    // Skip year built check for older properties (built before 1980)
    const isOlderArea = subjectYear > 0 && subjectYear < 1980;
    
    if (!isOlderArea && subjectYear > 0 && compYear > 0) {
      const yearDiff = Math.abs(compYear - subjectYear);
      if (yearDiff > matchingCriteria.yearBuilt.tolerance) {
        return false;
      }
    }
    // If older area, skip this check (optional as per document)
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

  const scoredComps = filteredComps.map((comp) => {
    // Distance Score (25%)
    const distances = comps.map((c) => c.distanceMiles || 0).filter((d) => d > 0);
    const maxDistance = distances.length > 0 ? Math.max(...distances) : 1;
    const distanceScore = maxDistance > 0 ? (1 - (comp.distanceMiles || 0) / maxDistance) * 100 : 100;

    // Recency Score (20%)
    const saleDate = comp.saleDate ? new Date(comp.saleDate) : null;
    const monthsAgo = saleDate
      ? (Date.now() - saleDate.getTime()) / (1000 * 60 * 60 * 24 * 30)
      : 12;
    const recencyScore = Math.max(0, 100 - monthsAgo * 10);

    // Square Footage Score (20%)
    const subjectSqft = subjectProperty.squareFootage || 0;
    const compSqft = comp.squareFootage || 0;
    const sqftDiff = subjectSqft > 0 ? Math.abs(compSqft - subjectSqft) / subjectSqft : 1;
    const sqftScore = Math.max(0, 100 - sqftDiff * 500);

    // Beds/Baths Similarity Score (15%)
    const bedDiff = Math.abs((comp.beds || 0) - (subjectProperty.beds || 0));
    const bathDiff = Math.abs((comp.baths || 0) - (subjectProperty.baths || 0));
    const bedBathScore = Math.max(0, 100 - (bedDiff + bathDiff) * 25);

    // Year Built Similarity Score (10%)
    const subjectYear = subjectProperty.yearBuilt || 2000;
    const compYear = comp.yearBuilt || 2000;
    const yearDiff = Math.abs(compYear - subjectYear);
    const yearBuiltScore = Math.max(0, 100 - yearDiff * 2);

    // Condition Score (10%)
    // Condition rating is 1-5, convert to 0-100 score
    // If comp has image analysis, use confidence-weighted condition rating
    let conditionScore = comp.conditionRating ? (comp.conditionRating / 5) * 100 : 50;
    
    // Enhance condition score with image confidence if available
    // Comps with high-confidence image analysis get more weight
    if (comp.images && comp.images.length > 0 && comp.conditionRating) {
      // If we have images, assume moderate confidence (could be enhanced with actual confidence data)
      const imageConfidence = 70; // Default confidence when images are present
      const confidenceWeight = imageConfidence / 100;
      // Boost condition score slightly if we have image-based assessment
      conditionScore = conditionScore * (0.8 + 0.2 * confidenceWeight);
      conditionScore = Math.min(100, conditionScore); // Cap at 100
    }

    // Calculate total Comp Score
    const compScore =
      distanceScore * 0.25 +
      recencyScore * 0.2 +
      sqftScore * 0.2 +
      bedBathScore * 0.15 +
      yearBuiltScore * 0.1 +
      conditionScore * 0.1;

    return {
      ...comp,
      compScore: Math.round(compScore * 100) / 100,
      distanceScore: Math.round(distanceScore * 100) / 100,
      recencyScore: Math.round(recencyScore * 100) / 100,
      sqftScore: Math.round(sqftScore * 100) / 100,
      bedBathScore: Math.round(bedBathScore * 100) / 100,
      yearBuiltScore: Math.round(yearBuiltScore * 100) / 100,
      conditionScore: Math.round(conditionScore * 100) / 100,
    };
  });

  // Sort by comp score descending
  return scoredComps.sort((a, b) => b.compScore - a.compScore);
};

/**
 * Get the best available sale/listing price from a comp (saved salePrice or from rawData).
 * Exported so the controller can patch comps before ARV when DB salePrice was missing.
 */
export function getCompSalePrice(comp) {
  if (comp.salePrice != null && comp.salePrice > 0) return comp.salePrice;
  // rawData may be a Mongoose subdocument – get plain object if needed
  let raw = comp.rawData;
  if (raw && typeof raw.toObject === 'function') raw = raw.toObject();
  if (!raw || typeof raw !== 'object') return null;
  // Some actors wrap the payload (e.g. { property: { price, ... } })
  const unwrap = (r) => r?.property && typeof r.property === 'object' ? r.property : r?.data && typeof r.data === 'object' ? r.data : r;
  const top = unwrap(raw);
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
  return extract(top) ?? extract(raw);
}

/**
 * PHASE 5: ARV Calculation
 */
export const calculateARV = (subjectProperty, topComps) => {
  if (!topComps || topComps.length === 0) {
    return null;
  }

  const subjectSqft = subjectProperty.squareFootage || 0;

  // 5.1 Adjust Raw Comps
  const adjustedComps = topComps.map((comp) => {
    const compSqft = comp.squareFootage || 1;
    const adjustmentFactor = subjectSqft > 0 ? subjectSqft / compSqft : 1;
    const salePrice = getCompSalePrice(comp);
    let adjustedPrice = salePrice && salePrice > 0 ? salePrice * adjustmentFactor : null;
    
    // Apply condition adjustment from room-type comparison (enhanced)
    // Use the pre-calculated adjustmentPercent if available (from room-type comparison)
    // Otherwise fall back to the old calculation method
    if (adjustedPrice) {
      let conditionAdjustmentPercent = 0;
      
      if (comp.conditionAdjustmentPercent !== undefined) {
        // Use the enhanced room-type comparison adjustment (already weighted by confidence)
        conditionAdjustmentPercent = comp.conditionAdjustmentPercent;
        // Cap at ±15% for safety (more generous than before since it's confidence-weighted)
        conditionAdjustmentPercent = Math.max(-0.15, Math.min(0.15, conditionAdjustmentPercent));
      } else if (comp.conditionAdjustment !== undefined && comp.conditionAdjustment !== 0) {
        // Fallback to old method if new method not available
        conditionAdjustmentPercent = Math.max(-0.10, Math.min(0.10, comp.conditionAdjustment * 0.02));
      }
      
      if (conditionAdjustmentPercent !== 0) {
        // Positive adjustment = comp is better = adjust comp value DOWN (subject needs work)
        // Negative adjustment = subject is better = adjust comp value UP (subject is nicer)
        adjustedPrice = adjustedPrice * (1 - conditionAdjustmentPercent);
        console.log(`Applied condition adjustment: ${(conditionAdjustmentPercent * 100).toFixed(2)}% to comp ${comp.address || comp.formattedAddress}`);
      }
    }

    return {
      ...comp,
      adjustedPrice,
    };
  });

  // 5.2 Remove Outliers
  const prices = adjustedComps
    .map((c) => c.adjustedPrice)
    .filter((p) => p != null);
  if (prices.length === 0) return null;

  const medianPrice = prices.sort((a, b) => a - b)[Math.floor(prices.length / 2)];
  const priceRange = medianPrice * 0.2; // ±20%

  // Filter by outlier (±20% of median); for user-selected comps we still use compScore in weighting, not as a hard filter
  const filteredComps = adjustedComps.filter((comp) => {
    if (!comp.adjustedPrice) return false;
    return (
      comp.adjustedPrice >= medianPrice - priceRange &&
      comp.adjustedPrice <= medianPrice + priceRange
    );
  });

  const compsForARV = filteredComps.length > 0 ? filteredComps : adjustedComps;

  // 5.3 ARV = weighted by comp score (per document: distance, recency, sqft, beds/baths, year built, condition from images)
  // When compScore is missing/0 we use weight 1 so ARV is still calculated
  let arv = calculateWeightedARV(compsForARV);
  if (arv == null || arv <= 0) {
    arv = calculateAverageARV(compsForARV);
  }
  return arv;
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
 * PHASE 6: MAO Calculation
 */
export const calculateMAO = (arv, inputs) => {
  const {
    estimatedRepairs = 0,
    holdingCost = 0,
    closingCost = 0,
    wholesaleFee = 0,
    maoRule = '70%',
    maoRulePercent = null,
  } = inputs;

  if (!arv) {
    return null;
  }

  const rulePercent =
    maoRule === 'custom' && maoRulePercent
      ? maoRulePercent / 100
      : parseFloat(maoRule.replace('%', '')) / 100;
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
