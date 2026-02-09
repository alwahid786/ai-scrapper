import axios from 'axios';

// Get Apify token directly from process.env (since it's optional in config)
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_API_BASE = 'https://api.apify.com/v2';

if (!APIFY_TOKEN) {
  console.warn('APIFY_TOKEN not found in environment variables');
}

const mapToZillowHomeType = (propertyType) => {
  if (!propertyType) return null;
  const type = propertyType.toLowerCase();
  if (type.includes('single') || type.includes('house')) return 'House';
  if (type.includes('condo')) return 'Condo';
  if (type.includes('town')) return 'Townhouse';
  if (type.includes('multi') || type.includes('duplex') || type.includes('apartment')) return 'Multi-family';
  if (type.includes('manufactured') || type.includes('mobile')) return 'Manufactured';
  if (type.includes('vacant') || type.includes('lot')) return 'Lot';
  return null;
};

const mapToRedfinPropertyType = (propertyType) => {
  if (!propertyType) return 'All Types';
  const type = propertyType.toLowerCase();
  if (type.includes('single') || type.includes('house')) return 'House';
  if (type.includes('condo')) return 'Condo';
  if (type.includes('town')) return 'Townhouse';
  if (type.includes('multi') || type.includes('duplex') || type.includes('apartment')) return 'Multi-Family';
  if (type.includes('manufactured') || type.includes('mobile')) return 'Manufactured';
  if (type.includes('vacant') || type.includes('lot')) return 'Land';
  return 'All Types';
};

const extractCityState = (locationString) => {
  if (!locationString) return { city: null, state: null };
  const cleaned = locationString.replace(/\s+/g, ' ').trim();
  const parts = cleaned.split(',').map((p) => p.trim()).filter(Boolean);

  if (parts.length >= 2) {
    const city = parts[0];
    const stateMatch = parts[1].match(/[A-Za-z]{2}/);
    const state = stateMatch ? stateMatch[0].toUpperCase() : null;
    return { city, state };
  }

  // Fallback: try to find state code anywhere in the string
  const stateMatch = cleaned.match(/\b([A-Z]{2})\b/i);
  const state = stateMatch ? stateMatch[1].toUpperCase() : null;
  return { city: state ? cleaned.replace(state, '').trim() : cleaned || null, state };
};

// Helper function to calculate distance between coordinates
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 3959; // Earth's radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const toRad = (degrees) => {
  return (degrees * Math.PI) / 180;
};

/**
 * Run Apify actor to scrape property data
 * Supports multiple actors: Zillow, Redfin, Realtor.com
 */
