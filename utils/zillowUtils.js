import * as cheerio from 'cheerio';
import { fetchWithFallback } from '../utils/ftechWithFallback.js';

export const buildSearchUrl = (filters) => {
  let url = 'https://www.zillow.com/homes/for_sale/';

  if (filters.minPrice || filters.maxPrice)
    url += `${filters.minPrice || 0}-${filters.maxPrice || ''}_price/`;

  if (filters.minSqft || filters.maxSqft)
    url += `${filters.minSqft || 0}-${filters.maxSqft || ''}_size/`;

  if (filters.propertyType) url += `${filters.propertyType}/`;

  url += filters.isSold === 'true' ? 'sold/' : 'for_sale/';
  return url;
};

export const scrapeProperties = async (filters, limit = 20) => {
  const url = buildSearchUrl(filters);
  console.log('Scraping Zillow URL:', url);

  const { data: html, provider } = await fetchWithFallback(url);
  console.log('HTML fetched via:', provider, 'length:', html.length);

  if (!html) return [];

  const $ = cheerio.load(html);
  const results = [];

  $('article').each((_, el) => {
    if (results.length >= limit) return false;

    const address = $(el).find('[data-test="property-address"]').text();
    if (!address) return;

    results.push({
      address,
      price: $(el).find('[data-test="property-price"]').text(),
      beds: $(el).find('[data-test="property-beds"]').text(),
      baths: $(el).find('[data-test="property-baths"]').text(),
      sqft: $(el).find('[data-test="property-floorSpace"]').text(),
      isSold: $(el).find('[data-test="property-status"]').text().includes('Sold'),
    });
  });

  console.log('Properties extracted:', results.length);
  return results;
};
