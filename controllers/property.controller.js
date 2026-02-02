import Property from '../models/property.js';
import { normalizeAddress } from '../services/googleMapsService.js';
import {
  scrapeZillowProperties,
  scrapeRedfinProperties,
  scrapeRealtorProperties,
  normalizePropertyData,
  fetchZillowPropertyDetails,
  fetchZillowPropertyDetailsByUrl,
  scrapePropertyByAddress,
} from '../services/apifyService.js';
import { enhancePropertyImages } from '../services/geminiService.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { CustomError } from '../utils/CustomError.js';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const address = async (req, res) => {
  try {
    const { address } = req.body;
    if (!address) return res.status(400).json({ error: 'Address is required' });

    let existingProperty = await Property.findOne({ rawAddress: address });
    if (existingProperty) {
      return res.json({
        message: 'Address already exists',
        property: existingProperty,
      });
    }

    const normalized = await normalizeAddress(address);
    if (!normalized) return res.status(400).json({ error: 'Cannot normalize address' });

    let formattedDuplicate = await Property.findOne({
      formattedAddress: normalized.formattedAddress,
    });
    if (formattedDuplicate) {
      return res.json({
        message: 'Duplicate found by normalized address',
        property: formattedDuplicate,
      });
    }

    const newProperty = new Property({
      rawAddress: address,
      formattedAddress: normalized.formattedAddress,
      latitude: normalized.latitude,
      longitude: normalized.longitude,
    });
    await newProperty.save();

    res.json({
      message: 'Address normalized and saved',
      property: newProperty,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Fetch full property details with all images
 * POST /api/property/fetch-details
 * Body: { propertyId, propertyUrl, zpid } (at least one required)
 * 
 * Note: propertyId can be either:
 * - MongoDB ObjectId (string) - fetches property from database
 * - ZPID (number) - treated as zpid and used to build URL
 */
export const fetchPropertyDetails = async (req, res) => {
  try {
    const { propertyId, propertyUrl, zpid } = req.body;
    
    // Validate input - need at least one identifier
    if (!propertyId && !propertyUrl && !zpid) {
      return res.status(400).json({ 
        error: 'At least one of propertyId, propertyUrl, or zpid is required' 
      });
    }
    
    let property = null;
    let urlToUse = propertyUrl;
    let zpidToUse = zpid;
    
    // Helper to check if string is a valid MongoDB ObjectId
    const isValidObjectId = (id) => {
      if (!id) return false;
      const idStr = String(id);
      // MongoDB ObjectId is 24 hex characters
      return /^[0-9a-fA-F]{24}$/.test(idStr);
    };
    
    // PRIORITY: propertyUrl > zpid > propertyId
    // If propertyUrl is provided, use it directly with the new actor (highest priority)
    if (propertyUrl) {
      console.log(`✅ Using provided property URL: ${propertyUrl}`);
      urlToUse = propertyUrl;
      
      // Use the new actor that accepts URLs directly
      console.log(`🔍 Fetching property details using URL-based actor...`);
      const fullDetails = await fetchZillowPropertyDetailsByUrl(propertyUrl);
      
      if (fullDetails && fullDetails.property) {
        // Normalize the property data
        const normalized = normalizePropertyData(fullDetails.property, 'zillow');
        
        if (!normalized) {
          return res.status(500).json({ 
            error: 'Failed to normalize property data' 
          });
        }
        
        // Enhance blurry images using Gemini
        let finalImages = normalized.images || [];
        if (finalImages.length > 0) {
          try {
            console.log(`🔍 Enhancing blurry images for property...`);
            finalImages = await enhancePropertyImages(finalImages, {
              address: normalized.address || normalized.formattedAddress,
              propertyType: normalized.propertyType,
            });
            console.log(`✅ Image enhancement complete. ${finalImages.length} images ready.`);
          } catch (enhanceError) {
            console.error('Error enhancing images:', enhanceError.message);
            // Continue with original images if enhancement fails
            console.log('Using original images due to enhancement error');
          }
        }
        
        // Update property in database if propertyId was provided
        if (property && propertyId) {
          // Update property with full details
          property.images = finalImages; // Use enhanced images
          property.price = normalized.price || property.price;
          property.salePrice = normalized.salePrice || property.salePrice;
          property.beds = normalized.beds || property.beds;
          property.baths = normalized.baths || property.baths;
          property.squareFootage = normalized.squareFootage || property.squareFootage;
          property.lotSize = normalized.lotSize || property.lotSize;
          property.yearBuilt = normalized.yearBuilt || property.yearBuilt;
          property.propertyType = normalized.propertyType || property.propertyType;
          property.listingStatus = normalized.listingStatus || property.listingStatus;
          property.saleDate = normalized.saleDate || property.saleDate;
          property.daysOnMarket = normalized.daysOnMarket || property.daysOnMarket;
          property.estimatedValue = normalized.estimatedValue || property.estimatedValue;
          property.url = urlToUse || property.url;
          property.sourceId = normalized.sourceId || property.sourceId;
          
          await property.save();
          console.log(`✅ Updated property ${propertyId} with full details and ${finalImages.length} images`);
        }
        
        // Return full property details with enhanced images
        return res.status(200).json({
          success: true,
          message: `Fetched full property details with ${finalImages.length} images (enhanced)`,
          property: {
            ...normalized,
            images: finalImages, // Use enhanced images
            // Include raw property data for reference
            rawData: fullDetails.property,
          },
          images: finalImages, // Use enhanced images
          imageCount: finalImages.length,
        });
      } else {
        console.warn(`⚠️ URL-based actor returned no data, falling back to legacy method...`);
        // Fall through to legacy method below
      }
    }
    // If zpid is provided, use it to build URL (second priority)
    else if (zpid) {
      urlToUse = `https://www.zillow.com/homedetails/${zpid}_zpid/`;
      zpidToUse = String(zpid);
      console.log(`✅ Using provided ZPID to build URL: ${urlToUse}`);
    }
    // If propertyId is provided, check if it's a MongoDB ObjectId or a ZPID
    else if (propertyId) {
      const propertyIdStr = String(propertyId);
      
      // Check if it's a valid MongoDB ObjectId
      if (isValidObjectId(propertyIdStr)) {
        // It's a MongoDB ObjectId - fetch from database
        console.log(`🔍 propertyId is a MongoDB ObjectId, fetching from database...`);
        property = await Property.findById(propertyIdStr);
        if (!property) {
          return res.status(404).json({ error: 'Property not found in database' });
        }
        
        // Try to get URL or ZPID from property
        if (property.sourceId && !zpidToUse) {
          zpidToUse = String(property.sourceId);
        }
        if (property.url && !urlToUse) {
          urlToUse = property.url;
        }
        
        // Build URL from ZPID if we have it
        if (zpidToUse && !urlToUse) {
          urlToUse = `https://www.zillow.com/homedetails/${zpidToUse}_zpid/`;
          console.log(`🔗 Built property URL from database ZPID: ${urlToUse}`);
        }
      } else {
        // propertyId is not a valid ObjectId - treat it as ZPID
        console.log(`⚠️ propertyId "${propertyId}" is not a valid MongoDB ObjectId, treating as ZPID`);
        zpidToUse = propertyIdStr;
        urlToUse = `https://www.zillow.com/homedetails/${zpidToUse}_zpid/`;
        console.log(`🔗 Built property URL from propertyId (as ZPID): ${urlToUse}`);
      }
    }
    
    // If we still don't have a URL or ZPID, return error
    if (!urlToUse && !zpidToUse) {
      return res.status(400).json({ 
        error: 'Could not determine property URL or ZPID. Please provide propertyUrl or zpid.' 
      });
    }
    
    console.log(`📥 Fetching full property details - URL: ${urlToUse || 'N/A'}, ZPID: ${zpidToUse || 'N/A'}`);
    
    // Ensure zpidToUse is a string
    if (zpidToUse) {
      zpidToUse = String(zpidToUse).trim();
    }
    
    // Get property address if available (for fallback search or direct search)
    let propertyAddress = null;
    if (property && property.formattedAddress) {
      propertyAddress = property.formattedAddress;
    } else if (property && property.address) {
      propertyAddress = property.address;
    }
    
    // If we have ZPID but no address, try to get address from a quick search first
    // This helps when the actor doesn't support direct property URLs
    if (zpidToUse && !propertyAddress) {
      console.log(`🔍 ZPID provided but no address. The actor may need an address instead of URL.`);
      console.log(`💡 Consider providing the property address in the request for better results.`);
    }
    
    // Fetch full property details with all images
    const fullDetails = await fetchZillowPropertyDetails(urlToUse, zpidToUse, propertyAddress);
    
    if (!fullDetails || !fullDetails.property) {
      console.error(`❌ Failed to fetch property details. URL: ${urlToUse}, ZPID: ${zpidToUse}`);
      console.error(`❌ This could mean:`);
      console.error(`   1. The Apify actor doesn't support individual property URLs`);
      console.error(`   2. The property URL format is incorrect`);
      console.error(`   3. The property doesn't exist on Zillow`);
      console.error(`   4. The actor needs different input parameters`);
      
      return res.status(404).json({ 
        error: 'Could not fetch property details from Zillow',
        message: 'The property may not exist or the URL/ZPID may be invalid',
        details: {
          url: urlToUse,
          zpid: zpidToUse,
          suggestion: 'Please verify the ZPID is correct and the property exists on Zillow. The Apify actor may not support fetching individual property details by URL.'
        }
      });
    }
    
    // Normalize the property data
    const normalized = normalizePropertyData(fullDetails.property, 'zillow');
    
    if (!normalized) {
      return res.status(500).json({ 
        error: 'Failed to normalize property data' 
      });
    }
    
    // Enhance all images to higher resolution and quality
    let finalImages = normalized.images || [];
    if (finalImages.length > 0) {
      try {
        console.log(`🔍 Enhancing ${finalImages.length} images to higher resolution and quality...`);
        finalImages = await enhancePropertyImages(finalImages, {
          address: normalized.address || normalized.formattedAddress,
          propertyType: normalized.propertyType,
        });
        console.log(`✅ Image enhancement complete. ${finalImages.length} high-resolution images ready.`);
      } catch (enhanceError) {
        console.error('Error enhancing images:', enhanceError.message);
        // Continue with original images if enhancement fails
        console.log('⚠️ Using original images due to enhancement error');
      }
    }
    
    // Update property in database if propertyId was provided
    if (property && propertyId) {
      // Update property with full details
      property.images = finalImages; // Use enhanced images
      property.price = normalized.price || property.price;
      property.salePrice = normalized.salePrice || property.salePrice;
      property.beds = normalized.beds || property.beds;
      property.baths = normalized.baths || property.baths;
      property.squareFootage = normalized.squareFootage || property.squareFootage;
      property.lotSize = normalized.lotSize || property.lotSize;
      property.yearBuilt = normalized.yearBuilt || property.yearBuilt;
      property.propertyType = normalized.propertyType || property.propertyType;
      property.listingStatus = normalized.listingStatus || property.listingStatus;
      property.saleDate = normalized.saleDate || property.saleDate;
      property.daysOnMarket = normalized.daysOnMarket || property.daysOnMarket;
      property.estimatedValue = normalized.estimatedValue || property.estimatedValue;
      property.url = urlToUse || property.url;
      property.sourceId = zpidToUse || normalized.sourceId || property.sourceId;
      
      await property.save();
      console.log(`✅ Updated property ${propertyId} with full details and ${finalImages.length} images`);
    }
    
    // Return full property details with enhanced images
    res.status(200).json({
      success: true,
      message: `Fetched full property details with ${finalImages.length} images (enhanced)`,
      property: {
        ...normalized,
        images: finalImages, // Use enhanced images
        // Include raw property data for reference
        rawData: fullDetails.property,
      },
      images: finalImages, // Use enhanced images
      imageCount: finalImages.length,
    });
  } catch (error) {
    console.error('Error fetching property details:', error);
    res.status(500).json({ 
      error: 'Failed to fetch property details',
      message: error.message 
    });
  }
};

export const fetchMetadata = async (req, res) => {
  try {
    const { formattedAddress, address } = req.body;

    // Accept either formattedAddress or raw address
    let targetAddress = formattedAddress;
    let normalized = null;
    let existingProperty = null;

    // If raw address provided, normalize it first
    if (!targetAddress && address) {
      normalized = await normalizeAddress(address);
      if (!normalized) {
        return res.status(400).json({ error: 'Cannot normalize address' });
      }
      targetAddress = normalized.formattedAddress;
    }

    if (!targetAddress) {
      return res.status(400).json({ error: 'formattedAddress or address required' });
    }

    // If we have normalization info, detect country and avoid calling Zillow for non-US
    const countryCode = normalized?.addressComponents?.country_code;
    const isUS = (code) => {
      if (!code) return /United States/i.test(targetAddress);
      return ['us', 'usa', 'united states'].includes(String(code).toLowerCase());
    };
    if (countryCode && !isUS(countryCode)) {
      return res.status(400).json({
        error:
          'Zillow covers primarily US properties. The provided address appears outside the US. Use a local data source or remove the country from the address to attempt a search.',
      });
    }

    // Check if property exists in DB
    existingProperty = await Property.findOne({ formattedAddress: targetAddress });

    // If property exists and has price, skip scraping
    if (existingProperty && existingProperty.price) {
      return res.json({
        message: 'Property metadata already exists in database',
        property: existingProperty,
      });
    }

    // Prefer a zillow-friendly query from normalization when available
    const getZillowQuery = (addr, normalized) => {
      if (normalized && normalized.zillowQuery) return normalized.zillowQuery;
      if (!addr) return addr;
      // strip trailing country names like 'United States'
      return addr.replace(/,?\s*United States$/i, '').trim();
    };

    const zillowQuery = getZillowQuery(targetAddress, normalized);
    console.log(`[fetchMetadata] Scraping Zillow for: ${zillowQuery} (original: ${targetAddress})`);

    // Use Apify to scrape Zillow metadata
    const { scrapeZillowProperties, normalizePropertyData } = await import('../services/apifyService.js');
    
    const searchParams = {
      address: zillowQuery,
      latitude: normalized?.latitude,
      longitude: normalized?.longitude,
      radiusMiles: 0.1, // Very small radius for single property
      maxResults: 1,
    };

    const results = await scrapeZillowProperties(searchParams);
    
    let metadata = null;
    if (results?.success && results.data && results.data.length > 0) {
      const normalizedData = normalizePropertyData(results.data[0], 'zillow');
      metadata = {
        zpid: normalizedData.sourceId,
        price: normalizedData.price || normalizedData.salePrice,
        beds: normalizedData.beds,
        baths: normalizedData.baths,
        squareFootage: normalizedData.squareFootage,
        lotSize: normalizedData.lotSize,
        yearBuilt: normalizedData.yearBuilt,
        propertyType: normalizedData.propertyType,
        lastSoldDate: normalizedData.saleDate,
        lastSoldPrice: normalizedData.salePrice,
      };
    }

    if (!metadata) {
      return res.status(500).json({
        error: 'Failed to fetch property metadata from Zillow',
        zillowQuery,
        hint: 'If this is a non-US property (e.g., United Kingdom), Zillow likely has no data. Use debug endpoint to capture HTML or integrate a regional data source.',
      });
    }

    console.log(`[fetchMetadata] Metadata retrieved:`, {
      zpid: metadata.zpid,
      beds: metadata.beds,
      baths: metadata.baths,
      price: metadata.price,
      squareFootage: metadata.squareFootage,
      lotSize: metadata.lotSize,
      yearBuilt: metadata.yearBuilt,
      propertyType: metadata.propertyType,
    });

    // Prepare data to save/update
    const propertyData = {
      price: metadata.price, // store actual price here
      beds: metadata.beds,
      baths: metadata.baths,
      squareFootage: metadata.squareFootage,
      lotSize: metadata.lotSize,
      yearBuilt: metadata.yearBuilt,
      propertyType: metadata.propertyType,
      lastSoldDate: metadata.lastSoldDate,
      lastSoldPrice: metadata.lastSoldPrice,
    };

    let property;
    if (existingProperty) {
      // Update existing property with metadata
      property = await Property.findByIdAndUpdate(
        existingProperty._id,
        { ...propertyData },
        { new: true }
      );
    } else {
      // Create new property
      property = new Property({
        formattedAddress: targetAddress,
        rawAddress: address || targetAddress,
        latitude: normalized?.latitude,
        longitude: normalized?.longitude,
        ...propertyData,
      });
      await property.save();
    }

    res.json({
      message: 'Property metadata fetched and saved successfully',
      property,
    });
  } catch (err) {
    console.error('fetchMetadata error:', err.message);
    res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
};

export const saveProperty = async (req, res) => {
  const payload = req.body;
  if (!payload.formattedAddress)
    return res.status(400).json({ error: 'formattedAddress required' });

  try {
    const property = new Property(payload);
    await property.save();
    res.json({ success: true, property });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to save property' });
  }
};

export const searchProperties = async (req, res) => {
  try {
    const {
      areaName,
      city,
      state,
      postalCode,
      beds,
      baths,
      sqft,
      minPrice,
      maxPrice,
      propertyType,
      isSold,
      // Alternative: direct address
      address,
      latitude,
      longitude,
    } = req.body;

    console.log('Search properties request:', { areaName, city, state, postalCode, address, latitude, longitude });

    // Build address string from components or use provided address
    let searchAddress = address;
    let searchLat = latitude;
    let searchLng = longitude;

    // If address components provided, build address and normalize
    if (!searchAddress && (city || state || postalCode)) {
      const addressParts = [];
      // Include area name if provided, but don't require it
      if (areaName && areaName.trim()) addressParts.push(areaName.trim());
      // City is required for proper search
      if (city && city.trim()) addressParts.push(city.trim());
      // State is required
      if (state && state.trim()) addressParts.push(state.trim());
      // Postal code helps but not always required
      if (postalCode && postalCode.trim()) addressParts.push(postalCode.trim());
      
      // Need at least city and state
      if (addressParts.length >= 2) {
        searchAddress = addressParts.join(', ');
        console.log('Built address from components:', searchAddress);

        // Normalize address to get coordinates
        try {
          const normalized = await normalizeAddress(searchAddress);
          if (normalized && normalized.latitude && normalized.longitude) {
            searchLat = normalized.latitude;
            searchLng = normalized.longitude;
            searchAddress = normalized.formattedAddress || searchAddress;
            console.log('Normalized address:', searchAddress, 'Coords:', searchLat, searchLng);
          } else {
            console.warn('Address normalization returned null or missing coordinates');
            // If we have city and state, we can still try to search
            // The Apify actors might be able to handle it
          }
        } catch (normalizeError) {
          console.error('Address normalization error:', normalizeError.message);
          // Continue with original address if normalization fails
          // Apify might still be able to search with city/state
        }
      } else {
        console.warn('Insufficient address components. Need at least city and state.');
      }
    }

    // If we have coordinates but no address, that's fine
    // If we have address but no coordinates, try to normalize again
    if (searchAddress && (!searchLat || !searchLng)) {
      try {
        const normalized = await normalizeAddress(searchAddress);
        if (normalized) {
          searchLat = normalized.latitude;
          searchLng = normalized.longitude;
          searchAddress = normalized.formattedAddress;
        }
      } catch (normalizeError) {
        console.error('Second normalization attempt failed:', normalizeError.message);
      }
    }

    // Final check: we need either address OR coordinates
    // At minimum, we need city and state to search
    const hasMinAddress = (city && state) || searchAddress || (searchLat && searchLng);
    
    if (!hasMinAddress) {
      console.error('Missing required address information');
      return res.status(400).json({
        error: 'Insufficient address information. Please provide at minimum: city and state. Alternatively, provide a full address or latitude/longitude coordinates.',
        received: { areaName, city, state, postalCode, address, latitude, longitude },
        required: 'At minimum: city and state',
      });
    }

    // If we have coordinates but no address, create a basic address string for display
    if (!searchAddress && searchLat && searchLng) {
      const parts = [];
      if (city) parts.push(city);
      if (state) parts.push(state);
      if (postalCode) parts.push(postalCode);
      searchAddress = parts.length > 0 ? parts.join(', ') : `Location at ${searchLat}, ${searchLng}`;
    }

    // If we have address but no coordinates, geocode it NOW before searching
    // This is critical for accurate location filtering
    if (searchAddress && (!searchLat || !searchLng)) {
      try {
        const { normalizeAddress } = await import('../services/googleMapsService.js');
        const normalized = await normalizeAddress(searchAddress);
        if (normalized && normalized.latitude && normalized.longitude) {
          searchLat = normalized.latitude;
          searchLng = normalized.longitude;
          console.log(`✅ Geocoded address before search: ${searchLat}, ${searchLng}`);
        } else {
          console.warn('⚠️ Could not geocode address, will search by address string only');
        }
      } catch (geoError) {
        console.warn('⚠️ Geocoding failed before search:', geoError.message);
        console.error('Geocoding error details:', geoError);
      }
    }

    // Calculate search radius based on area type (default 1 mile for suburban)
    const searchRadius = 1.0; // miles

    // Determine if searching for sold properties
    // DEFAULT: Search for UNSOLD/ACTIVE properties (for user to select)
    // Only search sold if explicitly requested
    const searchSold = isSold === true || isSold === 'true' || isSold === 'sold';
    
    // If not specified, default to false (active/unsold properties)
    const searchActiveProperties = !searchSold;

    // Prepare search parameters
    // IMPORTANT: Search for ACTIVE/UNSOLD properties by default (user will select one)
    const searchParams = {
      address: searchAddress,
      latitude: searchLat,
      longitude: searchLng,
      radiusMiles: searchRadius,
      propertyType: propertyType || null,
      minPrice: minPrice || null,
      maxPrice: maxPrice || null,
      soldWithinMonths: null, // Not needed for active properties
      isSold: false, // Always search for ACTIVE/UNSOLD properties for user selection
    };

    console.log('Searching for ACTIVE/UNSOLD properties (user will select one, then we find SOLD comps)');

    // Try multiple sources in priority order
    const allProperties = [];
    const sources = ['zillow', 'redfin', 'realtor'];

    console.log('Starting property search with params:', searchParams);

    for (const source of sources) {
      try {
        console.log(`\n=== 🔍 Searching ${source.toUpperCase()} ===`);
        console.log(`Search params:`, {
          address: searchAddress,
          coordinates: searchLat && searchLng ? `${searchLat}, ${searchLng}` : 'none',
          radius: `${searchRadius} miles`,
        });
        
        let results;
        switch (source) {
          case 'zillow':
            results = await scrapeZillowProperties(searchParams);
            break;
          case 'redfin':
            results = await scrapeRedfinProperties(searchParams);
            break;
          case 'realtor':
            results = await scrapeRealtorProperties(searchParams);
            break;
        }

        console.log(`${source} raw results:`, {
          success: results?.success,
          dataLength: results?.data?.length || 0,
          message: results?.message,
          error: results?.error,
        });

        if (results?.success && results.data && Array.isArray(results.data)) {
          console.log(`${source} returned ${results.data.length} properties`);
          
          // Normalize and filter properties
          for (const rawData of results.data) {
            try {
              const normalized = normalizePropertyData(rawData, source);
              console.log(`Normalized property from ${source}:`, {
                address: normalized.address || normalized.formattedAddress,
                beds: normalized.beds,
                baths: normalized.baths,
                sqft: normalized.squareFootage,
                price: normalized.salePrice || normalized.price,
              });

              // Apply filters if provided (but be lenient)
              let matches = true;
              let filterReasons = [];

              // Beds filter (with tolerance)
              if (beds !== undefined && beds !== null && normalized.beds !== null) {
                const bedTolerance = 1;
                const bedDiff = Math.abs(normalized.beds - beds);
                if (bedDiff > bedTolerance) {
                  matches = false;
                  filterReasons.push(`beds: ${normalized.beds} vs ${beds} (diff: ${bedDiff})`);
                }
              }

              // Baths filter (with tolerance)
              if (baths !== undefined && baths !== null && normalized.baths !== null) {
                const bathTolerance = 1;
                const bathDiff = Math.abs(normalized.baths - baths);
                if (bathDiff > bathTolerance) {
                  matches = false;
                  filterReasons.push(`baths: ${normalized.baths} vs ${baths} (diff: ${bathDiff})`);
                }
              }

              // SqFt filter (with tolerance)
              if (sqft !== undefined && sqft !== null && normalized.squareFootage !== null) {
                const sqftTolerance = 0.3; // Increased to 30% for more flexibility
                const sqftDiff = Math.abs(normalized.squareFootage - sqft) / sqft;
                if (sqftDiff > sqftTolerance) {
                  matches = false;
                  filterReasons.push(`sqft: ${normalized.squareFootage} vs ${sqft} (diff: ${(sqftDiff * 100).toFixed(1)}%)`);
                }
              }

              // Price filters (strict)
              if (minPrice !== undefined && normalized.salePrice !== null && normalized.price !== null) {
                const price = normalized.salePrice || normalized.price;
                if (price < minPrice) {
                  matches = false;
                  filterReasons.push(`price too low: ${price} < ${minPrice}`);
                }
              }

              if (maxPrice !== undefined && normalized.salePrice !== null && normalized.price !== null) {
                const price = normalized.salePrice || normalized.price;
                if (price > maxPrice) {
                  matches = false;
                  filterReasons.push(`price too high: ${price} > ${maxPrice}`);
                }
              }

              // Property type filter (lenient)
              if (propertyType && normalized.propertyType) {
                const normalizedType = normalized.propertyType.toLowerCase();
                const searchType = propertyType.toLowerCase();
                if (!normalizedType.includes(searchType) && !searchType.includes(normalizedType)) {
                  // Don't filter out, just log
                  console.log(`Property type mismatch: ${normalizedType} vs ${searchType} (keeping anyway)`);
                }
              }

            // Check if property matches sold/active filter
            // IMPORTANT: For initial search, we ONLY want ACTIVE/UNSOLD properties
            const listingStatus = normalized.listingStatus?.toLowerCase() || '';
            const isPropertySold = listingStatus === 'sold' || 
                                  listingStatus.includes('sold') ||
                                  normalized.saleDate !== null; // If has sale date, likely sold
            const isPropertyActive = listingStatus === 'active' || 
                                    listingStatus === 'for_sale' || 
                                    listingStatus === 'for sale' ||
                                    listingStatus === 'available' ||
                                    (!isPropertySold && !normalized.saleDate);
            
            if (searchSold && !isPropertySold) {
              // If searching for sold, only include sold
              matches = false;
              filterReasons.push('not sold');
            } else if (!searchSold && isPropertySold) {
              // If searching for active, EXCLUDE sold properties
              matches = false;
              filterReasons.push('property is sold (need active/unsold)');
            }

              // If filters are too strict and we have few results, be more lenient
              const hasStrictFilters = (beds !== undefined && beds !== null) || 
                                      (baths !== undefined && baths !== null) || 
                                      (sqft !== undefined && sqft !== null);
              
              // If we have less than 5 properties and strict filters, be more lenient
              if (!matches && allProperties.length < 5 && hasStrictFilters) {
                console.log(`Relaxing filters for property (only ${allProperties.length} found so far)`);
                // Only check price filters, ignore beds/baths/sqft if we're being lenient
                matches = true;
                if (minPrice !== undefined && normalized.salePrice !== null && normalized.price !== null) {
                  const price = normalized.salePrice || normalized.price;
                  if (price < minPrice) matches = false;
                }
                if (maxPrice !== undefined && normalized.salePrice !== null && normalized.price !== null) {
                  const price = normalized.salePrice || normalized.price;
                  if (price > maxPrice) matches = false;
                }
                if (searchSold && normalized.listingStatus !== 'sold') {
                  matches = false;
                }
              }

              if (matches) {
                // Ensure images are included
                const propertyImages = normalized.images || 
                                      rawData.images || 
                                      rawData.photos || 
                                      rawData.imageUrls || 
                                      rawData.image_urls ||
                                      (rawData.image_url ? [rawData.image_url] : []) ||
                                      (rawData.imageUrl ? [rawData.imageUrl] : []) ||
                                      [];
                
                // Format for frontend
                const formattedProperty = {
                  zpid: normalized.sourceId || null,
                  address: normalized.address || normalized.formattedAddress,
                  price: normalized.salePrice || normalized.price || null,
                  beds: normalized.beds || null,
                  baths: normalized.baths || null,
                  sqft: normalized.squareFootage || null,
                  latitude: normalized.latitude || null,
                  longitude: normalized.longitude || null,
                  images: propertyImages, // Include images
                  listingStatus: normalized.listingStatus || 'active',
                  propertyType: normalized.propertyType || null,
                  yearBuilt: normalized.yearBuilt || null,
                  lotSize: normalized.lotSize || null,
                  source: source, // Which platform this came from
                  status: normalized.listingStatus === 'sold' ? 'sold' : 'active',
                  propertyType: normalized.propertyType || null,
                  lotSize: normalized.lotSize || null,
                  yearBuilt: normalized.yearBuilt || null,
                  saleDate: normalized.saleDate || null,
                  salePrice: normalized.salePrice || null,
                  images: normalized.images || [],
                  dataSource: normalized.dataSource,
                  formattedAddress: normalized.formattedAddress || normalized.address,
                  // Include property URL for fetching full details
                  propertyUrl: normalized.url || normalized.propertyUrl || null,
                  url: normalized.url || normalized.propertyUrl || null,
                };
                allProperties.push(formattedProperty);
                console.log(`✅ Added property: ${formattedProperty.address}`);
              } else {
                console.log(`❌ Filtered out property: ${normalized.address || 'unknown'} - Reasons: ${filterReasons.join(', ')}`);
              }
            } catch (normalizeError) {
              console.error(`Error normalizing property data from ${source}:`, normalizeError.message);
              console.error('Raw data:', JSON.stringify(rawData, null, 2));
            }
          }

          // Continue searching all sources (no early break)
          // We'll return all properties found, up to maxResults from each source
        } else {
          console.log(`${source} search failed or returned no data:`, results);
        }
      } catch (error) {
        console.error(`Error fetching from ${source}:`, error.message);
        console.error('Error stack:', error.stack);
        // Continue to next source
      }
    }

    console.log(`\n=== Search Complete ===`);
    console.log(`Total properties found: ${allProperties.length}`);

    // Remove duplicates based on address
    const uniqueProperties = [];
    const seenAddresses = new Set();

    for (const prop of allProperties) {
      // Handle address as string or object
      let addressStr = '';
      if (prop.address) {
        if (typeof prop.address === 'string') {
          addressStr = prop.address;
        } else if (typeof prop.address === 'object') {
          // Build address string from object
          const addr = prop.address;
          const parts = [];
          if (addr.streetAddress || addr.street) parts.push(addr.streetAddress || addr.street);
          if (addr.city) parts.push(addr.city);
          if (addr.state) parts.push(addr.state);
          if (addr.zipcode || addr.zipCode || addr.postalCode) {
            parts.push(addr.zipcode || addr.zipCode || addr.postalCode);
          }
          addressStr = parts.join(', ');
        }
      }
      
      const addressKey = addressStr?.toLowerCase().trim() || prop.formattedAddress?.toLowerCase().trim();
      if (addressKey && !seenAddresses.has(addressKey)) {
        seenAddresses.add(addressKey);
        uniqueProperties.push(prop);
      } else if (!addressKey) {
        // Include properties without address if they have coordinates
        if (prop.latitude && prop.longitude) {
          const coordKey = `${prop.latitude},${prop.longitude}`;
          if (!seenAddresses.has(coordKey)) {
            seenAddresses.add(coordKey);
            uniqueProperties.push(prop);
          }
        }
      }
    }

    console.log(`After deduplication: ${uniqueProperties.length} unique properties`);

    // Return all properties (no limit) - Apify already limits to maxResults
    const limitedProperties = uniqueProperties;

    if (limitedProperties.length === 0) {
      console.error('No properties found after filtering');
      
      // Check if Apify actors are configured
      const actorsConfigured = {
        zillow: !!(process.env.APIFY_ZILLOW_ACTOR_ID || process.env.ZILLOW_ACTOR_ID) && 
                (process.env.APIFY_ZILLOW_ACTOR_ID || process.env.ZILLOW_ACTOR_ID) !== 'your-zillow-actor-id',
        redfin: !!(process.env.APIFY_REDFIN_ACTOR_ID || process.env.REDFIN_ACTOR_ID) && 
                (process.env.APIFY_REDFIN_ACTOR_ID || process.env.REDFIN_ACTOR_ID) !== 'your-redfin-actor-id',
        realtor: !!(process.env.APIFY_REALTOR_ACTOR_ID || process.env.REALTOR_ACTOR_ID) && 
                 (process.env.APIFY_REALTOR_ACTOR_ID || process.env.REALTOR_ACTOR_ID) !== 'your-realtor-actor-id',
      };

      const configuredCount = Object.values(actorsConfigured).filter(Boolean).length;

      if (configuredCount === 0) {
        return res.status(503).json({ 
          message: 'Apify actors not configured',
          error: 'Please configure at least one Apify actor ID in your .env file',
          help: 'Add APIFY_ZILLOW_ACTOR_ID, APIFY_REDFIN_ACTOR_ID, or APIFY_REALTOR_ACTOR_ID',
          actorsConfigured,
          searchParams: {
            address: searchAddress,
            coordinates: { lat: searchLat, lng: searchLng },
            radius: searchRadius,
          },
        });
      }

      // If actors are configured but no results, provide detailed feedback
      return res.status(404).json({ 
        message: 'No active/unsold properties found matching your criteria',
        searchParams: {
          address: searchAddress,
          coordinates: searchLat && searchLng ? { lat: searchLat, lng: searchLng } : null,
          radius: `${searchRadius} miles`,
          filters: {
            beds,
            baths,
            sqft,
            priceRange: minPrice || maxPrice ? `${minPrice || 0} - ${maxPrice || 'unlimited'}` : 'any',
            propertyType: propertyType || 'any',
          },
        },
        actorsConfigured,
        sourcesTried: sources,
        suggestions: [
          'Try expanding the search area (increase radius)',
          'Remove or relax filters (beds, baths, sqft, price)',
          'Try a different location',
          'Check if Apify actors have valid API token and are working',
        ],
      });
    }

    console.log(`Returning ${limitedProperties.length} properties to frontend`);

  res.json({
    message: 'Properties fetched successfully',
      count: limitedProperties.length,
      properties: limitedProperties,
    });
  } catch (error) {
    console.error('searchProperties error:', error);
    res.status(500).json({
      error: 'Failed to search properties',
      message: error.message,
    });
  }
};

/**
 * Search property by address using APIFY_ZILLOW_ACTOR_ID
 * POST /api/property/search-by-address
 * Body: { address: "2659 Central Park Ct, Owensboro, KY 42303" }
 */
export const searchPropertyByAddress = asyncHandler(async (req, res, next) => {
  const { address } = req.body;

  if (!address || typeof address !== 'string' || address.trim().length === 0) {
    return next(new CustomError(400, 'Address is required'));
  }

  console.log(`🔍 Searching property by address: ${address}`);

  // Scrape property using address-based actor
  const result = await scrapePropertyByAddress(address.trim());

  if (!result.success) {
    // Preserve 402 status code for payment required errors
    if (result.statusCode === 402) {
      return next(new CustomError(
        402,
        result.message || result.error || 'Apify account payment required',
        result.suggestion
      ));
    }
    return next(new CustomError(404, result.message || 'Property not found'));
  }

  if (!result.data) {
    return next(new CustomError(404, 'No property data returned'));
  }

  const propertyData = result.data;

  // Enhance all images to higher resolution and quality
  let finalImages = propertyData.images || [];
  if (finalImages.length > 0) {
    try {
      console.log(`🔍 Enhancing ${finalImages.length} images to higher resolution and quality...`);
      finalImages = await enhancePropertyImages(finalImages, {
        address: propertyData.address || propertyData.formattedAddress,
        propertyType: propertyData.propertyType,
      });
      console.log(`✅ Image enhancement complete. ${finalImages.length} high-resolution images ready.`);
    } catch (enhanceError) {
      console.error('Error enhancing images:', enhanceError.message);
      // Continue with original images if enhancement fails
      console.log('⚠️ Using original images due to enhancement error');
    }
  }

  // Update property data with enhanced images
  propertyData.images = finalImages;

  // Save or update property in database
  let property = null;
  if (propertyData.formattedAddress) {
    property = await Property.findOne({
      formattedAddress: propertyData.formattedAddress,
    });
  }

  if (property) {
    // Update existing property
    property.images = finalImages;
    property.price = propertyData.price || property.price;
    property.salePrice = propertyData.salePrice || property.salePrice;
    property.beds = propertyData.beds || property.beds;
    property.baths = propertyData.baths || property.baths;
    property.squareFootage = propertyData.squareFootage || property.squareFootage;
    property.lotSize = propertyData.lotSize || property.lotSize;
    property.yearBuilt = propertyData.yearBuilt || property.yearBuilt;
    property.propertyType = propertyData.propertyType || property.propertyType;
    property.listingStatus = propertyData.listingStatus || property.listingStatus;
    property.sourceId = propertyData.sourceId || property.sourceId;
    property.url = propertyData.url || property.url;
    property.rawData = propertyData.rawData || property.rawData;
    await property.save();
  } else {
    // Create new property
    property = new Property({
      rawAddress: address,
      formattedAddress: propertyData.formattedAddress || propertyData.address,
      latitude: propertyData.latitude,
      longitude: propertyData.longitude,
      price: propertyData.price,
      salePrice: propertyData.salePrice,
      beds: propertyData.beds,
      baths: propertyData.baths,
      squareFootage: propertyData.squareFootage,
      lotSize: propertyData.lotSize,
      yearBuilt: propertyData.yearBuilt,
      propertyType: propertyData.propertyType,
      listingStatus: propertyData.listingStatus,
      images: finalImages,
      sourceId: propertyData.sourceId,
      url: propertyData.url,
      rawData: propertyData.rawData,
    });
    await property.save();
  }

  // Return property data with database ID
  const responseData = {
    ...propertyData,
    _id: property._id,
    images: finalImages,
  };

  res.status(200).json({
    success: true,
    message: 'Property found successfully',
    property: responseData,
  });
});

// Debug endpoint: capture raw HTML for inspection
export const debugHtml = async (req, res) => {
  try {
    const { formattedAddress, address } = req.body;

    let targetAddress = formattedAddress;
    let normalized = null;
    if (!targetAddress && address) {
      normalized = await normalizeAddress(address);
      if (!normalized) {
        return res.status(400).json({ error: 'Cannot normalize address' });
      }
      targetAddress = normalized.formattedAddress;
    }

    if (!targetAddress) {
      return res.status(400).json({ error: 'formattedAddress or address required' });
    }

    // Build zillow-friendly query
    const getZillowQuery = (addr, normalized) => {
      if (normalized && normalized.zillowQuery) return normalized.zillowQuery;
      if (!addr) return addr;
      return addr.replace(/,?\s*United States$/i, '').trim();
    };

    const zillowQuery = getZillowQuery(targetAddress, normalized);
    console.log(`[debugHtml] Fetching raw HTML for: ${zillowQuery} (original: ${targetAddress})`);

    // Import the fetchWithFallback function from scrapezillow
    const { fetchWithFallback } = await import('../utils/scrapezillow.js');

    // Get ZPID first
    const searchURL = `https://www.zillow.com/homes/${encodeURIComponent(zillowQuery)}/`;
    const { data: searchHTML } = await fetchWithFallback(searchURL);

    let zpid = null;
    const zpidMatch = searchHTML && searchHTML.match(/"zpid"\s*:\s*(\d+)/);
    if (zpidMatch) zpid = zpidMatch[1];

    if (!zpid) {
      return res.status(400).json({ error: 'ZPID not found' });
    }

    // Fetch property detail page
    const propertyURL = `https://www.zillow.com/homedetails/${zpid}_zpid/`;
    const { data: propertyHTML } = await fetchWithFallback(propertyURL);

    // Create debug folder if it doesn't exist
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const debugDir = path.join(__dirname, '../debug');
    if (!fs.existsSync(debugDir)) {
      fs.mkdirSync(debugDir, { recursive: true });
    }

    // Save HTML to file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `zillow_${zpid}_${timestamp}.html`;
    const filepath = path.join(debugDir, filename);
    fs.writeFileSync(filepath, propertyHTML);

    res.json({
      message: 'HTML captured and saved',
      zpid,
      address: targetAddress,
      htmlLength: propertyHTML.length,
      savedFile: filename,
      filepath,
      sampleSize: 1000,
      htmlSample: propertyHTML.substring(0, 1000),
    });
  } catch (err) {
    console.error('debugHtml error:', err.message);
    res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
};
