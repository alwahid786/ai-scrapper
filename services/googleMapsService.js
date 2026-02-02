import axios from 'axios';
import { getEnv } from '../config/config.js';

const GOOGLE_MAPS_API_KEY = getEnv('GOOGLE_MAPS_API_KEY');
const BASE_URL = 'https://maps.googleapis.com/maps/api';

/**
 * Normalize address using Google Maps Geocoding API
 */
export const normalizeAddress = async (address) => {
  if (!address || typeof address !== 'string') {
    throw new Error('Address is required and must be a string');
  }

  try {
    const url = `${BASE_URL}/geocode/json`;
    const params = {
      address: address.trim(),
      key: GOOGLE_MAPS_API_KEY,
    };

    const response = await axios.get(url, { params, timeout: 10000 });

    // Log geocoding response for debugging
    if (response.data.status !== 'OK') {
      console.error('Geocoding API error:', {
        status: response.data.status,
        error_message: response.data.error_message,
        address: address.trim(),
      });
      
      // Handle specific error cases
      if (response.data.status === 'ZERO_RESULTS') {
        console.warn(`No results found for address: ${address}`);
        return null;
      }
      if (response.data.status === 'REQUEST_DENIED') {
        console.error('Geocoding API request denied - check API key and billing');
        throw new Error('Geocoding API request denied - check API key configuration');
      }
      if (response.data.status === 'OVER_QUERY_LIMIT') {
        console.error('Geocoding API quota exceeded');
        throw new Error('Geocoding API quota exceeded');
      }
      
      return null;
    }
    
    if (!response.data.results?.length) {
      console.warn(`Geocoding returned no results for: ${address}`);
      return null;
    }

    const result = response.data.results[0];
    const location = result.geometry.location;

    // Extract address components
    const components = {};
    result.address_components.forEach((component) => {
      component.types.forEach((type) => {
        components[type] = component.long_name;
        components[`${type}_short`] = component.short_name;
      });
    });

    return {
      formattedAddress: result.formatted_address,
      latitude: location.lat,
      longitude: location.lng,
      addressComponents: {
        streetNumber: components.street_number || '',
        street: components.route || '',
        city: components.locality || components.sublocality || '',
        state: components.administrative_area_level_1_short || '',
        zipCode: components.postal_code || '',
        country: components.country || '',
        countryCode: components.country_short || '',
      },
      placeId: result.place_id,
      types: result.types,
    };
  } catch (error) {
    console.error('Google Maps Geocoding Error:', error.message);
    throw new Error(`Failed to normalize address: ${error.message}`);
  }
};

/**
 * Find nearby properties using Google Places API
 * Note: This is a simplified version. For production, you'd use Apify actors
 */
export const findNearbyProperties = async (latitude, longitude, radiusMeters = 1609) => {
  try {
    // First, find nearby places (restaurants, etc. as a proxy)
    // In production, use Apify actors for actual property data
    const url = `${BASE_URL}/place/nearbysearch/json`;
    const params = {
      location: `${latitude},${longitude}`,
      radius: radiusMeters,
      type: 'establishment',
      key: GOOGLE_MAPS_API_KEY,
    };

    const response = await axios.get(url, { params, timeout: 10000 });

    if (response.data.status !== 'OK') {
      return [];
    }

    return response.data.results.map((place) => ({
      placeId: place.place_id,
      name: place.name,
      address: place.vicinity,
      latitude: place.geometry.location.lat,
      longitude: place.geometry.location.lng,
      distance: calculateDistance(
        latitude,
        longitude,
        place.geometry.location.lat,
        place.geometry.location.lng
      ),
    }));
  } catch (error) {
    console.error('Google Places API Error:', error.message);
    return [];
  }
};

/**
 * Calculate distance between two coordinates in miles (Haversine formula)
 */
