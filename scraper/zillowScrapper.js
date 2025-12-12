import axios from 'axios';
import * as cheerio from 'cheerio';

import { getEnv } from '../config/config.js';

const ZENROWS_KEY = getEnv('ZENROWS_API_KEY');

export const scrapeZillowProperty = async (propertyUrl) => {
  try {
    const url = `https://api.zenrows.com/v1/?apikey=${ZENROWS_KEY}&url=${encodeURIComponent(
      propertyUrl
    )}`;

    const { data } = await axios.get(url);
    const $ = cheerio.load(data);

    // Example: modify selectors according to Zillow HTML structure
    const rawAddress = $('h1[data-testid="home-details-summary-headline"]').text().trim();
    const beds = parseInt($('span[data-testid="bed-bath-beyond-beds"]').text()) || 0;
    const baths = parseInt($('span[data-testid="bed-bath-beyond-baths"]').text()) || 0;
    const sqftText = $('span[data-testid="bed-bath-beyond-sqft"]').text().replace(/,/g, '');
    const squareFootage = parseInt(sqftText) || 0;

    return { rawAddress, beds, baths, squareFootage };
  } catch (err) {
    console.error('Scraping error:', err.message);
    return null;
  }
};