export const runApifyActor = async (actorId, input) => {
  if (!APIFY_TOKEN) {
    console.error('APIFY_TOKEN is not configured');
    return { success: false, data: [], message: 'APIFY_TOKEN not configured' };
  }

  if (!actorId || actorId === 'your-zillow-actor-id' || actorId === 'your-redfin-actor-id' || actorId === 'your-realtor-actor-id') {
    console.warn(`Apify actor ID not configured: ${actorId}`);
    return { success: false, data: [], message: 'Actor ID not configured' };
  }

  console.log(`Starting Apify actor: ${actorId}`);
  console.log('Actor input:', JSON.stringify(input, null, 2));

  try {
    // Apify API v2 format: /acts/{actorId}/runs
    // Actor ID in API MUST use tilde (~) instead of slash (/)
    // Example: "username/actor-name" becomes "username~actor-name" in API
    const apiActorId = actorId.replace(/\//g, '~');
    const actorUrl = `${APIFY_API_BASE}/acts/${apiActorId}/runs`;
    console.log(`Calling Apify API: ${actorUrl} (converted ${actorId} -> ${apiActorId})`);

    // First, verify actor exists and get input schema
    try {
      const actorInfoUrl = `${APIFY_API_BASE}/acts/${apiActorId}`;
      const actorInfo = await axios.get(actorInfoUrl, {
        headers: {
          Authorization: `Bearer ${APIFY_TOKEN}`,
        },
        timeout: 10000,
      });
      console.log('✅ Actor verified:', {
        name: actorInfo.data.data.name,
        username: actorInfo.data.data.username,
        actorId: apiActorId,
      });
      
      // Log input schema if available (helps debug input format issues)
      if (actorInfo.data.data.inputSchema) {
        console.log('Actor input schema:', JSON.stringify(actorInfo.data.data.inputSchema, null, 2));
      }
    } catch (verifyError) {
      const errorMsg = verifyError.response?.data?.error?.message || verifyError.message;
      const errorStatus = verifyError.response?.status;
      console.error(`❌ Actor verification failed for ${apiActorId}:`, errorStatus, errorMsg);
      
      if (errorStatus === 404) {
        return { 
          success: false, 
          data: [], 
          error: `Actor not found: ${actorId} (API format: ${apiActorId}). Please verify the actor ID is correct in your .env file.`,
          suggestion: 'Check Apify console to verify actor exists and is accessible with your token'
        };
      }
      // Continue anyway - might be a permission issue but actor exists
    }

    // Start the actor run
    let runResponse;
    try {
      runResponse = await axios.post(
        actorUrl,
        { ...input },
        {
          headers: {
            Authorization: `Bearer ${APIFY_TOKEN}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );
    } catch (postError) {
      // Handle 402 Payment Required error specifically
      if (postError.response?.status === 402) {
        const errorMessage = postError.response?.data?.error?.message || postError.message;
        console.error('❌ Apify Payment Required (402):', errorMessage);
        console.error('💳 This usually means:');
        console.error('   1. Your Apify account has exceeded its free tier quota');
        console.error('   2. The actor requires a paid plan to run');
        console.error('   3. Your account needs billing setup');
        console.error('🔗 Check your Apify account: https://console.apify.com/account/billing');
        return {
          success: false,
          data: [],
          error: 'Payment Required',
          message: `Apify account payment required (402). ${errorMessage || 'Please check your Apify account billing and quota limits.'}`,
          statusCode: 402,
          suggestion: 'Please check your Apify account billing at https://console.apify.com/account/billing and ensure you have sufficient credits or an active subscription.',
        };
      }
      // Re-throw other errors to be caught by outer catch
      throw postError;
    }

    console.log('Apify run started, response:', {
      status: runResponse.status,
      runId: runResponse.data?.data?.id,
    });

    const runId = runResponse.data.data.id;
    console.log(`✅ Apify actor run started: ${runId}`);
    console.log(`🔗 View run in Apify console: https://console.apify.com/actors/runs/${runId}`);

    // Wait for the run to complete (polling)
    let status = 'RUNNING';
    let attempts = 0;
    const maxAttempts = 120; // 10 minutes max wait (increased for slower scrapers)
    const pollInterval = 5000; // Check every 5 seconds

    console.log(`⏳ Waiting for actor to complete (max ${Math.round(maxAttempts * pollInterval / 1000 / 60)} minutes)...`);

    while (status === 'RUNNING' && attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval)); // Wait 5 seconds
      
      // Log progress every 30 seconds (every 6 attempts)
      if (attempts > 0 && attempts % 6 === 0) {
        console.log(`⏳ Still waiting... (${Math.round(attempts * pollInterval / 1000)} seconds elapsed)`);
      }

      try {
        const statusResponse = await axios.get(
          `${APIFY_API_BASE}/actor-runs/${runId}`,
          {
            headers: {
              Authorization: `Bearer ${APIFY_TOKEN}`,
            },
            timeout: 10000,
          }
        );

        status = statusResponse.data.data.status;
        attempts++;
        
        // Log status changes
        if (status !== 'RUNNING') {
          console.log(`📊 Actor status changed to: ${status}`);
        }

        if (status === 'SUCCEEDED') {
          // Fetch the results
          console.log(`✅ Apify actor ${actorId} succeeded, fetching results...`);
          const resultsResponse = await axios.get(
            `${APIFY_API_BASE}/actor-runs/${runId}/dataset/items`,
            {
              headers: {
                Authorization: `Bearer ${APIFY_TOKEN}`,
              },
              timeout: 30000,
            }
          );

          const data = resultsResponse.data || [];
          console.log(`📦 Apify actor ${actorId} returned ${Array.isArray(data) ? data.length : 'non-array'} items`);
          
          if (data.length > 0) {
            console.log('📋 Sample data from Apify:', JSON.stringify(data[0], null, 2));
          } else {
            console.warn(`⚠️ Apify actor ${actorId} succeeded but returned no data`);
          }

          return {
            success: true,
            data: Array.isArray(data) ? data : [],
            runId,
          };
        }

        if (status === 'FAILED' || status === 'ABORTED') {
          console.error(`Apify actor run ${status.toLowerCase()}: ${runId}`);
          
          // Try to get error details from the run
          try {
            const runResponse = await axios.get(
              `${APIFY_API_BASE}/actor-runs/${runId}`,
              {
                headers: {
                  Authorization: `Bearer ${APIFY_TOKEN}`,
                },
                timeout: 10000,
              }
            );
            
            const runData = runResponse.data?.data;
            if (runData?.defaultDatasetId) {
              // Try to get error from dataset
              try {
                const errorResponse = await axios.get(
                  `${APIFY_API_BASE}/datasets/${runData.defaultDatasetId}/items`,
                  {
                    headers: {
                      Authorization: `Bearer ${APIFY_TOKEN}`,
                    },
                    timeout: 10000,
                  }
                );
                const errorData = errorResponse.data;
                if (errorData && Array.isArray(errorData) && errorData.length > 0) {
                  console.error('Actor error details:', JSON.stringify(errorData[0], null, 2));
                }
              } catch (err) {
                // Ignore dataset fetch errors
              }
            }
            
            // Log run stats
            if (runData?.stats) {
              console.error('Actor run stats:', JSON.stringify(runData.stats, null, 2));
            }
            if (runData?.options?.build) {
              console.error('Actor build info:', JSON.stringify(runData.options.build, null, 2));
            }
          } catch (err) {
            console.error('Failed to fetch actor run details:', err.message);
          }
          
          return { success: false, data: [], error: `Actor run ${status.toLowerCase()}` };
        }
      } catch (statusError) {
        if (statusError.response?.status === 404) {
          // Run might not exist yet, continue polling
          continue;
        }
        // Handle 402 Payment Required during status polling
        if (statusError.response?.status === 402) {
          const errorMessage = statusError.response?.data?.error?.message || statusError.message;
          console.error('❌ Apify Payment Required (402) during status check:', errorMessage);
          console.error('💳 Your Apify account needs payment or has exceeded quota');
          console.error('🔗 Check your Apify account: https://console.apify.com/account/billing');
          return {
            success: false,
            data: [],
            error: 'Payment Required',
            message: `Apify account payment required (402). ${errorMessage || 'Please check your Apify account billing and quota limits.'}`,
            statusCode: 402,
            suggestion: 'Please check your Apify account billing at https://console.apify.com/account/billing and ensure you have sufficient credits or an active subscription.',
            runId,
          };
        }
        console.error('Error checking actor status:', statusError.message);
        // Continue polling instead of throwing
        continue;
      }
    }

    if (status === 'RUNNING') {
      console.error('Apify actor run timed out');
      return { success: false, data: [], error: 'Actor run timed out' };
    }

    console.error(`Apify actor run ended with status: ${status}`);
    return { success: false, data: [], error: `Actor run ended with status: ${status}` };
  } catch (error) {
    console.error('Apify Service Error:', error.message);
    if (error.response) {
      const statusCode = error.response.status;
      const errorData = error.response.data;
      console.error('Apify API Response Status:', statusCode);
      console.error('Apify API Response Data:', errorData);
      
      // Handle 402 Payment Required error
      if (statusCode === 402) {
        const errorMessage = errorData?.error?.message || error.message;
        console.error('❌ Apify Payment Required (402):', errorMessage);
        console.error('💳 This usually means:');
        console.error('   1. Your Apify account has exceeded its free tier quota');
        console.error('   2. The actor requires a paid plan to run');
        console.error('   3. Your account needs billing setup');
        console.error('🔗 Check your Apify account: https://console.apify.com/account/billing');
        return {
          success: false,
          data: [],
          error: 'Payment Required',
          message: `Apify account payment required (402). ${errorMessage || 'Please check your Apify account billing and quota limits.'}`,
          statusCode: 402,
          suggestion: 'Please check your Apify account billing at https://console.apify.com/account/billing and ensure you have sufficient credits or an active subscription.',
        };
      }
    }
    // Return empty data instead of throwing to allow fallback to other sources
    return { success: false, data: [], error: error.message };
  }
};

/**
 * Scrape Zillow properties using Apify
 */
export const scrapeZillowProperties = async (searchParams) => {
  const {
    address,
    city, // Direct city from propertyData
    state, // Direct state from propertyData
    postalCode, // Direct postalCode from propertyData
    latitude,
    longitude,
    radiusMiles = 1,
    propertyType,
    minPrice,
    maxPrice,
    soldWithinMonths = 6,
    isSold = false,
  } = searchParams;

  // Read directly from process.env to ensure we get the latest value
  // Note: This requires server restart if .env file is changed
  const ZILLOW_ACTOR_ID = process.env.APIFY_ZILLOW_ACTOR_ID || process.env.ZILLOW_ACTOR_ID;

  if (!ZILLOW_ACTOR_ID || ZILLOW_ACTOR_ID === 'your-zillow-actor-id') {
    console.warn('ZILLOW_ACTOR_ID not configured');
    return { success: false, data: [], message: 'Zillow actor not configured' };
  }

  console.log('🔍 Using Zillow actor:', ZILLOW_ACTOR_ID);
  console.log('🔍 Actor ID source:', process.env.APIFY_ZILLOW_ACTOR_ID ? 'APIFY_ZILLOW_ACTOR_ID' : (process.env.ZILLOW_ACTOR_ID ? 'ZILLOW_ACTOR_ID' : 'NOT FOUND'));
  console.log(`🔍 Search type: ${isSold ? 'SOLD' : 'FOR SALE'}`);
  
  // Warn if actor ID looks like a placeholder
  if (ZILLOW_ACTOR_ID.includes('your-') || ZILLOW_ACTOR_ID.includes('example')) {
    console.warn('⚠️ WARNING: Zillow actor ID appears to be a placeholder. Please update your .env file with the actual actor ID.');
  }

  if (!address && (!latitude || !longitude)) {
    return { success: false, data: [], message: 'Address or coordinates required for Zillow search' };
  }

  // Build Zillow search URL - MUST match exact Zillow URL format
  let searchUrl = '';
  
  // Use direct city/state from searchParams if available (from propertyData)
  let extractedCity = city;
  let extractedState = state;
  let extractedZip = postalCode;
  
  // If city/state not provided directly, parse from address string
  if (!extractedCity || !extractedState) {
  if (address) {
    console.log('📍 Original address:', address);
    
    // Parse address into components
    const addressParts = address.split(',').map(s => s.trim());
    
    console.log('📝 Address parts:', addressParts);
    
    // Extract components based on different address formats
    for (let i = 0; i < addressParts.length; i++) {
      const part = addressParts[i].trim();
      
      // Check if this part is a state (2-letter code or state name)
      if (/^[A-Z]{2}$/i.test(part)) {
          extractedState = part.toUpperCase();
        // City is usually the part before state
        if (i > 0) {
            extractedCity = addressParts[i - 1].trim();
        }
        // Zip might be in the next part or combined with state
        if (i + 1 < addressParts.length) {
          const nextPart = addressParts[i + 1].trim();
          const zipMatch = nextPart.match(/\d{5}/);
          if (zipMatch) {
              extractedZip = zipMatch[0];
          }
        }
        break;
      }
      
      // Check if this part contains "State Zip" format like "PA 19134"
      const stateZipMatch = part.match(/^([A-Z]{2})\s+(\d{5})$/i);
      if (stateZipMatch) {
          extractedState = stateZipMatch[1].toUpperCase();
          extractedZip = stateZipMatch[2];
        // City is the part before this
        if (i > 0) {
            extractedCity = addressParts[i - 1].trim();
        }
        break;
      }
      
      // Check if this part is just a zip code
      if (/^\d{5}$/.test(part)) {
          extractedZip = part;
        // Look back for state and city
        if (i > 0) {
          const prevPart = addressParts[i - 1].trim();
          if (/^[A-Z]{2}$/i.test(prevPart)) {
              extractedState = prevPart.toUpperCase();
            if (i > 1) {
                extractedCity = addressParts[i - 2].trim();
            }
          }
        }
        break;
        }
      }
      }
    }
    
  console.log('🏙️ Using - City:', extractedCity, 'State:', extractedState, 'Zip:', extractedZip);
    
    // Build Zillow URL in exact format Zillow uses
    const searchType = isSold ? 'sold' : 'for_sale';
    
  if (extractedCity && extractedState) {
      // Format city: lowercase, replace spaces with hyphens
    const formattedCity = extractedCity.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const formattedState = extractedState.toLowerCase();
    
    if (extractedZip) {
      // Format: /homes/city-state-zip/sold/ (e.g., /homes/philadelphia-pa-19134/sold/)
      searchUrl = `https://www.zillow.com/homes/${formattedCity}-${formattedState}-${extractedZip}/${searchType}/`;
      } else {
      // Format: /homes/city-state/sold/ (e.g., /homes/philadelphia-pa/sold/)
        searchUrl = `https://www.zillow.com/homes/${formattedCity}-${formattedState}/${searchType}/`;
      }
    console.log(`🌐 Built Zillow URL with city/state: ${searchUrl}`);
  } else if (latitude && longitude) {
      // Fallback to coordinate search if we have them
        searchUrl = `https://www.zillow.com/homes/${latitude},${longitude},${radiusMiles}mi/${searchType}/`;
    console.log(`🌐 Built Zillow URL with coordinates: ${searchUrl}`);
      } else {
        return { 
          success: false, 
          data: [], 
          message: 'Could not build Zillow search URL - need city and state or coordinates' 
        };
  }
  
  console.log('🌐 Zillow search URL:', searchUrl);
  
  // Build actor input in full format for igolaizola/zillow-scraper-ppe
  const input = {
    searchUrls: [searchUrl], // Array of URL strings
    maxResults: 200,
    includeAllImages: true,
    includePhotos: true,
    getFullDetails: true,
  };
  
  // Add location field (required by igolaizola/zillow-scraper-ppe)
  if (address) {
    input.location = address.trim();
  } else if (latitude && longitude) {
    input.location = `${latitude},${longitude}`;
  } else if (extractedCity && extractedState) {
    // Build location from city and state if address not available
    input.location = `${extractedCity}, ${extractedState}, USA`;
  }
  
  // Add coordinates if available
  if (latitude && longitude) {
    input.latitude = latitude;
    input.longitude = longitude;
    input.radius = radiusMiles;
  }
  
  // Add price range
  if (minPrice || maxPrice) {
    input.priceRange = {
      min: minPrice || 0,
      max: maxPrice || null
    };
    input.minPrice = minPrice || 0;
    input.maxPrice = maxPrice || 0;
  } else {
    input.minPrice = 0;
    input.maxPrice = 0;
  }
  
  // Add property type filter
  if (propertyType) {
    input.propertyType = propertyType;
  }
  
  // Set maxItems (some actors use this)
  input.maxItems = 1000;
  
  // Set operation type
  input.operation = "buy";
  
  // Set sort order
  input.sortBy = "newest";
  
  // Bed/Bath filters (set to 0 to not filter)
  input.minBeds = 0;
  input.maxBeds = 0;
  input.minBaths = 0;
  
  // Size filters (empty strings = no filter)
  input.minSize = "";
  input.maxSize = "";
  input.minLotSize = "";
  input.maxLotSize = "";
  
  // Feature filters (all false = no filter)
  input.airConditioning = false;
  input.pool = false;
  input.waterfront = false;
  input.singleStory = false;
  input.basement = false;
  input["3dTour"] = false;
  input.timeOnZillow = "";
  input.maxHoaFees = "";
  input.parkingSpots = "";
  input.garage = false;
  
  // Listing type filters
  input.agentListed = true;
  input.ownerPosted = true;
  input.newConstruction = true;
  input.foreclosure = true;
  input.auction = true;
  input.foreclosed = false;
  input.preForeclosure = false;
  input.comingSoon = true;
  input.priceDrop = false;
  input.acceptingBackupOffers = false;
  input.pendingUnderContract = false;
  input.showcase = false;
  input.openHouse = false;
  input.hideNoMoveInDate = false;
  
  // Additional filters
  input.pets = [];
  input.inUnitLaundry = false;
  input.onSiteParking = false;
  input.elevator = false;
  input.highSpeedInternet = false;
  input.furnished = false;
  input.outdoorSpace = false;
  input.utilitiesIncluded = false;
  input.hardwoodFloors = false;
  input.disabilityAccess = false;
  input.incomeRestricted = false;
  input.apartmentCommunity = false;
  input.acceptsZillowApplications = false;
  input.tourScheduling = false;
  input.shortTermLease = false;
  
  // For sold properties, set maxSoldDate based on soldWithinMonths
  // Zillow actor expects: "", "1d", "1w", "2w", "1m", "3m", "6m", "1y", "2y", "3y"
  if (isSold && soldWithinMonths) {
    // Convert months to the allowed format
    if (soldWithinMonths <= 1) {
      input.maxSoldDate = "1m";
    } else if (soldWithinMonths <= 3) {
      input.maxSoldDate = "3m";
    } else if (soldWithinMonths <= 6) {
      input.maxSoldDate = "6m";
    } else if (soldWithinMonths <= 12) {
      input.maxSoldDate = "1y";
    } else if (soldWithinMonths <= 24) {
      input.maxSoldDate = "2y";
    } else {
      input.maxSoldDate = "3y";
    }
  } else {
    input.maxSoldDate = "";
  }
  
  // Remove null/undefined values and empty arrays
  Object.keys(input).forEach(key => {
    if (
      input[key] === null ||
      input[key] === undefined ||
      (Array.isArray(input[key]) && input[key].length === 0 && key !== 'pets')
    ) {
      delete input[key];
    }
  });

  console.log('📤 Zillow Apify input:', JSON.stringify(input, null, 2));
  console.log('🔗 Zillow search URL:', searchUrl);

  // axesso_data/zillow-search-by-address-scraper expects payload under "input" key
  const actorPayload = ZILLOW_ACTOR_ID && ZILLOW_ACTOR_ID.includes('axesso_data')
    ? { input }
    : input;

  try {
    const result = await runApifyActor(ZILLOW_ACTOR_ID, actorPayload);
    console.log('📥 Zillow Apify result:', { 
      success: result.success, 
      dataLength: result.data?.length || 0,
      error: result.error || 'none'
    });
    
    if (!result.success) {
      console.error('❌ Zillow actor failed:', result.error || result.message);
      if (result.runId) {
        console.error(`🔗 Check run status in Apify console: https://console.apify.com/actors/runs/${result.runId}`);
      }
      return result;
    }
    
    if (result.data && result.data.length > 0) {
      console.log('✅ Zillow returned', result.data.length, 'properties');
      
      // Debug: Log image information for first property
      const firstProperty = result.data[0];
      console.log('📦 Sample Zillow property keys:', Object.keys(firstProperty));
      
      // Check for image-related fields
      const imageFields = Object.keys(firstProperty).filter(k => 
        k.toLowerCase().includes('image') || 
        k.toLowerCase().includes('photo') || 
        k.toLowerCase().includes('media')
      );
      console.log('🖼️ Image-related fields found:', imageFields);
      
      if (firstProperty.media) {
        console.log('📸 Media object keys:', Object.keys(firstProperty.media));
        if (firstProperty.media.photos) {
          console.log(`📸 media.photos: ${Array.isArray(firstProperty.media.photos) ? firstProperty.media.photos.length : 'not an array'} items`);
        }
        if (firstProperty.media.images) {
          console.log(`📸 media.images: ${Array.isArray(firstProperty.media.images) ? firstProperty.media.images.length : 'not an array'} items`);
        }
        if (firstProperty.media.photoUrls) {
          console.log(`📸 media.photoUrls: ${Array.isArray(firstProperty.media.photoUrls) ? firstProperty.media.photoUrls.length : 'not an array'} items`);
        }
        if (firstProperty.media.allPhotos) {
          console.log(`📸 media.allPhotos: ${Array.isArray(firstProperty.media.allPhotos) ? firstProperty.media.allPhotos.length : 'not an array'} items`);
        }
        if (firstProperty.media.propertyPhotoLinks) {
          const links = firstProperty.media.propertyPhotoLinks;
          console.log(`📸 media.propertyPhotoLinks: ${typeof links === 'object' ? Object.keys(links).length : 'not an object'} links`);
        }
      }
      
      // Extract images to see how many we're getting
      const extractedImages = extractImages(firstProperty, 'zillow');
      console.log(`🖼️ Extracted ${extractedImages.length} images from first property`);
      if (extractedImages.length > 0) {
        console.log('📸 First few image URLs:', extractedImages.slice(0, 3));
      }
      
      // Debug: Check if any properties have sold indicators
      const soldCount = result.data.filter(p => {
        const status = (p.listingStatus || p.status || p.listing_status || '').toLowerCase();
        const hasSaleDate = !!(p.saleDate || p.dateSold || p.lastSoldDate || p.closingDate);
        const hasSalePrice = !!(p.salePrice || p.lastSoldPrice || p.soldPrice);
        return status.includes('sold') || hasSaleDate || hasSalePrice;
      }).length;
      console.log(`🔍 Found ${soldCount} properties with sold indicators out of ${result.data.length} total`);
    } else {
      console.warn('⚠️ Zillow returned no properties');
    }
    
    // Filter by price if provided
    if (result.success && result.data && (minPrice || maxPrice)) {
      const originalCount = result.data.length;
      result.data = result.data.filter(property => {
        const price = property.price || property.salePrice || property.listPrice || 0;
        if (minPrice && price < minPrice) return false;
        if (maxPrice && price > maxPrice) return false;
        return true;
      });
      console.log(`💰 Filtered Zillow by price: ${originalCount} -> ${result.data.length}`);
    }
    
    return result;
  } catch (error) {
    console.error('❌ Zillow scraping error:', error.message);
    return { 
      success: false, 
      data: [], 
      error: error.message,
      message: 'Zillow scraping failed' 
    };
  }
};

/**
 * Scrape Zillow SOLD properties using the dedicated sold actor (igolaizola/zillow-scraper-ppe).
 * Used for comparable sales search. Input follows actor's form: location, operation "sold",
 * maxSoldDate, minBeds/maxBeds, minBaths, minPrice/maxPrice, optional minSize/maxSize.
 * @param {Object} searchParams - { address, city, state, postalCode, latitude, longitude, radiusMiles, propertyType, soldWithinMonths, minPrice, maxPrice, minBeds, maxBeds, minBaths, minSqft, maxSqft }
 * @returns {{ success: boolean, data: Array }}
 */
export const scrapeZillowSoldProperties = async (searchParams) => {
  const {
    address,
    city,
    state,
    postalCode,
    latitude,
    longitude,
    radiusMiles = 1,
    propertyType,
    minPrice,
    maxPrice,
    minBeds,
    maxBeds,
    minBaths,
    minSqft,
    maxSqft,
    soldWithinMonths = 6,
  } = searchParams;

  const ZILLOW_SOLD_ACTOR_ID = process.env.APIFY_ZILLOW_SOLD_ACTOR_ID;

  if (!ZILLOW_SOLD_ACTOR_ID) {
    console.warn('APIFY_ZILLOW_SOLD_ACTOR_ID not configured');
    return { success: false, data: [], message: 'Zillow Sold actor not configured' };
  }

  let extractedCity = city;
  let extractedState = state;
  let extractedZip = postalCode;

  if (!extractedCity || !extractedState) {
    if (address) {
      const addressParts = address.split(',').map((s) => s.trim()).filter(Boolean);
      for (let i = 0; i < addressParts.length; i++) {
        const part = addressParts[i];
        if (/^[A-Z]{2}$/i.test(part)) {
          extractedState = part.toUpperCase();
          if (i > 0) extractedCity = addressParts[i - 1];
          const zipMatch = part.match(/\d{5}/) || (addressParts[i + 1] && addressParts[i + 1].match(/\d{5}/));
          if (zipMatch) extractedZip = zipMatch[0];
          break;
        }
      }
      if (!extractedCity && addressParts.length > 0) extractedCity = addressParts[0];
    }
  }

  const locationStr = extractedCity && extractedState
    ? `${extractedCity}, ${extractedState}`
    : (address || (latitude && longitude ? `${latitude},${longitude}` : ''));

  if (!locationStr) {
    return { success: false, data: [], message: 'Location (city/state or address) required for Zillow Sold search' };
  }

  if (soldWithinMonths <= 0) {
    return { success: false, data: [], message: 'soldWithinMonths must be positive' };
  }

  const maxSoldDate = soldWithinMonths <= 1 ? '1m' : soldWithinMonths <= 3 ? '3m' : soldWithinMonths <= 6 ? '6m' : soldWithinMonths <= 12 ? '1y' : soldWithinMonths <= 24 ? '2y' : '3y';

  // igolaizola/zillow-scraper-ppe only accepts specific minSize/maxSize values
  const ZILLOW_SOLD_ALLOWED_SQFT = ['', '500', '750', '1000', '1250', '1500', '1750', '2000', '2250', '2500', '2750', '3000', '3500', '4000', '5000', '7500'];
  const snapSqftToAllowed = (val) => {
    if (val == null || val <= 0) return '';
    const num = Number(val);
    const allowed = ZILLOW_SOLD_ALLOWED_SQFT.filter((s) => s !== '').map(Number);
    const nearest = allowed.reduce((prev, curr) => (Math.abs(curr - num) < Math.abs(prev - num) ? curr : prev));
    return String(nearest);
  };

  const input = {
    location: locationStr,
    operation: 'sold',
    maxSoldDate,
    sortBy: 'newest',
    maxItems: 1000,
    minBeds: minBeds != null ? minBeds : 0,
    maxBeds: maxBeds != null ? maxBeds : 0,
    minBaths: minBaths != null ? minBaths : 0,
    minPrice: minPrice != null ? minPrice : 0,
    maxPrice: maxPrice != null ? maxPrice : 0,
    minSize: minSqft != null && minSqft > 0 ? snapSqftToAllowed(minSqft) : '',
    maxSize: maxSqft != null && maxSqft > 0 ? snapSqftToAllowed(maxSqft) : '',
    minLotSize: '',
    maxLotSize: '',
    timeOnZillow: '',
    maxHoaFees: '',
    parkingSpots: '',
    pets: [],
    "3dTour": false,
    acceptingBackupOffers: false,
    acceptsZillowApplications: false,
    agentListed: true,
    airConditioning: false,
    apartmentCommunity: false,
    auction: true,
    basement: false,
    comingSoon: true,
    disabilityAccess: false,
    elevator: false,
    foreclosed: false,
    foreclosure: true,
    furnished: false,
    garage: false,
    hardwoodFloors: false,
    hideNoMoveInDate: false,
    highSpeedInternet: false,
    inUnitLaundry: false,
    incomeRestricted: false,
    locationType: '',
    newConstruction: true,
    onSiteParking: false,
    openHouse: false,
    outdoorSpace: false,
    ownerPosted: true,
    pendingUnderContract: false,
    pool: false,
    preForeclosure: false,
    priceDrop: false,
    shortTermLease: false,
    singleStory: false,
    showcase: false,
    tourScheduling: false,
    utilitiesIncluded: false,
    waterfront: false,
  };

  if (propertyType) {
    const t = (propertyType || '').toLowerCase();
    if (t.includes('single') || t.includes('house') || t === 'house') input.propertyType = 'singleFamily';
    else if (t.includes('condo')) input.propertyType = 'condo';
    else if (t.includes('town')) input.propertyType = 'townhouse';
    else if (t.includes('multi') || t.includes('duplex')) input.propertyType = 'multiFamily';
    else if (t.includes('manufactured') || t.includes('mobile')) input.propertyType = 'manufactured';
    else if (t.includes('lot') || t.includes('vacant')) input.propertyType = 'lot';
  }

  Object.keys(input).forEach((key) => {
    if (input[key] === null || input[key] === undefined) delete input[key];
  });

  console.log('🔍 Zillow Sold actor input:', JSON.stringify({ ...input, location: input.location, operation: input.operation, maxSoldDate: input.maxSoldDate, minBeds: input.minBeds, maxBeds: input.maxBeds, minBaths: input.minBaths, minPrice: input.minPrice, maxPrice: input.maxPrice }, null, 2));

  try {
    const result = await runApifyActor(ZILLOW_SOLD_ACTOR_ID, input);
    if (!result.success) {
      console.error('❌ Zillow Sold actor failed:', result.error || result.message);
      return result;
    }
    if (result.data && result.data.length > 0) {
      console.log('✅ Zillow Sold actor returned', result.data.length, 'properties');
    }
    return result;
  } catch (error) {
    console.error('❌ Zillow Sold scraping error:', error.message);
    return {
      success: false,
      data: [],
      error: error.message,
      message: 'Zillow Sold scraping failed',
    };
  }
};

/**
 * Scrape Redfin properties using Apify
 */
export const scrapeRedfinProperties = async (searchParams) => {
  const {
    address,
    city, // Direct city from propertyData
    state, // Direct state from propertyData
    postalCode, // Direct postalCode from propertyData
    latitude,
    longitude,
    radiusMiles = 1,
    propertyType,
    minPrice,
    maxPrice,
    minBeds,
    minBaths,
    minSqft,
    soldWithinMonths = 6,
    isSold = false,
  } = searchParams;

  const REDFIN_ACTOR_ID = process.env.APIFY_REDFIN_ACTOR_ID || process.env.REDFIN_ACTOR_ID;

  if (!REDFIN_ACTOR_ID || REDFIN_ACTOR_ID === 'your-redfin-actor-id') {
    console.warn('REDFIN_ACTOR_ID not configured');
    return { success: false, data: [], message: 'Redfin actor not configured' };
  }

  console.log('Using Redfin actor:', REDFIN_ACTOR_ID);
  console.log(`🔍 Search type: ${isSold ? 'SOLD' : 'FOR SALE'}`);
  console.warn('⚠️ Note: This Redfin actor may not respect location parameter and return default results');

  if (!address && !latitude && !longitude) {
    return { success: false, data: [], message: 'Address or coordinates required for Redfin search' };
  }

  // Build input for Redfin scraper
  // Prefer city/state strings for location; this actor can default to Miami on invalid input.
  let redfinLocation = '';
  
  // Use direct city/state from searchParams if available (from propertyData)
  let extractedCity = city;
  let extractedState = state;
  let extractedZip = postalCode;
  
  if (extractedCity && extractedState) {
    // Use direct city/state from propertyData
    redfinLocation = `${extractedCity}, ${extractedState}`;
    console.log(`📍 Using city, state from propertyData for Redfin: ${redfinLocation}`);
  } else if (address) {
    // Extract city and state from address if not provided directly
    const addressParts = address.split(',').map(s => s.trim());
    const cleanParts = addressParts.filter(p => p.toUpperCase() !== 'USA');
    
    // Find city and state
    for (let i = 0; i < cleanParts.length; i++) {
      const part = cleanParts[i].trim();
      
      // Check if this part is a state (2-letter code)
      if (/^[A-Z]{2}$/i.test(part)) {
        extractedState = part.toUpperCase();
        if (i > 0) {
          extractedCity = cleanParts[i - 1].trim();
        }
        break;
      }
      
      // Check if this part contains "State Zip" format
      const stateZipMatch = part.match(/^([A-Z]{2})\s+(\d{5})$/i);
      if (stateZipMatch) {
        extractedState = stateZipMatch[1].toUpperCase();
        if (i > 0) {
          extractedCity = cleanParts[i - 1].trim();
        }
        break;
      }
    }
    
    if (extractedCity && extractedState) {
      redfinLocation = `${extractedCity}, ${extractedState}${extractedZip ? ` ${extractedZip}` : ''}`;
      console.log(`📍 Using parsed city, state for Redfin: ${redfinLocation}`);
    } else {
      redfinLocation = address;
      console.log(`📍 Using full address for Redfin: ${redfinLocation}`);
    }
  }
  
  // Only use coordinates as a last resort
  if (!redfinLocation && latitude && longitude) {
    redfinLocation = `${latitude},${longitude}`;
    console.log(`📍 Using coordinates for Redfin (fallback): ${redfinLocation}`);
  }

  if (!redfinLocation) {
    return { success: false, data: [], message: 'Address or coordinates required for Redfin search' };
  }
  
  // Map propertyType to Redfin's expected values: "all", "house", "condo", "townhouse", "land", "multi_family"
  let redfinPropertyType = null;
  if (propertyType) {
    const propertyTypeLower = propertyType.toLowerCase();
    if (propertyTypeLower.includes('single') || propertyTypeLower.includes('family') || propertyTypeLower === 'house') {
      redfinPropertyType = 'house';
    } else if (propertyTypeLower.includes('condo')) {
      redfinPropertyType = 'condo';
    } else if (propertyTypeLower.includes('townhouse') || propertyTypeLower.includes('town-house')) {
      redfinPropertyType = 'townhouse';
    } else if (propertyTypeLower.includes('multi') || propertyTypeLower.includes('duplex')) {
      redfinPropertyType = 'multi_family';
    } else if (propertyTypeLower.includes('land') || propertyTypeLower.includes('vacant')) {
      redfinPropertyType = 'land';
    } else {
      redfinPropertyType = 'all'; // Default to all if unknown
    }
  }

  const input = {
    location: redfinLocation,
    maxResults: 200, // Increased to get more properties
    // Add filters if provided - use mapped propertyType
    ...(redfinPropertyType ? { propertyType: redfinPropertyType } : {}),
    // IMPORTANT: Explicitly set isSold for sold property searches
    ...(isSold ? { isSold: true } : {}),
    // For sold properties, include soldWithinMonths
    ...(isSold && soldWithinMonths ? { soldWithinMonths } : {}),
    // Add radius if we have coordinates
    ...(latitude && longitude && radiusMiles ? { radius: radiusMiles } : {}),
    // Add price filters if provided
    ...(minPrice ? { minPrice } : {}),
    ...(maxPrice ? { maxPrice } : {}),
    ...(minBeds ? { minBeds } : {}),
    ...(minBaths ? { minBaths } : {}),
    ...(minSqft ? { minSqft } : {}),
  };

  // Remove null/undefined values
  Object.keys(input).forEach(key => {
    if (input[key] === null || input[key] === undefined) {
      delete input[key];
    }
  });

  console.log('Redfin Apify input:', JSON.stringify(input, null, 2));
  const result = await runApifyActor(REDFIN_ACTOR_ID, input);
  console.log('Redfin Apify result:', { success: result.success, dataLength: result.data?.length || 0 });
  
  // Check if Redfin actor is returning wrong location (known issue with this actor)
  const derived = extractCityState(redfinLocation);
  const expectedCity = extractedCity ? extractedCity.toLowerCase() : (derived.city ? derived.city.toLowerCase() : '');
  const expectedState = extractedState ? extractedState.toLowerCase() : (derived.state ? derived.state.toLowerCase() : '');

  if (result.success && result.data && result.data.length > 0) {
    const sampleProperty = result.data[0];
    const sampleCity = (sampleProperty.city || '').toLowerCase();
    const sampleState = (sampleProperty.state || '').toLowerCase();
    
    // If we have expected city/state and they don't match, the actor is broken
    if (expectedCity && expectedState && sampleCity && sampleState) {
      if (sampleCity !== expectedCity || sampleState !== expectedState) {
        console.warn(`⚠️ Redfin actor returned properties from ${sampleCity}, ${sampleState} but we searched for ${expectedCity}, ${expectedState}`);
        console.warn(`⚠️ This actor is known to ignore location parameters. Results may be inaccurate.`);
        
        // If the location is completely wrong (different state), skip Redfin entirely
        if (sampleState !== expectedState) {
          console.error(`❌ Redfin actor returned wrong state (${sampleState} vs ${expectedState}). Skipping Redfin results.`);
          return { success: false, data: [], message: 'Redfin actor returned properties from wrong location', error: 'Actor location mismatch' };
        }
      }
    }
    
    // Check if Redfin is returning sold properties when requested
    if (isSold) {
      const soldCount = result.data.filter(p => {
        const listingType = (p.listing_type || p.listingType || '').toLowerCase();
        const listingStatus = (p.listing_status || p.listingStatus || p.status || '').toLowerCase();
        return listingType === 'sold' || listingType.includes('sold') || listingStatus === 'sold' || listingStatus.includes('sold');
      }).length;
      
      if (soldCount === 0 && result.data.length > 0) {
        console.warn(`⚠️ Redfin actor returned ${result.data.length} properties but NONE are marked as sold, even though isSold=true was set`);
        console.warn(`⚠️ This actor may not support sold property searches. Sample listing_type: ${result.data[0]?.listing_type || 'unknown'}`);
      }
    }

    // Hard filter to requested city/state to avoid default Miami results
    if (expectedCity && expectedState) {
      const originalCount = result.data.length;
      result.data = result.data.filter((property) => {
        const propCity = (property.city || '').toLowerCase();
        const propState = (property.state || '').toLowerCase();
        const propAddress = (property.address || property.full_address || '').toLowerCase();

        const cityMatch = propCity && (propCity === expectedCity || propCity.includes(expectedCity) || expectedCity.includes(propCity));
        const stateMatch = propState && (propState === expectedState || propState.includes(expectedState) || expectedState.includes(propState));
        const addressCityMatch = propAddress.includes(expectedCity);
        const addressStateMatch = propAddress.includes(`, ${expectedState}`) || propAddress.includes(` ${expectedState}`);

        return (cityMatch || addressCityMatch) && (stateMatch || addressStateMatch);
      });

      console.log(`✅ Redfin hard-filtered by city/state: ${originalCount} -> ${result.data.length}`);
      if (result.data.length === 0) {
        return {
          success: false,
          data: [],
          message: 'Redfin actor returned properties from wrong location',
          error: 'Actor location mismatch',
        };
      }
    }
  }
  
  // Filter results by location - use geocoding if needed
  // Filter by distance if we have coordinates
  if (result.success && result.data && result.data.length > 0) {
    // Get search coordinates if not provided
    let searchLat = latitude;
    let searchLng = longitude;
    
    if (!searchLat || !searchLng) {
      try {
        const { normalizeAddress } = await import('./googleMapsService.js');
        const geocoded = await normalizeAddress(address);
        if (geocoded && geocoded.latitude && geocoded.longitude) {
          searchLat = geocoded.latitude;
          searchLng = geocoded.longitude;
          console.log(`✅ Geocoded Redfin search location: ${searchLat}, ${searchLng}`);
        }
      } catch (geoError) {
        console.warn('⚠️ Failed to geocode for distance filtering:', geoError.message);
      }
    }
    
    console.log('📊 Redfin returned', result.data.length, 'properties before filtering');
    
    // STRICT FILTER: Only keep properties within search radius OR matching city/state
    if (searchLat && searchLng) {
      const originalCount = result.data.length;
      result.data = result.data.filter((property) => {
        const propLat = property.latitude || property.lat;
        const propLng = property.longitude || property.lng || property.lon;
        
        // If property has coordinates, filter by distance (most accurate)
        if (propLat && propLng) {
          const distance = calculateDistance(searchLat, searchLng, propLat, propLng);
          const withinRadius = distance <= radiusMiles;
          
          if (!withinRadius) {
            console.log(`❌ Filtered out by distance: ${property.address || property.full_address || 'unknown'} (${distance.toFixed(2)}mi away)`);
          }
          
          return withinRadius;
        }
        
        // If no coordinates, fall back to city/state matching
        console.log(`⚠️ Property missing coordinates, using city/state filter: ${property.address || property.full_address || 'unknown'}`);
        
        // Extract city and state from redfinLocation or use provided city/state
        let searchCity, searchState;
        if (city && state) {
          searchCity = city.toLowerCase();
          searchState = state.toLowerCase();
        } else {
        const locationParts = redfinLocation.split(',').map(s => s.trim());
          searchCity = locationParts[0]?.toLowerCase();
          searchState = locationParts[1]?.toLowerCase();
        }
        
        if (searchCity && searchState) {
          const propCity = (property.city || '').toLowerCase();
          const propState = (property.state || '').toLowerCase();
          const propAddress = (property.address || property.full_address || '').toLowerCase();
          
          const cityMatch = propCity && (propCity === searchCity || propCity.includes(searchCity) || searchCity.includes(propCity));
          const stateMatch = propState && (propState === searchState || propState.includes(searchState) || searchState.includes(propState));
          
          // Also check address string
          const addressCityMatch = propAddress && propAddress.includes(searchCity);
          const addressStateMatch = propAddress && (propAddress.includes(`, ${searchState}`) || propAddress.includes(` ${searchState}`));
          
          const matches = (cityMatch || addressCityMatch) && (stateMatch || addressStateMatch);
          
          if (!matches) {
            console.log(`❌ Filtered out by city/state: ${property.address || property.full_address || 'unknown'} (city: ${propCity || 'none'}, state: ${propState || 'none'})`);
          }
          
          return matches;
        }
        
        // If we can't filter, exclude it
        return false;
      });
      
      console.log(`✅ Filtered Redfin: ${originalCount} -> ${result.data.length} (within ${radiusMiles}mi OR matching city/state)`);
    } else {
      // If no coordinates, filter by city/state STRICTLY
      console.warn('⚠️ No search coordinates - using city/state filtering (less accurate)');
      
      // Extract city and state from redfinLocation or use provided city/state
      let searchCity, searchState;
      if (city && state) {
        searchCity = city.toLowerCase();
        searchState = state.toLowerCase();
      } else {
      const locationParts = redfinLocation.split(',').map(s => s.trim());
        searchCity = locationParts[0]?.toLowerCase();
        searchState = locationParts[1]?.toLowerCase();
      }
      
      if (searchCity && searchState) {
        const originalCount = result.data.length;
        result.data = result.data.filter((property) => {
          const propCity = (property.city || '').toLowerCase();
          const propState = (property.state || '').toLowerCase();
          const propAddress = (property.address || property.full_address || '').toLowerCase();
          
          const cityMatch = propCity && (propCity === searchCity || propCity.includes(searchCity) || searchCity.includes(propCity));
          const stateMatch = propState && (propState === searchState || propState.includes(searchState) || searchState.includes(propState));
          
          // Also check address string
          const addressCityMatch = propAddress && propAddress.includes(searchCity);
          const addressStateMatch = propAddress && (propAddress.includes(`, ${searchState}`) || propAddress.includes(` ${searchState}`));
          
          const matches = (cityMatch || addressCityMatch) && (stateMatch || addressStateMatch);
          
          if (!matches) {
            console.log(`❌ Filtered out: ${property.address || property.full_address || 'unknown'} (city: ${propCity || 'none'}, state: ${propState || 'none'})`);
          }
          
          return matches;
        });
        
        console.log(`✅ Filtered Redfin by city/state: ${originalCount} -> ${result.data.length}`);
      }
    }
  }
  
  return result;
};

/**
 * Scrape Realtor.com properties using Apify
 */
export const scrapeRealtorProperties = async (searchParams) => {
  const {
    address,
    city, // Direct city from propertyData
    state, // Direct state from propertyData
    postalCode, // Direct postalCode from propertyData
    latitude,
    longitude,
    radiusMiles = 1,
    propertyType,
    soldWithinMonths = 6,
    isSold = false,
  } = searchParams;

  const REALTOR_ACTOR_ID = process.env.APIFY_REALTOR_ACTOR_ID || process.env.REALTOR_ACTOR_ID;

  if (!REALTOR_ACTOR_ID || REALTOR_ACTOR_ID === 'your-realtor-actor-id') {
    console.warn('REALTOR_ACTOR_ID not configured');
    return { success: false, data: [], message: 'Realtor actor not configured' };
  }

  console.log('Using Realtor actor:', REALTOR_ACTOR_ID);
  console.log(`🔍 Search type: ${isSold ? 'SOLD' : 'FOR SALE'}`);

  if (!address && !latitude && !longitude) {
    return { success: false, data: [], message: 'Address or coordinates required for Realtor search' };
  }

  // Build location string - prefer city, state if available
  let locationString = '';
  if (city && state) {
    locationString = `${city}, ${state}`;
    console.log(`📍 Using city, state from propertyData for Realtor: ${locationString}`);
  } else if (address) {
    locationString = address;
  } else if (latitude && longitude) {
    locationString = `${latitude},${longitude}`;
  }

  // Build input - clean up null values
  const input = {
    ...(locationString ? { location: locationString } : {}),
    radius: radiusMiles,
    ...(propertyType ? { propertyType } : {}),
    ...(isSold && soldWithinMonths ? { soldWithinMonths } : {}),
    ...(isSold !== undefined ? { isSold } : {}),
    maxResults: 50,
  };

  // Remove null/undefined values
  Object.keys(input).forEach(key => {
    if (input[key] === null || input[key] === undefined) {
      delete input[key];
    }
  });

  console.log('Realtor Apify input:', JSON.stringify(input, null, 2));
  const result = await runApifyActor(REALTOR_ACTOR_ID, input);
  console.log('Realtor Apify result:', { success: result.success, dataLength: result.data?.length || 0 });
  return result;
};

/**
 * Scrape MLS properties using Apify
 * MLS is the highest priority source (most accurate)
 * COMMENTED OUT - Not configured in env, use only Zillow/Redfin/Realtor for now
 * To enable: Uncomment this function and add APIFY_MLS_ACTOR_ID to .env
 */
/*
export const scrapeMLSProperties = async (searchParams) => {
  const {
    address,
    latitude,
    longitude,
    radiusMiles = 1,
    propertyType,
    soldWithinMonths = 6,
    isSold = false,
  } = searchParams;

  const MLS_ACTOR_ID = process.env.APIFY_MLS_ACTOR_ID || process.env.MLS_ACTOR_ID;

  if (!MLS_ACTOR_ID || MLS_ACTOR_ID === 'your-mls-actor-id') {
    console.warn('MLS_ACTOR_ID not configured - skipping MLS source');
    return { success: false, data: [], message: 'MLS actor not configured' };
  }

  console.log('Using MLS actor:', MLS_ACTOR_ID);

  if (!address && !latitude && !longitude) {
    return { success: false, data: [], message: 'Address or coordinates required for MLS search' };
  }

  // Build input for MLS scraper
  // MLS actors typically expect: location, radius, propertyType, soldWithinMonths, isSold
  const input = {
    location: address || (latitude && longitude ? `${latitude},${longitude}` : null),
    radius: radiusMiles,
    ...(propertyType ? { propertyType } : {}),
    ...(isSold && soldWithinMonths ? { soldWithinMonths } : {}),
    ...(isSold !== undefined ? { isSold } : {}),
    maxResults: 50,
  };

  // Remove null/undefined values
  Object.keys(input).forEach(key => {
    if (input[key] === null || input[key] === undefined) {
      delete input[key];
    }
  });

  console.log('MLS Apify input:', JSON.stringify(input, null, 2));
  const result = await runApifyActor(MLS_ACTOR_ID, input);
  console.log('MLS Apify result:', { success: result.success, dataLength: result.data?.length || 0 });
  return result;
};
*/

/**
 * Scrape County public records using Apify
 * County records are the lowest priority but provide official data
 * COMMENTED OUT - Not configured in env, use only Zillow/Redfin/Realtor for now
 * To enable: Uncomment this function and add APIFY_COUNTY_ACTOR_ID to .env
 */
/*
export const scrapeCountyProperties = async (searchParams) => {
  const {
    address,
    latitude,
    longitude,
    radiusMiles = 1,
    propertyType,
    soldWithinMonths = 6,
    isSold = false,
  } = searchParams;

  const COUNTY_ACTOR_ID = process.env.APIFY_COUNTY_ACTOR_ID || process.env.COUNTY_ACTOR_ID;

  if (!COUNTY_ACTOR_ID || COUNTY_ACTOR_ID === 'your-county-actor-id') {
    console.warn('COUNTY_ACTOR_ID not configured - skipping County source');
    return { success: false, data: [], message: 'County actor not configured' };
  }

  console.log('Using County actor:', COUNTY_ACTOR_ID);

  if (!address && !latitude && !longitude) {
    return { success: false, data: [], message: 'Address or coordinates required for County search' };
  }

  // Build input for County records scraper
  // County actors typically expect: address, county, state, or coordinates
  const input = {
    address: address || null,
    ...(latitude && longitude ? { latitude, longitude } : {}),
    radius: radiusMiles,
    ...(propertyType ? { propertyType } : {}),
    ...(isSold && soldWithinMonths ? { soldWithinMonths } : {}),
    maxResults: 50,
  };

  // Remove null/undefined values
  Object.keys(input).forEach(key => {
    if (input[key] === null || input[key] === undefined) {
      delete input[key];
    }
  });

  console.log('County Apify input:', JSON.stringify(input, null, 2));
  const result = await runApifyActor(COUNTY_ACTOR_ID, input);
  console.log('County Apify result:', { success: result.success, dataLength: result.data?.length || 0 });
  return result;
};
*/

/**
 * Normalize property data from the new actor format (burbn/zillow-home-scraper-by-url)
 */
const normalizeNewActorFormat = (rawData) => {
  // Build address string
  const addressParts = [];
  if (rawData.streetAddress) addressParts.push(rawData.streetAddress);
  if (rawData.city) addressParts.push(rawData.city);
  if (rawData.state) addressParts.push(rawData.state);
  if (rawData.zipcode) addressParts.push(rawData.zipcode);
  const addressStr = addressParts.join(', ');
  
  // Map homeStatus to listingStatus
  const getListingStatus = () => {
    if (!rawData.homeStatus) return 'active';
    const status = rawData.homeStatus.toLowerCase();
    if (status === 'for_sale' || status === 'for sale') return 'active';
    if (status === 'sold') return 'sold';
    if (status === 'off_market' || status === 'off market') return 'off_market';
    return status;
  };
  
  // Map homeType to propertyType
  const getPropertyType = () => {
    if (!rawData.homeType) return null;
    const type = rawData.homeType.toLowerCase();
    if (type === 'single_family' || type === 'single-family') return 'Single Family';
    if (type === 'condo' || type === 'condominium') return 'Condo';
    if (type === 'townhouse' || type === 'town_house') return 'Townhouse';
    if (type === 'multi_family' || type === 'multi-family') return 'Multi-Family';
    if (type === 'manufactured') return 'Manufactured';
    return rawData.homeType;
  };
  
  // Extract bathrooms (use bathroomsFull + bathroomsHalf)
  const getBaths = () => {
    if (rawData.bathrooms !== undefined && rawData.bathrooms !== null) {
      return parseFloat(rawData.bathrooms);
    }
    if (rawData.bathroomsFull !== undefined || rawData.bathroomsHalf !== undefined) {
      const full = rawData.bathroomsFull || 0;
      const half = rawData.bathroomsHalf || 0;
      return full + (half * 0.5);
    }
    return null;
  };
  
  const normalized = {
    dataSource: 'zillow',
    sourceId: rawData.zpid ? String(rawData.zpid) : null,
    zpid: rawData.zpid || null,
    address: addressStr,
    formattedAddress: addressStr,
    streetAddress: rawData.streetAddress || null,
    city: rawData.city || null,
    state: rawData.state || null,
    zipcode: rawData.zipcode || null,
    zipCode: rawData.zipcode || null,
    postalCode: rawData.zipcode || null,
    county: rawData.county || null,
    neighborhood: rawData.neighborhood || null,
    latitude: rawData.latitude || null,
    longitude: rawData.longitude || null,
    beds: rawData.bedrooms || null,
    bedrooms: rawData.bedrooms || null,
    baths: getBaths(),
    bathrooms: getBaths(),
    bathroomsFull: rawData.bathroomsFull || null,
    bathroomsHalf: rawData.bathroomsHalf || null,
    squareFootage: rawData.livingArea || null,
    livingArea: rawData.livingArea || null,
    lotSize: rawData.lotSize || rawData.lotAreaValue || null,
    lotAreaValue: rawData.lotAreaValue || null,
    lotAreaUnits: rawData.lotAreaUnits || null,
    yearBuilt: rawData.yearBuilt || null,
    propertyType: getPropertyType(),
    homeType: rawData.homeType || null,
    propertyCondition: rawData.propertyCondition || null,
    saleDate: null, // Not available in this format
    salePrice: null, // Not available for for-sale properties
    price: rawData.price || null,
    priceFormatted: rawData.priceFormatted || null,
    pricePerSqft: rawData.pricePerSqft || null,
    estimatedValue: rawData.zestimate || null,
    zestimate: rawData.zestimate || null,
    zestimateFormatted: rawData.zestimateFormatted || null,
    rentZestimate: rawData.rentZestimate || null,
    rentZestimateFormatted: rawData.rentZestimateFormatted || null,
    daysOnMarket: rawData.daysOnZillow || null,
    daysOnZillow: rawData.daysOnZillow || null,
    timeOnZillow: rawData.timeOnZillow || null,
    listingStatus: getListingStatus(),
    homeStatus: rawData.homeStatus || null,
    images: Array.isArray(rawData.photos) ? rawData.photos : [],
    photos: Array.isArray(rawData.photos) ? rawData.photos : [],
    photoCount: rawData.photoCount || (Array.isArray(rawData.photos) ? rawData.photos.length : 0),
    mainPhoto: rawData.mainPhoto || null,
    url: rawData.zillowUrl || null,
    propertyUrl: rawData.zillowUrl || null,
    zillowUrl: rawData.zillowUrl || null,
    // Additional rich data from new actor
    description: rawData.description || null,
    pageViewCount: rawData.pageViewCount || null,
    favoriteCount: rawData.favoriteCount || null,
    hasGarage: rawData.hasGarage || false,
    parkingCapacity: rawData.parkingCapacity || null,
    parkingFeatures: Array.isArray(rawData.parkingFeatures) ? rawData.parkingFeatures : [],
    hasCooling: rawData.hasCooling || false,
    cooling: Array.isArray(rawData.cooling) ? rawData.cooling : [],
    hasHeating: rawData.hasHeating || false,
    heating: Array.isArray(rawData.heating) ? rawData.heating : [],
    hasFireplace: rawData.hasFireplace || false,
    fireplaces: rawData.fireplaces || null,
    fireplaceFeatures: Array.isArray(rawData.fireplaceFeatures) ? rawData.fireplaceFeatures : [],
    flooring: Array.isArray(rawData.flooring) ? rawData.flooring : [],
    appliances: Array.isArray(rawData.appliances) ? rawData.appliances : [],
    interiorFeatures: Array.isArray(rawData.interiorFeatures) ? rawData.interiorFeatures : [],
    exteriorFeatures: Array.isArray(rawData.exteriorFeatures) ? rawData.exteriorFeatures : [],
    roofType: rawData.roofType || null,
    sewer: Array.isArray(rawData.sewer) ? rawData.sewer : [],
    waterSource: Array.isArray(rawData.waterSource) ? rawData.waterSource : [],
    utilities: Array.isArray(rawData.utilities) ? rawData.utilities : [],
    poolFeatures: Array.isArray(rawData.poolFeatures) ? rawData.poolFeatures : [],
    hasPool: rawData.hasPool || false,
    hasSpa: rawData.hasSpa || false,
    taxAnnualAmount: rawData.taxAnnualAmount || null,
    taxAssessedValue: rawData.taxAssessedValue || null,
    propertyTaxRate: rawData.propertyTaxRate || null,
    hoaFee: rawData.hoaFee || null,
    hasAssociation: rawData.hasAssociation || false,
    isNewConstruction: rawData.isNewConstruction || false,
    isBankOwned: rawData.isBankOwned || false,
    isForeclosure: rawData.isForeclosure || false,
    mlsId: rawData.mlsId || null,
    parcelNumber: rawData.parcelNumber || null,
    architecturalStyle: rawData.architecturalStyle || null,
    stories: rawData.stories || null,
    levels: rawData.levels || null,
    livingAreaUnits: rawData.livingAreaUnits || null,
    schools: Array.isArray(rawData.schools) ? rawData.schools : [],
    priceHistory: Array.isArray(rawData.priceHistory) ? rawData.priceHistory : [],
    taxHistory: Array.isArray(rawData.taxHistory) ? rawData.taxHistory : [],
    // Keep raw data for reference
    rawData,
  };
  
  console.log(`✅ Normalized new actor format property:`, {
    address: normalized.address,
    price: normalized.price,
    beds: normalized.beds,
    baths: normalized.baths,
    sqft: normalized.squareFootage,
    imagesCount: normalized.images?.length || 0,
  });
  
  return normalized;
};

/**
 * Normalize property data from different sources into a common format
 */
export const normalizePropertyData = (rawData, source) => {
  // Log raw data to understand format
  if (!rawData || typeof rawData !== 'object') {
    console.warn(`Invalid rawData from ${source}:`, rawData);
    return null;
  }

  // Some actors (e.g. Zillow Sold) return items wrapped as { property: {...} } or { data: {...} }; unwrap so we read price/address etc.
  if ((source === 'zillow-sold' || source === 'zillow') && !rawData.price && !rawData.address) {
    if (rawData.property && typeof rawData.property === 'object' && (rawData.property.price || rawData.property.zpid || rawData.property.address)) {
      rawData = rawData.property;
    } else if (rawData.data && typeof rawData.data === 'object' && (rawData.data.price || rawData.data.zpid || rawData.data.address)) {
      rawData = rawData.data;
    }
  }

  // Check if this is the new actor format (burbn/zillow-home-scraper-by-url)
  const isNewActorFormat = rawData.zpid !== undefined && rawData.zillowUrl !== undefined && rawData.photos !== undefined;
  
  if (isNewActorFormat) {
    console.log(`📋 Detected new actor format (burbn/zillow-home-scraper-by-url)`);
    return normalizeNewActorFormat(rawData);
  }
  
  // Log key fields from Zillow structure for debugging
  if (source === 'zillow') {
    console.log(`📋 Zillow raw data structure:`, {
      hasPrice: !!rawData.price,
      priceType: typeof rawData.price,
      priceValue: rawData.price?.value,
      hasListing: !!rawData.listing,
      listingStatus: rawData.listing?.listingStatus || rawData.listingStatus,
      hasMedia: !!rawData.media,
      hasPropertyPhotoLinks: !!rawData.media?.propertyPhotoLinks,
      photoLinksKeys: rawData.media?.propertyPhotoLinks ? Object.keys(rawData.media.propertyPhotoLinks) : [],
      hasAddress: !!rawData.address,
      addressStreet: rawData.address?.streetAddress,
      hasLocation: !!rawData.location,
      locationLat: rawData.location?.latitude,
      locationLng: rawData.location?.longitude,
    });
  }

  // Try to extract address from various formats
  const getAddress = () => {
    // Handle address as object (Zillow format)
    if (rawData.address && typeof rawData.address === 'object') {
      const addr = rawData.address;
      const parts = [];
      if (addr.streetAddress) parts.push(addr.streetAddress);
      if (addr.city) parts.push(addr.city);
      if (addr.state) parts.push(addr.state);
      if (addr.zipcode || addr.zipCode || addr.postalCode) {
        parts.push(addr.zipcode || addr.zipCode || addr.postalCode);
      }
      if (parts.length > 0) {
        return parts.join(', ');
      }
    }
    
    // Handle address as string
    if (rawData.address && typeof rawData.address === 'string') {
      return rawData.address;
    }
    
    if (rawData.streetAddress) return rawData.streetAddress;
    if (rawData.fullAddress) return rawData.fullAddress;
    if (rawData.formattedAddress) return rawData.formattedAddress;
    
    // Try building from components
    if (rawData.street && rawData.city) {
      return `${rawData.street}, ${rawData.city}, ${rawData.state || ''} ${rawData.zipCode || rawData.postalCode || ''}`.trim();
    }
    
    // Try building from address object components if they exist at root level
    if (rawData.streetAddress && rawData.city) {
      const parts = [rawData.streetAddress, rawData.city];
      if (rawData.state) parts.push(rawData.state);
      if (rawData.zipcode || rawData.zipCode || rawData.postalCode) {
        parts.push(rawData.zipcode || rawData.zipCode || rawData.postalCode);
      }
      return parts.join(', ');
    }
    
    return '';
  };

  // Try to extract price from various fields
  // For FOR_SALE: price = current list price (what we show as "listed price")
  // For SOLD: price = sale price
  const getPrice = () => {
    const homeStatus = (rawData.homeStatus || rawData.listing?.listingStatus || rawData.listingStatus || rawData.status || '').toString().toUpperCase();
    const isForSale = homeStatus === 'FOR_SALE' || homeStatus === 'FOR SALE' || (homeStatus && !homeStatus.includes('SOLD'));

    // For FOR_SALE properties, prefer current listing price (do not use lastSoldPrice as the displayed price)
    if (isForSale) {
      // Nested price object (Zillow: price.value)
      if (rawData.price && typeof rawData.price === 'object') {
        if (rawData.price.value != null) return parseFloat(rawData.price.value) || null;
        if (rawData.price.amount != null) return parseFloat(rawData.price.amount) || null;
        if (rawData.price.price != null) return parseFloat(rawData.price.price) || null;
      }
      // Direct listing price (number) - e.g. Zillow detail API returns price: 315000
      if (rawData.price != null && typeof rawData.price === 'number') {
        return parseFloat(rawData.price) || null;
      }
      if (rawData.listPrice != null) return parseFloat(rawData.listPrice) || null;
      if (rawData.askingPrice != null) return parseFloat(rawData.askingPrice) || null;
    }

    // For SOLD or when not for sale: check nested price object
    if (rawData.price && typeof rawData.price === 'object') {
      if (rawData.price.value != null) return parseFloat(rawData.price.value) || null;
      if (rawData.price.amount != null) return parseFloat(rawData.price.amount) || null;
      if (rawData.price.price != null) return parseFloat(rawData.price.price) || null;
    }

    // Fallbacks: sale price or last sold (when no listing price)
    if (rawData.salePrice != null) {
      if (typeof rawData.salePrice === 'object' && rawData.salePrice.value != null) {
        return parseFloat(rawData.salePrice.value) || null;
      }
      return parseFloat(rawData.salePrice) || null;
    }
    if (rawData.listPrice != null) return parseFloat(rawData.listPrice) || null;
    if (rawData.askingPrice != null) return parseFloat(rawData.askingPrice) || null;
    if (rawData.lastSoldPrice != null) return parseFloat(rawData.lastSoldPrice) || null;

    // Direct price number (when status was not clearly for-sale)
    if (rawData.price != null && typeof rawData.price === 'number') {
      return parseFloat(rawData.price) || null;
    }

    return null;
  };
  
  // Try to extract sale price separately (for sold properties)
  const getSalePrice = () => {
    // Zillow Sold actor: listing.listingStatus = "recentlySold", price.value = sale price, hdpView.price = sale price
    const listingStatus = (rawData.listing?.listingStatus || rawData.listingStatus || rawData.status || '').toLowerCase();
    const marketingStatus = (rawData.listing?.marketingStatus || '').toLowerCase();
    const isSold = listingStatus === 'sold' || listingStatus.includes('sold') || marketingStatus === 'closed';

    // For SOLD properties, price.value is the sale price
    if (rawData.price && typeof rawData.price === 'object') {
      if (isSold || rawData.price.value != null) {
        if (rawData.price.value != null) return parseFloat(rawData.price.value) || null;
        if (rawData.price.amount != null) return parseFloat(rawData.price.amount) || null;
      }
    }

    // Zillow Sold actor: hdpView.price is the sale amount (number)
    if (isSold && rawData.hdpView && rawData.hdpView.price != null) {
      return parseFloat(rawData.hdpView.price) || null;
    }

    // Check direct sale price fields
    if (rawData.salePrice) {
      // Handle nested salePrice.value structure
      if (typeof rawData.salePrice === 'object' && rawData.salePrice.value) {
        return parseFloat(rawData.salePrice.value) || null;
      }
      return parseFloat(rawData.salePrice) || null;
    }
    if (rawData.lastSoldPrice) return parseFloat(rawData.lastSoldPrice) || null;
    if (rawData.soldPrice) return parseFloat(rawData.soldPrice) || null;
    if (rawData.closingPrice) return parseFloat(rawData.closingPrice) || null;

    // Last resort for sold comps: use root price when status isn't clearly for-sale (sold actors may only expose price)
    if (listingStatus !== 'for_sale' && listingStatus !== 'active' && marketingStatus !== 'for_sale' && rawData.price != null) {
      if (typeof rawData.price === 'object' && rawData.price.value != null) return parseFloat(rawData.price.value) || null;
      if (typeof rawData.price === 'number') return parseFloat(rawData.price) || null;
    }
    return null;
  };
  
  // Try to extract sale date
  // Check nested structures (Zillow format: listing.dateSold or similar)
  const getSaleDate = () => {
    // Check nested listing object (Zillow format)
    if (rawData.listing && rawData.listing.dateSold) {
      const date = new Date(rawData.listing.dateSold);
      if (!isNaN(date.getTime())) return date;
    }
    if (rawData.listing && rawData.listing.saleDate) {
      const date = new Date(rawData.listing.saleDate);
      if (!isNaN(date.getTime())) return date;
    }
    if (rawData.listing && rawData.listing.closingDate) {
      const date = new Date(rawData.listing.closingDate);
      if (!isNaN(date.getTime())) return date;
    }
    
    // Check root level fields
    if (rawData.saleDate) {
      const date = new Date(rawData.saleDate);
      return isNaN(date.getTime()) ? null : date;
    }
    if (rawData.dateSold) {
      const date = new Date(rawData.dateSold);
      return isNaN(date.getTime()) ? null : date;
    }
    if (rawData.lastSoldDate) {
      const date = new Date(rawData.lastSoldDate);
      return isNaN(date.getTime()) ? null : date;
    }
    if (rawData.closingDate) {
      const date = new Date(rawData.closingDate);
      return isNaN(date.getTime()) ? null : date;
    }
    return null;
  };

  // Try to extract coordinates
  const getLat = () => {
    if (rawData.latitude) return parseFloat(rawData.latitude);
    if (rawData.lat) return parseFloat(rawData.lat);
    if (rawData.coordinates?.lat) return parseFloat(rawData.coordinates.lat);
    if (rawData.location?.latitude) return parseFloat(rawData.location.latitude); // Zillow format: location.latitude
    if (rawData.location?.lat) return parseFloat(rawData.location.lat);
    return null;
  };

  const getLng = () => {
    if (rawData.longitude) return parseFloat(rawData.longitude);
    if (rawData.lng) return parseFloat(rawData.lng);
    if (rawData.coordinates?.lng) return parseFloat(rawData.coordinates.lng);
    if (rawData.location?.longitude) return parseFloat(rawData.location.longitude); // Zillow format: location.longitude
    if (rawData.location?.lng) return parseFloat(rawData.location.lng);
    return null;
  };

  const addressStr = getAddress();
  
  // Try to extract estimated value (Zestimate or similar)
  const getEstimatedValue = () => {
    if (rawData.estimates && rawData.estimates.zestimate != null) return parseFloat(rawData.estimates.zestimate) || null;
    if (rawData.zestimate) return parseFloat(rawData.zestimate) || null;
    if (rawData.estimatedValue) return parseFloat(rawData.estimatedValue) || null;
    if (rawData.priceEstimate) return parseFloat(rawData.priceEstimate) || null;
    if (rawData.valuation) return parseFloat(rawData.valuation) || null;
    // Zillow format: zestimate might be in an object
    if (rawData.zestimate && typeof rawData.zestimate === 'object' && rawData.zestimate.amount) {
      return parseFloat(rawData.zestimate.amount) || null;
    }
    return null;
  };

  // Extract listing status (handle nested structure; "recentlySold" / "closed" from sold actor = sold)
  const getListingStatus = () => {
    // Check nested listing object (Zillow format: listing.listingStatus, sold actor: recentlySold; marketingStatus: closed)
    if (rawData.listing && rawData.listing.listingStatus) {
      const s = rawData.listing.listingStatus.toLowerCase();
      if (s === 'recentlysold') return 'sold';
      return s;
    }
    if (rawData.listing && rawData.listing.marketingStatus) {
      const m = rawData.listing.marketingStatus.toLowerCase();
      if (m === 'closed') return 'sold';
    }
    // Check root level
    if (rawData.listingStatus) return rawData.listingStatus.toLowerCase();
    if (rawData.listing_status) return rawData.listing_status.toLowerCase();
    if (rawData.status) return rawData.status.toLowerCase();
    if (rawData.listingType) return rawData.listingType.toLowerCase();
    return 'active';
  };

  // Extract property URL (for fetching full details later)
  const getPropertyUrl = () => {
    // Check various URL fields
    if (rawData.url) return rawData.url;
    if (rawData.propertyUrl) return rawData.propertyUrl;
    if (rawData.property_url) return rawData.property_url;
    if (rawData.zillowUrl) return rawData.zillowUrl;
    if (rawData.zillow_url) return rawData.zillow_url;
    if (rawData.listingUrl) return rawData.listingUrl;
    if (rawData.listing_url) return rawData.listing_url;
    if (rawData.sourceUrl) return rawData.sourceUrl;
    if (rawData.source_url) return rawData.source_url;
    // Build URL from ZPID if available (Zillow format)
    if (rawData.zpid || rawData.id) {
      const zpid = String(rawData.zpid || rawData.id).trim();
      if (source === 'zillow' && zpid) {
        return `https://www.zillow.com/homedetails/${zpid}_zpid/`;
      }
    }
    return null;
  };

  const extractedPrice = getPrice();
  const extractedSalePrice = getSalePrice();
  const extractedImages = extractImages(rawData, source);
  const extractedUrl = getPropertyUrl();

  const normalized = {
    dataSource: source,
    sourceId: rawData.id || rawData.zpid || rawData.listingId || rawData.mlsNumber || null,
    address: addressStr, // Always a string
    formattedAddress: rawData.formattedAddress || rawData.fullAddress || addressStr || '',
    latitude: getLat(),
    longitude: getLng(),
    beds: rawData.beds ? parseInt(rawData.beds) : (rawData.bedrooms ? parseInt(rawData.bedrooms) : (rawData.bed ? parseInt(rawData.bed) : null)),
    baths: rawData.baths ? parseFloat(rawData.baths) : (rawData.bathrooms ? parseFloat(rawData.bathrooms) : (rawData.bath ? parseFloat(rawData.bath) : null)),
    squareFootage: rawData.squareFootage ? parseInt(rawData.squareFootage) : (rawData.sqft ? parseInt(rawData.sqft) : (rawData.livingArea ? parseInt(rawData.livingArea) : (rawData.squareFeet ? parseInt(rawData.squareFeet) : null))),
    lotSize: rawData.lotSize ? parseInt(rawData.lotSize) : (rawData.lotArea ? parseInt(rawData.lotArea) : (rawData.lotSquareFeet ? parseInt(rawData.lotSquareFeet) : (rawData.lotSizeWithUnit?.lotSize != null && rawData.lotSizeWithUnit?.lotSizeUnit === 'acres' ? Math.round(rawData.lotSizeWithUnit.lotSize * 43560) : null))),
    yearBuilt: rawData.yearBuilt ? parseInt(rawData.yearBuilt) : (rawData.year ? parseInt(rawData.year) : null),
    propertyType: rawData.propertyType || rawData.homeType || rawData.type || rawData.propertyTypeName || null,
    saleDate: getSaleDate(),
    salePrice: extractedSalePrice, // Use dedicated salePrice extractor
    price: extractedPrice, // Current/listing price (different from salePrice for sold properties)
    estimatedValue: getEstimatedValue(), // Zestimate or estimated value
    daysOnMarket: rawData.daysOnMarket ? parseInt(rawData.daysOnMarket) : (rawData.dom ? parseInt(rawData.dom) : null),
    listingStatus: getListingStatus(),
    images: extractedImages,
    url: extractedUrl, // Property URL for fetching full details
    propertyUrl: extractedUrl, // Alias for compatibility
    rawData,
  };
  
  // Log extracted values for debugging (especially for Zillow)
  if (source === 'zillow') {
    console.log(`✅ Normalized Zillow property:`, {
      address: normalized.address,
      price: normalized.price,
      salePrice: normalized.salePrice,
      listingStatus: normalized.listingStatus,
      imagesCount: normalized.images?.length || 0,
      beds: normalized.beds,
      baths: normalized.baths,
      sqft: normalized.squareFootage,
    });
  }

  // Log if no images found
  if (!normalized.images || normalized.images.length === 0) {
    const imageFields = Object.keys(rawData).filter(k => 
      k.toLowerCase().includes('image') || 
      k.toLowerCase().includes('photo') ||
      k.toLowerCase().includes('media')
    );
    console.warn(`⚠️ Property from ${source} has no images. Available image-related fields:`, imageFields);
    if (rawData.media) {
      console.warn(`   Media object keys:`, Object.keys(rawData.media));
    }
  }

  return normalized;
};

/**
 * Extract images from property data (handles different formats from different sources)
 */
const extractImages = (rawData, source) => {
  const images = [];

  // Zillow format: prefer media.allPropertyPhotos first (full gallery) so we don't get only 1 image
  if (rawData.media) {
    // Zillow Sold actor (igolaizola): media.allPropertyPhotos.highResolution is array of all photo URLs
    if (rawData.media.allPropertyPhotos && rawData.media.allPropertyPhotos.highResolution && Array.isArray(rawData.media.allPropertyPhotos.highResolution)) {
      images.push(...rawData.media.allPropertyPhotos.highResolution.filter(url => typeof url === 'string' && url.startsWith('http')));
    }
    // Zillow photos array (actual property photos) - check multiple possible structures
    if (Array.isArray(rawData.media.photos)) {
      rawData.media.photos.forEach(photo => {
        if (typeof photo === 'string') {
          images.push(photo);
        } else if (photo && typeof photo === 'object') {
          // Check all possible URL fields in photo object
          if (photo.url) images.push(photo.url);
          if (photo.imageUrl) images.push(photo.imageUrl);
          if (photo.src) images.push(photo.src);
          if (photo.link) images.push(photo.link);
          if (photo.href) images.push(photo.href);
          // Some actors return nested objects with url property
          if (photo.original && photo.original.url) images.push(photo.original.url);
          if (photo.thumbnail && photo.thumbnail.url) images.push(photo.thumbnail.url);
        }
      });
    }
    
    // Zillow images array - check for nested structures
    if (Array.isArray(rawData.media.images)) {
      rawData.media.images.forEach(img => {
        if (typeof img === 'string') {
          images.push(img);
        } else if (img && typeof img === 'object') {
          if (img.url) images.push(img.url);
          if (img.imageUrl) images.push(img.imageUrl);
          if (img.src) images.push(img.src);
          if (img.link) images.push(img.link);
          if (img.href) images.push(img.href);
        }
      });
    }
    
    // Zillow photoUrls array
    if (Array.isArray(rawData.media.photoUrls)) {
      images.push(...rawData.media.photoUrls.filter(url => typeof url === 'string'));
    }
    
    // Zillow propertyPhotoLinks object - check all possible link fields
    // This is the main source of images for Zillow listings
    // NOTE: Each property may have multiple images, but propertyPhotoLinks might only contain one link per property
    // We need to check if there's an array of propertyPhotoLinks or if each property has multiple links
    if (rawData.media.propertyPhotoLinks && typeof rawData.media.propertyPhotoLinks === 'object') {
      const photoLinks = rawData.media.propertyPhotoLinks;
      
      // Check if propertyPhotoLinks is an array (multiple images)
      if (Array.isArray(photoLinks)) {
        photoLinks.forEach(linkObj => {
          if (linkObj && typeof linkObj === 'object') {
            // Extract all URL fields from each link object
            Object.keys(linkObj).forEach(key => {
              const link = linkObj[key];
              if (typeof link === 'string' && 
                  !link.includes('maps.googleapis.com') && 
                  !link.includes('streetview') &&
                  !link.includes('googleapis.com') &&
                  link.startsWith('http')) {
                images.push(link);
              }
            });
          } else if (typeof linkObj === 'string') {
            images.push(linkObj);
          }
        });
      } else {
        // propertyPhotoLinks is an object with multiple link fields
        // Extract all links from the propertyPhotoLinks object
        // Common fields: highResolutionLink, mediumResolutionLink, lowResolutionLink, thumbnailLink, etc.
      Object.keys(photoLinks).forEach(key => {
        const link = photoLinks[key];
          
          // Handle string URLs
        if (typeof link === 'string' && 
            !link.includes('maps.googleapis.com') && 
            !link.includes('streetview') &&
              !link.includes('googleapis.com') &&
            link.startsWith('http')) {
          images.push(link);
          } 
          // Handle nested objects with URL properties
          else if (link && typeof link === 'object') {
            if (link.url) images.push(link.url);
            if (link.href) images.push(link.href);
            if (link.src) images.push(link.src);
            if (link.link) images.push(link.link);
          }
        });
      }
    }
    
    // Check if there's a separate array of all photo links (some actors structure it this way)
    if (rawData.media.allPropertyPhotoLinks && Array.isArray(rawData.media.allPropertyPhotoLinks)) {
      rawData.media.allPropertyPhotoLinks.forEach(photoLinkObj => {
        if (photoLinkObj && typeof photoLinkObj === 'object') {
          // Check for highResolutionLink in each photo object
          if (photoLinkObj.highResolutionLink) images.push(photoLinkObj.highResolutionLink);
          if (photoLinkObj.url) images.push(photoLinkObj.url);
          if (photoLinkObj.href) images.push(photoLinkObj.href);
        } else if (typeof photoLinkObj === 'string') {
          images.push(photoLinkObj);
        }
      });
    }
    
    // Check for other media sub-properties that might contain images
    if (rawData.media.allPhotos && Array.isArray(rawData.media.allPhotos)) {
      rawData.media.allPhotos.forEach(photo => {
        if (typeof photo === 'string') {
          images.push(photo);
        } else if (photo && photo.url) {
          images.push(photo.url);
        }
      });
    }
    
    // Check for media.gallery or media.galleryImages
    if (rawData.media.gallery && Array.isArray(rawData.media.gallery)) {
      rawData.media.gallery.forEach(item => {
        if (typeof item === 'string') {
          images.push(item);
        } else if (item && item.url) {
          images.push(item.url);
        }
      });
    }
    
    if (rawData.media.galleryImages && Array.isArray(rawData.media.galleryImages)) {
      rawData.media.galleryImages.forEach(item => {
        if (typeof item === 'string') {
          images.push(item);
        } else if (item && item.url) {
          images.push(item.url);
        }
      });
    }
  }
  
  // Zillow direct photo fields
  if (rawData.photos && Array.isArray(rawData.photos)) {
    rawData.photos.forEach(photo => {
      if (typeof photo === 'string') {
        images.push(photo);
      } else if (photo && photo.url) {
        images.push(photo.url);
      } else if (photo && photo.imageUrl) {
        images.push(photo.imageUrl);
      }
    });
  }
  
  if (rawData.photoUrls && Array.isArray(rawData.photoUrls)) {
    images.push(...rawData.photoUrls);
  }
  
  // Standard formats
  if (Array.isArray(rawData.images)) {
    images.push(...rawData.images);
  }
  
  if (Array.isArray(rawData.photos)) {
    images.push(...rawData.photos);
  }
  
  if (Array.isArray(rawData.imageUrls)) {
    images.push(...rawData.imageUrls);
  }
  
  if (Array.isArray(rawData.photoUrls)) {
    images.push(...rawData.photoUrls);
  }
  
  // Single image fields
  if (rawData.image_url && typeof rawData.image_url === 'string') {
    images.push(rawData.image_url);
  }
  
  if (rawData.imageUrl && typeof rawData.imageUrl === 'string') {
    images.push(rawData.imageUrl);
  }
  
  if (rawData.photo_url && typeof rawData.photo_url === 'string') {
    images.push(rawData.photo_url);
  }
  
  // Redfin format
  if (rawData.image_url && typeof rawData.image_url === 'string') {
    images.push(rawData.image_url);
  }
  
  // Log what we found for debugging
  if (source === 'zillow' && images.length > 0) {
    console.log(`🖼️ extractImages found ${images.length} images from Zillow property`);
  }
  
  // Remove duplicates and filter out invalid URLs
  const uniqueImages = [];
  const seen = new Set();
  
  for (const img of images) {
    if (!img || typeof img !== 'string') continue;
    
    // Filter out Google Maps static map URLs (not property photos)
    if (img.includes('maps.googleapis.com/maps/api/staticmap')) {
      continue;
    }
    
    // Filter out street view URLs (not property photos)
    if (img.includes('maps.googleapis.com/maps/api/streetview')) {
      continue;
    }
    
    // Normalize URL for deduplication
    const normalized = img.trim();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      uniqueImages.push(normalized);
    }
  }
  
  if (uniqueImages.length > 0) {
    console.log(`📸 Extracted ${uniqueImages.length} images from ${source} property`);
  }
  
  return uniqueImages;
};

/**
 * Fetch full property details from Zillow using property URL with the new Apify actor
 * This uses the burbn/zillow-home-scraper-by-url actor which accepts direct property URLs
 * Exported for use in controllers
 */
export const fetchZillowPropertyDetailsByUrl = async (propertyUrl) => {
  const PROPERTY_DETAIL_ACTOR_ID = process.env.APIFY_PROPERTY_DETAIL_ACTOR_ID || 'burbn/zillow-home-scraper-by-url';
  
  if (!propertyUrl) {
    console.warn('No property URL provided for detail fetch');
    return null;
  }
  
  // Validate URL format
  if (!propertyUrl.startsWith('http://') && !propertyUrl.startsWith('https://')) {
    console.warn(`Invalid property URL format: ${propertyUrl}`);
    return null;
  }
  
  try {
    console.log(`🔍 Fetching property details from URL: ${propertyUrl}`);
    console.log(`📋 Using actor: ${PROPERTY_DETAIL_ACTOR_ID}`);
    
    // Extract ZPID from URL if available for verification
    const zpidMatch = propertyUrl.match(/\/(\d+)_zpid/);
    const expectedZpid = zpidMatch ? zpidMatch[1] : null;
    
    // Build input for the new actor - it expects propertyUrls (plural) as per actor documentation
    const input = {
      propertyUrls: [propertyUrl], // Array of property URLs - actor expects this field name
    };
    
    console.log(`📤 Apify input for property details by URL:`, JSON.stringify(input, null, 2));
    if (expectedZpid) {
      console.log(`🔍 Expected ZPID from URL: ${expectedZpid}`);
    }
    
    const result = await runApifyActor(PROPERTY_DETAIL_ACTOR_ID, input);
    
    console.log(`📥 Apify result for property details by URL:`, {
      success: result.success,
      dataLength: result.data?.length || 0,
      error: result.error || 'none',
      runId: result.runId,
    });
    
    if (!result.success) {
      console.error(`❌ Apify actor failed: ${result.error || result.message}`);
      if (result.runId) {
        console.error(`🔗 Check run status: https://console.apify.com/actors/runs/${result.runId}`);
      }
      return null;
    }
    
    if (result.data && result.data.length > 0) {
      // Find the property that matches our URL/ZPID
      let property = null;
      
      if (expectedZpid) {
        // Try to find property with matching ZPID
        property = result.data.find(p => {
          const propZpid = String(p.zpid || p.id || '');
          return propZpid === String(expectedZpid);
        });
        
        if (property) {
          console.log(`✅ Found property matching ZPID ${expectedZpid}`);
        } else {
          console.warn(`⚠️ No property found matching ZPID ${expectedZpid}, checking by URL...`);
          // Try to match by URL
          property = result.data.find(p => {
            const propUrl = p.zillowUrl || p.url || p.propertyUrl || '';
            return propUrl === propertyUrl || propUrl.includes(expectedZpid);
          });
          
          if (property) {
            console.log(`✅ Found property matching URL`);
          } else {
            console.warn(`⚠️ No property found matching URL, using first result`);
            property = result.data[0];
          }
        }
      } else {
        // No ZPID to match, try to match by URL
        property = result.data.find(p => {
          const propUrl = p.zillowUrl || p.url || p.propertyUrl || '';
          return propUrl === propertyUrl;
        });
        
        if (!property) {
          console.warn(`⚠️ No property found matching URL, using first result`);
          property = result.data[0];
        }
      }
      
      if (!property) {
        console.error(`❌ No property data found in results`);
        return null;
      }
      
      console.log(`📦 Selected property data keys:`, Object.keys(property));
      console.log(`📦 Property ZPID: ${property.zpid || 'N/A'}`);
      console.log(`📦 Property URL: ${property.zillowUrl || property.url || 'N/A'}`);
      console.log(`📦 Property address: ${property.address || property.streetAddress || property.formattedAddress || 'N/A'}`);
      
      // Verify we got the right property
      if (expectedZpid && String(property.zpid || property.id || '') !== String(expectedZpid)) {
        console.error(`❌ WARNING: Property ZPID mismatch! Expected: ${expectedZpid}, Got: ${property.zpid || property.id || 'N/A'}`);
        console.error(`❌ This might be the wrong property. Check the actor input format.`);
      }
      
      // Check if this is the new actor format
      const isNewActorFormat = property.zpid !== undefined && property.zillowUrl !== undefined && property.photos !== undefined;
      
      let normalizedProperty;
      let images;
      
      if (isNewActorFormat) {
        // Use the new normalization function for new actor format
        normalizedProperty = normalizeNewActorFormat(property);
        images = normalizedProperty.images || [];
        console.log(`✅ Normalized new actor format property with ${images.length} images`);
      } else {
        // Use existing normalization for legacy format
        normalizedProperty = normalizePropertyData(property, 'zillow');
        images = extractImages(property, 'zillow');
        console.log(`✅ Normalized legacy format property with ${images.length} images`);
      }
      
      if (!normalizedProperty) {
        console.error(`❌ Failed to normalize property data`);
        return null;
      }
      
      // Ensure images are set
      normalizedProperty.images = images;
      
      console.log(`✅ Fetched ${images.length} images from property detail page`);
      if (images.length > 0) {
        console.log(`📸 First few image URLs:`, images.slice(0, 3));
      } else {
        console.warn(`⚠️ No images extracted from property detail page`);
      }
      
      return {
        images,
        property: normalizedProperty,
      };
    } else {
      console.warn(`⚠️ Apify actor returned no data for property URL: ${propertyUrl}`);
      return null;
    }
  } catch (error) {
    console.error('❌ Error fetching Zillow property details by URL:', error.message);
    console.error('❌ Error stack:', error.stack);
    return null;
  }
};

/**
 * Fetch full property details from Zillow using property URL or ZPID
 * This is used to get all images when the search result only returns one image
 * Exported for use in controllers
 * DEPRECATED: Use fetchZillowPropertyDetailsByUrl when URL is available
 */
export const fetchZillowPropertyDetails = async (propertyUrl, zpid, propertyAddress = null) => {
  // IMPORTANT: Read directly from process.env to get the latest value
  // NOTE: If you changed the .env file, you MUST restart the server for changes to take effect
  const ZILLOW_ACTOR_ID = process.env.APIFY_ZILLOW_ACTOR_ID || process.env.ZILLOW_ACTOR_ID;
  
  if (!ZILLOW_ACTOR_ID || ZILLOW_ACTOR_ID === 'your-zillow-actor-id') {
    console.warn('ZILLOW_ACTOR_ID not configured for property detail fetch');
    return null;
  }
  
  console.log('🔍 Using Zillow actor for detail fetch:', ZILLOW_ACTOR_ID);
  
  try {
    // Build property detail URL if we have ZPID but no URL
    let detailUrl = propertyUrl;
    if (!detailUrl && zpid) {
      // Ensure zpid is a string
      const zpidStr = String(zpid).trim();
      detailUrl = `https://www.zillow.com/homedetails/${zpidStr}_zpid/`;
    }
    
    if (!detailUrl) {
      console.warn('No property URL or ZPID provided for detail fetch');
      return null;
    }
    
    console.log(`🔍 Fetching property details from: ${detailUrl}`);
    console.log(`📋 Using ZPID: ${zpid || 'N/A'}`);
    
    // Use Apify actor to fetch individual property details
    // Based on the actor form, it uses "Location" field which accepts addresses, not URLs
    // If we have an address, use it. Otherwise, try the URL.
    // The actor form shows "Location" accepts addresses like "New York" or full addresses
    const input = {
      // Try using address in Location field if available (preferred)
      // Otherwise use the property URL
      Location: propertyAddress || detailUrl,
      // Also try lowercase location
      location: propertyAddress || detailUrl,
      // Some actors also accept searchUrls (for property URLs)
      searchUrls: [detailUrl],
      // Set maxResults to ensure we get the property
      maxResults: 50, // Increase to get more results, then filter by ZPID
      // Try to get all images (these parameters might not be supported, but won't hurt)
      includeAllImages: true,
      includePhotos: true,
      getFullDetails: true,
    };
    
    // Add ZPID if available (some actors might use this)
    if (zpid) {
      input.zpid = String(zpid);
    }
    
    console.log(`📋 Using Location: "${input.Location}" (${propertyAddress ? 'address' : 'URL'})`);
    
    // Remove null/undefined values
    Object.keys(input).forEach(key => {
      if (input[key] === null || input[key] === undefined) {
        delete input[key];
      }
    });
    
    console.log(`📤 Apify input for property details:`, JSON.stringify(input, null, 2));
    
    const result = await runApifyActor(ZILLOW_ACTOR_ID, input);
    
    console.log(`📥 Apify result for property details:`, {
      success: result.success,
      dataLength: result.data?.length || 0,
      error: result.error || 'none',
      runId: result.runId,
    });
    
    if (!result.success) {
      console.error(`❌ Apify actor failed: ${result.error || result.message}`);
      if (result.runId) {
        console.error(`🔗 Check run status: https://console.apify.com/actors/runs/${result.runId}`);
      }
      return null;
    }
    
    if (result.data && result.data.length > 0) {
      // Filter results to find the property matching our ZPID if we have one
      let property = result.data[0];
      
      if (zpid) {
        // Try to find property with matching ZPID
        const matchingProperty = result.data.find(p => 
          String(p.zpid || p.id || p.sourceId) === String(zpid)
        );
        if (matchingProperty) {
          property = matchingProperty;
          console.log(`✅ Found property matching ZPID ${zpid}`);
        } else {
          console.log(`⚠️ No property found matching ZPID ${zpid}, using first result`);
          // Log all ZPIDs in results for debugging
          const zpids = result.data.map(p => p.zpid || p.id || p.sourceId).filter(Boolean);
          console.log(`📋 Available ZPIDs in results:`, zpids);
        }
      }
      
      console.log(`📦 Property data keys:`, Object.keys(property));
      console.log(`📦 Property ZPID: ${property.zpid || property.id || 'N/A'}`);
      console.log(`📦 Property address: ${property.address || property.formattedAddress || 'N/A'}`);
      console.log(`📦 Has media: ${!!property.media}`);
      if (property.media) {
        console.log(`📦 Media keys:`, Object.keys(property.media));
        // Log propertyPhotoLinks structure
        if (property.media.propertyPhotoLinks) {
          console.log(`📦 propertyPhotoLinks keys:`, Object.keys(property.media.propertyPhotoLinks));
          console.log(`📦 propertyPhotoLinks.highResolutionLink:`, property.media.propertyPhotoLinks.highResolutionLink);
          // Log ALL links in propertyPhotoLinks
          const allLinks = Object.entries(property.media.propertyPhotoLinks)
            .filter(([key, value]) => typeof value === 'string' && value.startsWith('http'))
            .map(([key, value]) => ({ key, url: value }));
          console.log(`📦 All links in propertyPhotoLinks:`, allLinks);
        }
      }
      
      // extractImages is now defined above, so we can use it
      const images = extractImages(property, 'zillow');
      
      console.log(`✅ Fetched ${images.length} images from property detail page`);
      if (images.length > 0) {
        console.log(`📸 First few image URLs:`, images.slice(0, 3));
      } else {
        console.warn(`⚠️ No images extracted. Property media structure:`, property.media);
        // Log full media object for debugging
        if (property.media) {
          console.warn(`⚠️ Full media object:`, JSON.stringify(property.media, null, 2));
        }
      }
      
      return {
        images,
        property,
      };
    } else {
      console.warn(`⚠️ Apify actor returned no data for property URL: ${detailUrl}`);
      console.warn(`⚠️ The actor may not support fetching individual property URLs directly`);
      console.warn(`⚠️ Trying fallback: search by address if available...`);
      
      // FALLBACK: If URL doesn't work, try searching by address and filtering by ZPID
      if (propertyAddress && zpid) {
        console.log(`🔄 Fallback: Searching by address "${propertyAddress}" and filtering by ZPID ${zpid}`);
        
        try {
          const searchResult = await scrapeZillowProperties({
            address: propertyAddress,
            maxResults: 50, // Get more results to find the specific property
            isSold: false, // Try for sale first
          });
          
          if (searchResult.success && searchResult.data && searchResult.data.length > 0) {
            // Find property with matching ZPID
            const matchingProperty = searchResult.data.find(p => {
              const propZpid = String(p.zpid || p.id || p.sourceId || '');
              return propZpid === String(zpid);
            });
            
            if (matchingProperty) {
              console.log(`✅ Found property in search results by ZPID ${zpid}`);
              const normalized = normalizePropertyData(matchingProperty, 'zillow');
              const images = extractImages(matchingProperty, 'zillow');
              
              return {
                images,
                property: matchingProperty,
              };
            } else {
              console.warn(`⚠️ Property with ZPID ${zpid} not found in search results`);
            }
          }
        } catch (fallbackError) {
          console.error(`❌ Fallback search also failed:`, fallbackError.message);
        }
      }
      
      return null;
    }
  } catch (error) {
    console.error('❌ Error fetching Zillow property details:', error.message);
    console.error('❌ Error stack:', error.stack);
    return null;
  }
};

/**
 * Scrape property by address using APIFY_ZILLOW_ACTOR_ID
 * Input format: { "input": [{ "address": "2659 Central Park Ct, Owensboro, KY 42303" }] }
 * Returns full property details including all images
 */
export const scrapePropertyByAddress = async (address) => {
  // Read directly from process.env to ensure we get the latest value
  const ZILLOW_ACTOR_ID = process.env.APIFY_ZILLOW_ACTOR_ID || process.env.ZILLOW_ACTOR_ID;

  if (!ZILLOW_ACTOR_ID || ZILLOW_ACTOR_ID === 'your-zillow-actor-id') {
    console.warn('APIFY_ZILLOW_ACTOR_ID not configured');
    return { success: false, data: null, message: 'Zillow actor not configured' };
  }

  if (!address || typeof address !== 'string' || address.trim().length === 0) {
    return { success: false, data: null, message: 'Address is required' };
  }

  console.log('🔍 Scraping property by address using actor:', ZILLOW_ACTOR_ID);
  console.log('📍 Address:', address);

  try {
    // Build input in the format expected by the actor
    // Format: { "input": [{ "address": "..." }] }
    const input = {
      input: [
        {
          address: address.trim(),
        },
      ],
    };

    console.log('📤 Apify input:', JSON.stringify(input, null, 2));

    const result = await runApifyActor(ZILLOW_ACTOR_ID, input);

    console.log('📥 Apify result:', {
      success: result.success,
      dataLength: result.data?.length || 0,
      error: result.error || 'none',
      runId: result.runId,
    });

    if (!result.success) {
      console.error(`❌ Apify actor failed: ${result.error || result.message}`);
      if (result.runId) {
        console.error(`🔗 Check run status: https://console.apify.com/actors/runs/${result.runId}`);
      }
      // Preserve status code and suggestion for 402 errors
      return {
        success: false,
        data: null,
        message: result.message || result.error || 'Failed to scrape property',
        statusCode: result.statusCode,
        suggestion: result.suggestion,
      };
    }

    if (!result.data || result.data.length === 0) {
      console.warn(`⚠️ Apify actor returned no data for address: ${address}`);
      return { success: false, data: null, message: 'No property found for the given address' };
    }

    // The actor returns an array, get the first result
    let propertyData = result.data[0];

    // Handle case where result.data is an array of arrays
    if (Array.isArray(propertyData) && propertyData.length > 0) {
      propertyData = propertyData[0];
    }

    if (!propertyData || typeof propertyData !== 'object') {
      console.error(`❌ Invalid property data structure`);
      return { success: false, data: null, message: 'Invalid property data structure' };
    }

    console.log('📦 Property data keys:', Object.keys(propertyData));
    console.log('📦 Property ZPID:', propertyData.zpid || propertyData.id || 'N/A');
    console.log('📦 Property address:', propertyData.address?.streetAddress || propertyData.streetAddress || propertyData.address || 'N/A');

    // Normalize the property data
    const normalized = normalizePropertyData(propertyData, 'zillow');
    
    if (!normalized) {
      console.error(`❌ Failed to normalize property data`);
      return { success: false, data: null, message: 'Failed to normalize property data' };
    }

    // Extract and deduplicate images
    let images = extractImages(propertyData, 'zillow');
    
    // Deduplicate images using the utility function
    const { removeDuplicateImages } = await import('../utils/imagePreprocessing.js');
    images = removeDuplicateImages(images);

    console.log(`✅ Extracted ${images.length} unique images after deduplication`);

    // Set images in normalized property
    normalized.images = images;

    // Deduplicate property data fields (remove duplicate nested objects)
    const deduplicatedProperty = await deduplicatePropertyData(normalized);

    return {
      success: true,
      data: deduplicatedProperty,
      message: 'Property scraped successfully',
    };
  } catch (error) {
    console.error('❌ Error scraping property by address:', error.message);
    console.error('❌ Error stack:', error.stack);
    return { success: false, data: null, message: error.message || 'Failed to scrape property' };
  }
};

/**
 * Deduplicate property data by removing duplicate nested objects and arrays
 */
const deduplicatePropertyData = async (property) => {
  if (!property || typeof property !== 'object') {
    return property;
  }

  const deduplicated = { ...property };

  // Deduplicate arrays that might contain duplicate objects
  if (Array.isArray(property.priceHistory)) {
    const seenPrices = new Set();
    deduplicated.priceHistory = property.priceHistory.filter((item) => {
      const key = `${item.time || item.date || ''}_${item.price || ''}`;
      if (seenPrices.has(key)) return false;
      seenPrices.add(key);
      return true;
    });
  }

  if (Array.isArray(property.taxHistory)) {
    const seenTaxes = new Set();
    deduplicated.taxHistory = property.taxHistory.filter((item) => {
      const key = `${item.time || item.date || ''}_${item.value || ''}`;
      if (seenTaxes.has(key)) return false;
      seenTaxes.add(key);
      return true;
    });
  }

  if (Array.isArray(property.schools)) {
    const seenSchools = new Set();
    deduplicated.schools = property.schools.filter((school) => {
      const key = school.name || school.link || '';
      if (seenSchools.has(key)) return false;
      seenSchools.add(key);
      return true;
    });
  }

  // Remove duplicate photos arrays if they exist
  if (Array.isArray(property.photos)) {
    // Import dynamically to avoid circular dependency
    const { removeDuplicateImages } = await import('../utils/imagePreprocessing.js');
    deduplicated.photos = removeDuplicateImages(property.photos.map(p => typeof p === 'string' ? p : (p.url || p.imageUrl || '')));
  }

  if (Array.isArray(property.originalPhotos)) {
    const seenOriginalPhotos = new Set();
    deduplicated.originalPhotos = property.originalPhotos.filter((photo) => {
      const url = photo.url || photo.mixedSources?.jpeg?.[0]?.url || '';
      if (!url) return false;
      try {
        const normalized = new URL(url).pathname.toLowerCase();
        if (seenOriginalPhotos.has(normalized)) return false;
        seenOriginalPhotos.add(normalized);
        return true;
      } catch {
        if (seenOriginalPhotos.has(url.toLowerCase())) return false;
        seenOriginalPhotos.add(url.toLowerCase());
        return true;
      }
    });
  }

  return deduplicated;
};