export const calculateDistance = (lat1, lon1, lat2, lon2) => {
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
 * Determine if area is urban, suburban, or rural based on place types
 */
export const determineAreaType = (placeTypes) => {
  if (!placeTypes || !Array.isArray(placeTypes)) return 'suburban';

  const urbanIndicators = ['locality', 'sublocality', 'neighborhood'];
  const ruralIndicators = ['administrative_area_level_2', 'country'];

  if (placeTypes.some((type) => urbanIndicators.includes(type))) {
    return 'urban';
  }
  if (placeTypes.some((type) => ruralIndicators.includes(type))) {
    return 'rural';
  }
  return 'suburban';
};

/**
 * Get default search radius based on area type
 */
export const getDefaultRadius = (areaType) => {
  const radiusMap = {
    urban: 0.5, // 0.25-0.5 miles
    suburban: 1.0, // 0.5-1.0 miles
    rural: 2.0, // 1-2 miles
  };
  return radiusMap[areaType] || 1.0;
};

/**
 * Validate Google Maps API capabilities
 * Checks if Geocoding and Places API are enabled
 */
export const validateGoogleMapsAPI = async () => {
  if (!GOOGLE_MAPS_API_KEY) {
    return {
      valid: false,
      error: 'GOOGLE_MAPS_API_KEY is not configured',
      geocodingEnabled: false,
      placesEnabled: false,
    };
  }

  const validationResults = {
    valid: true,
    geocodingEnabled: false,
    placesEnabled: false,
    errors: [],
  };

  // Test Geocoding API
  try {
    const geocodeUrl = `${BASE_URL}/geocode/json`;
    const geocodeParams = {
      address: '1600 Amphitheatre Parkway, Mountain View, CA',
      key: GOOGLE_MAPS_API_KEY,
    };

    const geocodeResponse = await axios.get(geocodeUrl, { params: geocodeParams, timeout: 5000 });
    
    if (geocodeResponse.data.status === 'OK') {
      validationResults.geocodingEnabled = true;
    } else if (geocodeResponse.data.status === 'REQUEST_DENIED') {
      validationResults.errors.push('Geocoding API: Request denied - check API key and enable Geocoding API');
    } else if (geocodeResponse.data.status === 'OVER_QUERY_LIMIT') {
      validationResults.errors.push('Geocoding API: Over query limit');
    } else {
      validationResults.errors.push(`Geocoding API: ${geocodeResponse.data.status}`);
    }
  } catch (error) {
    validationResults.errors.push(`Geocoding API test failed: ${error.message}`);
  }

  // Test Places API (Nearby Search)
  try {
    const placesUrl = `${BASE_URL}/place/nearbysearch/json`;
    const placesParams = {
      location: '37.4224764,-122.0842499',
      radius: 1000,
      type: 'restaurant',
      key: GOOGLE_MAPS_API_KEY,
    };

    const placesResponse = await axios.get(placesUrl, { params: placesParams, timeout: 5000 });
    
    if (placesResponse.data.status === 'OK') {
      validationResults.placesEnabled = true;
    } else if (placesResponse.data.status === 'REQUEST_DENIED') {
      validationResults.errors.push('Places API: Request denied - check API key and enable Places API');
    } else if (placesResponse.data.status === 'OVER_QUERY_LIMIT') {
      validationResults.errors.push('Places API: Over query limit');
    } else {
      validationResults.errors.push(`Places API: ${placesResponse.data.status}`);
    }
  } catch (error) {
    validationResults.errors.push(`Places API test failed: ${error.message}`);
  }

  validationResults.valid = validationResults.geocodingEnabled && validationResults.placesEnabled;

  if (!validationResults.valid) {
    console.warn('Google Maps API validation failed:', validationResults.errors);
  } else {
    console.log('✅ Google Maps API validation passed: Geocoding and Places API are enabled');
  }

  return validationResults;
};

/**
 * Calculate neighborhood rating using Google Places API
 * Factors: schools (with quality ratings), amenities, safety indicators (crime proxies), area quality, demand indicators
 */
export const calculateNeighborhoodRating = async (latitude, longitude, address = '') => {
  if (!GOOGLE_MAPS_API_KEY) {
    console.warn('Google Maps API key not configured, using default neighborhood rating');
    return 50; // Default neutral score
  }

  if (!latitude || !longitude) {
    console.warn('Coordinates not provided for neighborhood rating');
    return 50;
  }

  try {
    const ratingFactors = {
      schools: 0,
      amenities: 0,
      safety: 0,
      walkability: 0,
      demand: 0,
    };

    // Search for schools nearby (within 2 miles) and get quality ratings
    try {
      const schoolsUrl = `${BASE_URL}/place/nearbysearch/json`;
      const schoolsParams = {
        location: `${latitude},${longitude}`,
        radius: 3218, // 2 miles in meters
        type: 'school',
        key: GOOGLE_MAPS_API_KEY,
      };

      const schoolsResponse = await axios.get(schoolsUrl, { params: schoolsParams, timeout: 10000 });
      if (schoolsResponse.data.status === 'OK' && schoolsResponse.data.results) {
        const schools = schoolsResponse.data.results;
        const schoolCount = schools.length;
        
        // Get school ratings (quality scores) from Google Places
        let totalSchoolRating = 0;
        let ratedSchoolsCount = 0;
        
        // Fetch details for top 10 schools to get ratings
        const topSchools = schools.slice(0, 10);
        for (const school of topSchools) {
          if (school.place_id) {
            try {
              const detailsUrl = `${BASE_URL}/place/details/json`;
              const detailsParams = {
                place_id: school.place_id,
                fields: 'rating,user_ratings_total',
                key: GOOGLE_MAPS_API_KEY,
              };
              
              const detailsResponse = await axios.get(detailsUrl, { params: detailsParams, timeout: 5000 });
              if (detailsResponse.data.status === 'OK' && detailsResponse.data.result) {
                const rating = detailsResponse.data.result.rating;
                const ratingsCount = detailsResponse.data.result.user_ratings_total || 0;
                
                // Only count schools with ratings and sufficient reviews (at least 10 reviews)
                if (rating && ratingsCount >= 10) {
                  totalSchoolRating += rating; // Google ratings are 1-5 scale
                  ratedSchoolsCount++;
                }
              }
            } catch (detailError) {
              // Skip if details fetch fails
              continue;
            }
          }
        }
        
        // Calculate school quality score based on average rating
        // If we have ratings, use them; otherwise fall back to count
        if (ratedSchoolsCount > 0) {
          const avgSchoolRating = totalSchoolRating / ratedSchoolsCount;
          // Convert 1-5 scale to 0-100: (rating - 1) / 4 * 100
          // 5.0 rating = 100, 4.0 = 75, 3.0 = 50, 2.0 = 25, 1.0 = 0
          ratingFactors.schools = ((avgSchoolRating - 1) / 4) * 100;
          // Bonus for having multiple good schools
          if (schoolCount >= 5) ratingFactors.schools = Math.min(100, ratingFactors.schools + 10);
          console.log(`Found ${schoolCount} schools, ${ratedSchoolsCount} with ratings. Average rating: ${avgSchoolRating.toFixed(2)}`);
        } else {
          // Fallback: use school count if no ratings available
          ratingFactors.schools = Math.min(100, (schoolCount / 10) * 100);
          console.log(`Found ${schoolCount} schools nearby (no ratings available)`);
        }
      }
    } catch (schoolError) {
      console.warn('Failed to fetch schools:', schoolError.message);
    }

    // Search for amenities (restaurants, parks, shopping)
    try {
      const amenitiesUrl = `${BASE_URL}/place/nearbysearch/json`;
      const amenitiesParams = {
        location: `${latitude},${longitude}`,
        radius: 1609, // 1 mile in meters
        type: 'restaurant',
        key: GOOGLE_MAPS_API_KEY,
      };

      const amenitiesResponse = await axios.get(amenitiesUrl, { params: amenitiesParams, timeout: 10000 });
      if (amenitiesResponse.data.status === 'OK' && amenitiesResponse.data.results) {
        const restaurantCount = amenitiesResponse.data.results.length;
        
        // Also search for parks
        const parksParams = { ...amenitiesParams, type: 'park' };
        const parksResponse = await axios.get(amenitiesUrl, { params: parksParams, timeout: 10000 });
        const parkCount = parksResponse.data.status === 'OK' && parksResponse.data.results 
          ? parksResponse.data.results.length 
          : 0;

        // More amenities = better (restaurants + parks)
        const totalAmenities = restaurantCount + parkCount;
        ratingFactors.amenities = Math.min(100, (totalAmenities / 20) * 100);
        console.log(`Found ${restaurantCount} restaurants and ${parkCount} parks nearby`);
      }
    } catch (amenityError) {
      console.warn('Failed to fetch amenities:', amenityError.message);
    }

    // Calculate safety score using crime indicators from Google Places
    // Search for police stations (more = safer), and use area characteristics
    // First, get place types from reverse geocoding to determine area type accurately
    let placeTypes = [];
    let actualAreaType = 'suburban';
    try {
      const reverseGeocodeUrl = `${BASE_URL}/geocode/json`;
      const reverseGeocodeParams = {
        latlng: `${latitude},${longitude}`,
        key: GOOGLE_MAPS_API_KEY,
      };
      const reverseGeocodeResponse = await axios.get(reverseGeocodeUrl, { params: reverseGeocodeParams, timeout: 10000 });
      if (reverseGeocodeResponse.data.status === 'OK' && reverseGeocodeResponse.data.results && reverseGeocodeResponse.data.results.length > 0) {
        placeTypes = reverseGeocodeResponse.data.results[0].types || [];
        actualAreaType = determineAreaType(placeTypes);
        console.log(`Area type determined from place types: ${actualAreaType}`);
      }
    } catch (geoError) {
      console.warn('Failed to get place types from reverse geocoding:', geoError.message);
    }
    
    try {
      const safetyUrl = `${BASE_URL}/place/nearbysearch/json`;
      const safetyParams = {
        location: `${latitude},${longitude}`,
        radius: 3218, // 2 miles in meters
        type: 'police',
        key: GOOGLE_MAPS_API_KEY,
      };

      const safetyResponse = await axios.get(safetyUrl, { params: safetyParams, timeout: 10000 });
      let policeStationCount = 0;
      if (safetyResponse.data.status === 'OK' && safetyResponse.data.results) {
        policeStationCount = safetyResponse.data.results.length;
      }
      
      // Also search for hospitals (indicator of developed/safe area)
      const hospitalParams = { ...safetyParams, type: 'hospital' };
      const hospitalResponse = await axios.get(safetyUrl, { params: hospitalParams, timeout: 10000 });
      let hospitalCount = 0;
      if (hospitalResponse.data.status === 'OK' && hospitalResponse.data.results) {
        hospitalCount = hospitalResponse.data.results.length;
      }
      
      // Also search for fire stations (additional safety indicator)
      const fireStationParams = { ...safetyParams, type: 'fire_station' };
      const fireStationResponse = await axios.get(safetyUrl, { params: fireStationParams, timeout: 10000 });
      let fireStationCount = 0;
      if (fireStationResponse.data.status === 'OK' && fireStationResponse.data.results) {
        fireStationCount = fireStationResponse.data.results.length;
      }
      
      // Calculate safety score based on police presence, hospitals, fire stations, and area type
      let baseSafetyScore = 50; // Default
      
      // Police stations indicate safer areas (more police = safer, but diminishing returns)
      const policeScore = Math.min(30, policeStationCount * 10); // Max 30 points for police
      const hospitalScore = Math.min(10, hospitalCount * 2); // Max 10 points for hospitals
      const fireStationScore = Math.min(5, fireStationCount * 2.5); // Max 5 points for fire stations
      
      // Area type base scores (adjusted for real indicators)
      if (actualAreaType === 'suburban') {
        baseSafetyScore = 60; // Suburban areas generally safer
      } else if (actualAreaType === 'urban') {
        baseSafetyScore = 50; // Urban areas moderate
      } else {
        baseSafetyScore = 45; // Rural areas variable
      }
      
      // Combine: base + police presence + hospital presence + fire station presence
      ratingFactors.safety = Math.min(100, baseSafetyScore + policeScore + hospitalScore + fireStationScore);
      console.log(`Safety indicators: ${policeStationCount} police stations, ${hospitalCount} hospitals, ${fireStationCount} fire stations. Safety score: ${ratingFactors.safety.toFixed(1)}`);
    } catch (safetyError) {
      console.warn('Failed to fetch safety indicators:', safetyError.message);
      // Fallback to area type proxy
      if (actualAreaType === 'suburban') ratingFactors.safety = 70;
      else if (actualAreaType === 'urban') ratingFactors.safety = 60;
      else ratingFactors.safety = 45;
    }

    // Walkability: use amenity density as proxy
    ratingFactors.walkability = ratingFactors.amenities;

    // Demand indicators: Calculate based on property value trends and area characteristics
    // Higher property values in area = higher demand
    // More amenities = higher demand
    // Better schools = higher demand
    // Lower crime (higher safety) = higher demand
    // Walkability = higher demand
    // This is a composite score based on other factors
    const demandScore = (
      (ratingFactors.schools * 0.3) + // Good schools = high demand
      (ratingFactors.amenities * 0.3) + // More amenities = higher demand
      (ratingFactors.safety * 0.2) + // Safer areas = higher demand
      (ratingFactors.walkability * 0.2) // Walkable = higher demand
    );
    ratingFactors.demand = Math.round(demandScore);
    console.log(`Demand indicator score: ${ratingFactors.demand.toFixed(1)} (schools: ${ratingFactors.schools.toFixed(1)}, amenities: ${ratingFactors.amenities.toFixed(1)}, safety: ${ratingFactors.safety.toFixed(1)}, walkability: ${ratingFactors.walkability.toFixed(1)})`);

    // Calculate final neighborhood rating (0-100)
    // Updated weights: Schools: 30%, Amenities: 20%, Safety: 25%, Walkability: 15%, Demand: 10%
    const neighborhoodRating = 
      (ratingFactors.schools * 0.30) +
      (ratingFactors.amenities * 0.20) +
      (ratingFactors.safety * 0.25) +
      (ratingFactors.walkability * 0.15) +
      (ratingFactors.demand * 0.10);

    const finalRating = Math.round(Math.max(0, Math.min(100, neighborhoodRating)));
    console.log(`Neighborhood rating calculated: ${finalRating} (schools: ${ratingFactors.schools.toFixed(1)}, amenities: ${ratingFactors.amenities.toFixed(1)}, safety: ${ratingFactors.safety.toFixed(1)}, demand: ${ratingFactors.demand.toFixed(1)})`);

    return finalRating;
  } catch (error) {
    console.error('Error calculating neighborhood rating:', error.message);
    return 50; // Default neutral score on error
  }
};
