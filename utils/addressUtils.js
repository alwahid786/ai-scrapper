import axios from "axios";

// State abbreviations mapping
const STATE_ABBREVIATIONS = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
};

// Street type abbreviations normalization
const STREET_ABBREVIATIONS = {
  street: "St",
  avenue: "Ave",
  road: "Rd",
  drive: "Dr",
  lane: "Ln",
  court: "Ct",
  circle: "Cir",
  boulevard: "Blvd",
  parkway: "Pkwy",
  highway: "Hwy",
  place: "Pl",
  square: "Sq",
  terrace: "Ter",
  way: "Way",
  trail: "Trl",
  park: "Pk",
  commons: "Cmns",
};

/**
 * Clean and preprocess address input
 */
const cleanAddress = (address) => {
  if (!address || typeof address !== "string") return "";

  return (
    address
      .trim()
      // Remove extra whitespace
      .replace(/\s+/g, " ")
      // Remove common prefixes/suffixes that might confuse geocoding
      .replace(/^(address|addr|location|loc):\s*/i, "")
      // Normalize common separators
      .replace(/[,\s]+/g, " ")
      .trim()
  );
};

/**
 * Normalize street type abbreviations (e.g., "Street" -> "St")
 */
const normalizeStreetType = (street) => {
  if (!street) return street;

  let normalized = street;
  for (const [full, abbrev] of Object.entries(STREET_ABBREVIATIONS)) {
    const regex = new RegExp(`\\b${full}\\b`, "gi");
    normalized = normalized.replace(regex, abbrev);
  }
  return normalized;
};

/**
 * Normalize state name to abbreviation
 */
const normalizeState = (state) => {
  if (!state) return "";
  const normalized = state.toLowerCase().trim();
  return STATE_ABBREVIATIONS[normalized] || state.toUpperCase();
};

/**
 * Score a geocoding result to find the best match
 */
const scoreResult = (result, originalAddress) => {
  let score = 0;
  const addr = result.address || {};
  const originalLower = originalAddress.toLowerCase();

  // Prefer results with house numbers
  if (addr.house_number) score += 10;

  // Prefer results with road/street
  if (addr.road || addr.pedestrian || addr.footway || addr.residential) score += 8;

  // Prefer results with city
  if (addr.city || addr.town || addr.village) score += 6;

  // Prefer results with state
  if (addr.state || addr.region) score += 4;

  // Prefer results with postcode
  if (addr.postcode) score += 3;

  // Prefer results where display_name contains original address terms
  const displayName = (result.display_name || "").toLowerCase();
  const originalTerms = originalLower.split(/\s+/).filter((t) => t.length > 2);
  originalTerms.forEach((term) => {
    if (displayName.includes(term)) score += 2;
  });

  // Prefer residential addresses
  if (result.type === "house" || result.type === "residential") score += 5;

  return score;
};

/**
 * Extract comprehensive address components
 */
const extractAddressComponents = (result) => {
  const addr = result.address || {};

  // Street components
  const houseNumber = addr.house_number || "";
  const road = addr.road || addr.pedestrian || addr.footway || addr.residential || addr.path || addr.street || "";

  // City components (try multiple fields)
  const city = addr.city || addr.town || addr.village || addr.hamlet || addr.municipality || addr.city_district || "";

  // State/Region
  const stateRaw = addr.state || addr.region || "";
  const state = normalizeState(stateRaw);

  // Postal code
  const postcode = addr.postcode || "";

  // Additional components
  const unit = addr.unit || addr.apartment || addr.suite || "";
  const county = addr.county || "";
  const country = addr.country || "";
  const countryCode = (addr.country_code || "").toUpperCase();

  // Build street address
  let streetAddress = [houseNumber, road].filter(Boolean).join(" ");
  if (unit) {
    streetAddress += ` ${unit}`;
  }

  // Build formatted address
  const parts = [streetAddress, city, state, postcode].filter(Boolean);
  const formattedAddress = parts.join(", ");

  // Build Zillow-friendly query (optimized for Zillow search)
  // Zillow prefers: "Street Address, City, State ZIP"
  const zillowParts = [];
  if (streetAddress) zillowParts.push(streetAddress);
  if (city) zillowParts.push(city);
  if (state) zillowParts.push(state);
  if (postcode) zillowParts.push(postcode);
  const zillowQuery = zillowParts.join(", ");

  return {
    streetAddress: streetAddress || road || "",
    city: city || "",
    state: state || stateRaw || "",
    postcode: postcode || "",
    unit: unit || "",
    county: county || "",
    country: country || "",
    countryCode: countryCode || "",
    houseNumber: houseNumber || "",
    road: normalizeStreetType(road) || "",
    formattedAddress: result.display_name || formattedAddress,
    zillowQuery: zillowQuery || formattedAddress,
    rawComponents: addr,
  };
};

