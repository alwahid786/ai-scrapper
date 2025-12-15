import axios from 'axios';
import * as cheerio from 'cheerio';

/**
 * Scrape Zillow property metadata using only the formatted address.
 * @param {string} formattedAddress
 * @returns {object|null} Property metadata or null
 */
export const scrapeZillow = async (formattedAddress) => {
  try {
    console.log('--- Zillow Scraper Started ---');
    console.log('Formatted address:', formattedAddress);

    /* -------------------------------
       STEP 1: Search Zillow to get ZPID
    -------------------------------- */
    const searchURL = `https://www.zillow.com/homes/${encodeURIComponent(formattedAddress)}/`;
    console.log('Generated Zillow search URL:', searchURL);

    const zenrowsSearchURL = `https://api.zenrows.com/v1/?apikey=${
      process.env.ZENROWS_API_KEY
    }&url=${encodeURIComponent(searchURL)}&js_render=true&premium_proxy=true`;

    console.log('Fetching Zillow search page via ZenRows...');
    const { data: searchHTML } = await axios.get(zenrowsSearchURL);
    console.log('Fetched search HTML length:', searchHTML.length);

    const $search = cheerio.load(searchHTML);

    // Extract ZPID from scripts
    let zpid = null;
    $search('script').each((_, el) => {
      const text = $search(el).html();
      if (text && text.includes('zpid')) {
        const match = text.match(/"zpid":\s*([0-9]+)/);
        if (match) zpid = match[1];
      }
    });

    if (!zpid) {
      console.error('ZPID not found on Zillow search page.');
      return null;
    }

    console.log('ZPID found:', zpid);

    /* -------------------------------
       STEP 2: Fetch property page
    -------------------------------- */
    const propertyURL = `https://www.zillow.com/homedetails/${zpid}_zpid/`;
    console.log('Generated Zillow property URL:', propertyURL);

    const zenrowsDetailsURL = `https://api.zenrows.com/v1/?apikey=${
      process.env.ZENROWS_API_KEY
    }&url=${encodeURIComponent(propertyURL)}&js_render=true&premium_proxy=true`;

    console.log('Fetching Zillow property page via ZenRows...');
    const { data: detailsHTML } = await axios.get(zenrowsDetailsURL);
    console.log('Fetched property HTML length:', detailsHTML.length);

    const $details = cheerio.load(detailsHTML);
    const nextDataRaw = $details('#__NEXT_DATA__').html();

    if (!nextDataRaw) {
      console.error('__NEXT_DATA__ not found on property page.');
      return null;
    }

    console.log('Parsed __NEXT_DATA__ JSON');
    const nextData = JSON.parse(nextDataRaw);

    /* -------------------------------
       STEP 3: Extract property metadata
    -------------------------------- */
    const findProperty = (obj) => {
      if (!obj || typeof obj !== 'object') return null;

      if (obj.zpid && (obj.price || obj.unformattedPrice)) return obj;

      for (const key in obj) {
        const result = findProperty(obj[key]);
        if (result) return result;
      }

      return null;
    };

    const property = findProperty(nextData);

    if (!property) {
      console.error('Property data not found in parsed JSON.');
      return null;
    }

    console.log('Property data found!');

    return {
      zpid: property.zpid,
      price: property.price || property.unformattedPrice,
      beds: property.bedrooms,
      baths: property.bathrooms,
      sqft: property.livingArea,
      yearBuilt: property.yearBuilt,
      propertyType: property.homeType,
      address: property.streetAddress,
      city: property.city,
      state: property.state,
      zipcode: property.zipcode,
    };
  } catch (err) {
    console.error('scrapeZillow error:', err.message);
    return null;
  }
};
