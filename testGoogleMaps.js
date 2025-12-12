import axios from 'axios';
import { getEnv } from '../config/config.js'; // use your wrapper

export const normalizeAddress = async (address) => {
  if (!address) return null;

  try {
    const GOOGLE_MAPS_API_KEY = getEnv('GOOGLE_MAPS_API_KEY');

    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
      address
    )}&key=${GOOGLE_MAPS_API_KEY}`;
    const res = await axios.get(url);

    console.log('Google Maps API response:', res.data); // for debugging

    if (res.data.status !== 'OK' || !res.data.results || res.data.results.length === 0) {
      return null;
    }

    const result = res.data.results[0];
    return {
      formattedAddress: result.formatted_address,
      lat: result.geometry.location.lat,
      lng: result.geometry.location.lng,
    };
  } catch (err) {
    console.error('Google Maps API Error:', err.message);
    return null;
  }
};