/**
 * Enhanced address normalization using OpenStreetMap Nominatim
 * Handles various address formats, abbreviations, and edge cases
 */
export const normalizeAddress = async (address, options = {}) => {
  if (!address) return null;

  const {
    timeout = 10000, // 10 second timeout
    retries = 2,
    limit = 5, // Number of results to fetch
    countryBias = "us", // Bias towards US addresses
  } = options;

  try {
    const baseUrl = process.env.ADDRESS_NORMALIZE_URL;
    if (!baseUrl) {
      throw new Error("ADDRESS_NORMALIZE_URL not defined in .env");
    }

    // Clean the input address
    const cleanedAddress = cleanAddress(address);
    if (!cleanedAddress) {
      console.warn("Address is empty after cleaning");
      return null;
    }

    // Build query URL with better parameters
    const params = new URLSearchParams({
      q: cleanedAddress,
      format: "json",
      addressdetails: "1",
      limit: limit.toString(),
      countrycodes: countryBias, // Bias towards US
      dedupe: "1", // Deduplicate results
    });

    const url = `${baseUrl}?${params.toString()}`;

    let lastError = null;
    let data = null;

    // Retry logic with timeout
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await axios.get(url, {
          headers: {
            "User-Agent": "RealEstateUnderwriting/1.0",
            Accept: "application/json",
          },
          timeout: timeout,
        });

        data = response.data;
        break; // Success, exit retry loop
      } catch (err) {
        lastError = err;
        if (attempt < retries) {
          // Exponential backoff
          await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
          continue;
        }
        throw err;
      }
    }

    if (!data || !Array.isArray(data) || data.length === 0) {
      console.warn("No geocoding results found for address:", cleanedAddress);
      return null;
    }

    // Score and sort results to find the best match
    const scoredResults = data
      .map((result) => ({
        result,
        score: scoreResult(result, cleanedAddress),
      }))
      .sort((a, b) => b.score - a.score);

    // Use the highest scored result
    const bestResult = scoredResults[0].result;

    // Extract comprehensive address components
    const components = extractAddressComponents(bestResult);

    // Validate we have minimum required data
    if (!bestResult.lat || !bestResult.lon) {
      console.warn("Geocoding result missing coordinates");
      return null;
    }

    return {
      formattedAddress: bestResult.display_name || components.formattedAddress,
      latitude: parseFloat(bestResult.lat),
      longitude: parseFloat(bestResult.lon),
      addressComponents: {
        ...components.rawComponents,
        streetAddress: components.streetAddress,
        city: components.city,
        state: components.state,
        postcode: components.postcode,
        unit: components.unit,
        county: components.county,
        country: components.country,
        countryCode: components.countryCode,
      },
      zillowQuery: components.zillowQuery,
      // Additional metadata
      confidence: scoredResults[0].score,
      resultType: bestResult.type,
      resultClass: bestResult.class,
    };
  } catch (err) {
    console.error("Address normalization error:", err.message);
    if (err.response) {
      console.error("API Response Status:", err.response.status);
      console.error("API Response Data:", err.response.data);
    }
    return null;
  }
};
