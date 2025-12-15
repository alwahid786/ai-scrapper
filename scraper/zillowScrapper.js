// import axios from 'axios';
// import { getEnv } from '../config/config.js';

// const ZENROWS_API_KEY = getEnv('ZENROWS_API_KEY');

// export const searchZillowZPID = async (formattedAddress) => {
//   try {
//     const searchEndpoint = 'https://www.zillow.com/search/GetSearchPageState.htm';

//     const payload = {
//       searchQueryState: {
//         pagination: {},
//         usersSearchTerm: formattedAddress,
//         mapBounds: {
//           west: -180,
//           east: 180,
//           south: -90,
//           north: 90,
//         },
//         isMapVisible: false,
//         filterState: {
//           isAllHomes: { value: true },
//         },
//       },
//       wants: {
//         cat1: ['listResults'],
//       },
//     };

//     const zenrowsUrl = `https://api.zenrows.com/v1/?apikey=${ZENROWS_API_KEY}&url=${encodeURIComponent(
//       searchEndpoint
//     )}&js_render=true&premium_proxy=true`;

//     const response = await axios.post(zenrowsUrl, payload, {
//       headers: {
//         'Content-Type': 'application/json',
//       },
//     });

//     const results = response.data?.cat1?.searchResults?.listResults;

//     if (!results || results.length === 0) {
//       console.warn('Zillow search returned no results');
//       return null;
//     }

//     return results[0].zpid || null;
//   } catch (error) {
//     console.error('searchZillowZPID error:', error.message);
//     return null;
//   }
// };

// export const scrapeZillowPropertyByZPID = async (zpid) => {
//   try {
//     const propertyUrl = `https://www.zillow.com/homedetails/${zpid}_zpid/`;

//     const zenrowsUrl = `https://api.zenrows.com/v1/?apikey=${ZENROWS_API_KEY}&url=${encodeURIComponent(
//       propertyUrl
//     )}&js_render=true&premium_proxy=true`;

//     const response = await axios.get(zenrowsUrl);
//     const html = response.data;

//     // Extract embedded JSON
//     const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/);

//     if (!match) {
//       console.warn('Zillow __NEXT_DATA__ not found');
//       return null;
//     }

//     const json = JSON.parse(match[1]);
//     const property = json?.props?.pageProps?.componentProps?.property;

//     if (!property) {
//       console.warn('Zillow property object missing');
//       return null;
//     }
//     const data = await scrapeZillowPropertyByZPID('12345678');
//     console.log(data);

//     return {
//       beds: property.bedrooms ?? null,
//       baths: property.bathrooms ?? null,
//       squareFootage: property.livingArea ?? null,
//       lotSize: property.lotAreaValue ?? null,
//       yearBuilt: property.yearBuilt ?? null,
//       propertyType: property.homeType ?? null,
//       lastSoldDate: property.lastSoldDate ? new Date(property.lastSoldDate) : null,
//       lastSoldPrice: property.lastSoldPrice ?? null,
//       estimatedValue: property.zestimate ?? null,
//       source: 'zillow',
//     };
//   } catch (error) {
//     console.error('scrapeZillowPropertyByZPID error:', error.message);
//     return null;
//   }
// };
