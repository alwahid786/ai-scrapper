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

    return {
      formattedAddress: data[0].display_name,
      latitude: parseFloat(data[0].lat),
      longitude: parseFloat(data[0].lon),
    };
  } catch (err) {
    console.error('Address normalization error:', err.message);
    return null;
  }
};
