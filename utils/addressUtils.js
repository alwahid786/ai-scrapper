import axios from 'axios';

// Address normalization using OpenStreetMap
export const normalizeAddress = async (address) => {
  if (!address) return null;

  try {
    const baseUrl = process.env.ADDRESS_NORMALIZE_URL;
    if (!baseUrl) throw new Error('ADDRESS_NORMALIZE_URL not defined in .env');

    const url = `${baseUrl}?q=${encodeURIComponent(address)}&format=json&addressdetails=1`;
    const { data } = await axios.get(url, { headers: { 'User-Agent': 'my-app' } });

    if (!data || data.length === 0) return null;

    const primary = data[0];
    const addr = primary.address || {};

    const house = addr.house_number || '';
    const road = addr.road || addr.pedestrian || addr.footway || addr.residential || '';
    const street = [house, road].filter(Boolean).join(' ');
    const city = addr.city || addr.town || addr.village || addr.hamlet || addr.county || '';
    const state = addr.state || addr.region || '';
    const postcode = addr.postcode || '';

    // Build a simplified address suitable for site searches (no country, concise)
    const simpleAddress = [street, city, state, postcode].filter(Boolean).join(', ');

    return {
      formattedAddress: primary.display_name,
      latitude: parseFloat(primary.lat),
      longitude: parseFloat(primary.lon),
      addressComponents: addr,
      // a Zillow/search-friendly query (street, city, state, zip)
      zillowQuery: simpleAddress,
    };
  } catch (err) {
    console.error('Address normalization error:', err.message);
    return null;
  }
};
