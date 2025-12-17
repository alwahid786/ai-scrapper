import axios from 'axios';
import * as cheerio from 'cheerio';
import { getEnv } from '../config/config.js';

const safeGetEnv = (key) => {
  try {
    return getEnv(key);
  } catch (err) {
    return null;
  }
};

const buildProxyUrl = (provider, apiKey, targetUrl, render = true) => {
  if (!apiKey) return null;
  if (provider === 'zenrows') {
    return `https://api.zenrows.com/v1/?apikey=${apiKey}&url=${encodeURIComponent(
      targetUrl
    )}&js_render=${render}&m_proxy=true`;
  }
  if (provider === 'scraperapi') {
    return `https://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(
      targetUrl
    )}&render=${render}`;
  }
  return null;
};

const fetchWithFallback = async (url) => {
  const zenrowsKey = safeGetEnv('ZENROWS_API_KEY');
  const scraperKey = safeGetEnv('SCRAPPER_API_KEY');

  const providers = [];
  // Only add providers if they have real, non-dummy keys
  if (zenrowsKey && zenrowsKey.length > 20) providers.push({ name: 'zenrows', key: zenrowsKey });
  if (scraperKey && scraperKey.length > 20) providers.push({ name: 'scraperapi', key: scraperKey });

  // Try configured proxy providers first (with short timeout)
  for (const p of providers) {
    const proxyUrl = buildProxyUrl(p.name, p.key, url, true);
    if (!proxyUrl) continue;
    try {
      const { data } = await axios.get(proxyUrl, { timeout: 5000 });
      if (data && data.length) return { data, provider: p.name };
    } catch (err) {
      console.warn(`Proxy ${p.name} skipped (invalid key or network error)`);
      // Continue to next provider
    }
  }

  // Final fallback: direct request with browser-like headers
  try {
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    ];

    const extraHeaders = {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Connection: 'keep-alive',
      Referer: 'https://www.zillow.com/',
    };

    for (const ua of userAgents) {
      try {
        const { data, status } = await axios.get(url, {
          timeout: 15000,
          headers: {
            'User-Agent': ua,
            ...extraHeaders,
          },
          validateStatus: (s) => s < 500,
        });
        if (status === 200 && data && data.length) return { data, provider: 'direct' };
      } catch (err) {
        // try next UA
      }
    }

    throw new Error(`All fetch attempts failed for ${url}`);
  } catch (err) {
    throw new Error(`All fetch attempts failed for ${url}: ${err.message}`);
  }
};

export const scrapeZillow = async (formattedAddress) => {
  try {
    console.log('--- Zillow Scraper Started ---');
    console.log('Formatted address:', formattedAddress);

    const searchURL = `https://www.zillow.com/homes/${encodeURIComponent(formattedAddress)}/`;
    console.log('Generated Zillow search URL:', searchURL);

    console.log('Fetching Zillow search page (with proxy fallback)...');
    const { data: searchHTML, provider: searchProvider } = await fetchWithFallback(searchURL);
    console.log(
      'Fetched search HTML length:',
      (searchHTML && searchHTML.length) || 0,
      'via',
      searchProvider
    );

    const $search = cheerio.load(searchHTML || '');

    let zpid = null;
    $search('script').each((_, el) => {
      const text = $search(el).html();
      if (!text) return;
      const m1 = text.match(/"zpid":\s*"?(\d+)"?/);
      const m2 = text.match(/"zpid"\s*:\s*(\d+)/);
      if (m1) zpid = m1[1];
      else if (m2) zpid = m2[1];
    });

    if (!zpid) {
      console.error('ZPID not found on search page.');
      return null;
    }
    console.log('ZPID found:', zpid);

    const propertyURL = `https://www.zillow.com/homedetails/${zpid}_zpid/`;
    console.log('Generated Zillow property URL:', propertyURL);

    console.log('Fetching Zillow property page (with proxy fallback)...');
    const { data: propertyHTML, provider: propertyProvider } = await fetchWithFallback(propertyURL);
    console.log(
      'Fetched property HTML length:',
      (propertyHTML && propertyHTML.length) || 0,
      'via',
      propertyProvider
    );

    const $details = cheerio.load(propertyHTML || '');
    const nextDataRaw = $details('#__NEXT_DATA__').html() || '';

    if (!nextDataRaw) {
      console.warn('__NEXT_DATA__ not found, will use alternative extraction');
    }

    let nextData = null;
    if (nextDataRaw) {
      try {
        nextData = JSON.parse(nextDataRaw);
        console.log('Parsed __NEXT_DATA__ JSON');
      } catch (err) {
        console.warn('Failed to parse __NEXT_DATA__ JSON');
      }
    }

    const findProperty = (obj) => {
      if (!obj || typeof obj !== 'object') return null;
      if (obj.zpid && (obj.price || obj.unformattedPrice || obj.zestimate || obj.homeType))
        return obj;
      for (const key in obj) {
        const result = findProperty(obj[key]);
        if (result) return result;
      }
      return null;
    };

    let property = null;
    if (nextData) {
      property = findProperty(nextData);
    }

    if (!property) {
      console.log('Attempting regex-based extraction from raw HTML...');

      // Extract from meta tags and JSON-LD (more reliable locations)
      const bedsMetaMatch = propertyHTML && propertyHTML.match(/zillow_fb:beds"\s+content="(\d+)"/);
      const bathsMetaMatch =
        propertyHTML && propertyHTML.match(/zillow_fb:baths"\s+content="([\d.]+)"/);
      const priceMatch = propertyHTML && propertyHTML.match(/"price"\s*:\s*(\d+)/);
      const zpidFromMatch = propertyHTML && propertyHTML.match(/"pid"\s*:\s*"?(\d+)/);
      const sqftMatch = propertyHTML && propertyHTML.match(/"floorSize":\{"[^}]*"value":(\d+)/);
      const addressMatch = propertyHTML && propertyHTML.match(/"streetAddress"\s*:\s*"([^"]+)"/);
      const cityMatch = propertyHTML && propertyHTML.match(/"city"\s*:\s*"([^"]+)"/);
      const stateMatch = propertyHTML && propertyHTML.match(/"state"\s*:\s*"([A-Z]{2})"/);
      const zipMatch = propertyHTML && propertyHTML.match(/"zipcode"\s*:\s*"(\d{5})"/);
      const yearMatch = propertyHTML && propertyHTML.match(/"yrblt"\s*:\s*"([^"]+)"/);
      const homeTypeMatch = propertyHTML && propertyHTML.match(/"homeType"\s*:\s*"([^"]+)"/);

      console.log(
        '[regex] beds:',
        bedsMetaMatch?.[1],
        'baths:',
        bathsMetaMatch?.[1],
        'price:',
        priceMatch?.[1]
      );

      if (bedsMetaMatch || bathsMetaMatch || priceMatch || zpidFromMatch) {
        console.log('Regex extraction successful');
        property = {
          zpid: zpidFromMatch ? zpidFromMatch[1] : null,
          price: priceMatch ? parseInt(priceMatch[1]) : null,
          bedrooms: bedsMetaMatch ? parseInt(bedsMetaMatch[1]) : null,
          bathrooms: bathsMetaMatch ? parseFloat(bathsMetaMatch[1]) : null,
          livingArea: sqftMatch ? parseInt(sqftMatch[1]) : null,
          streetAddress: addressMatch ? addressMatch[1] : null,
          city: cityMatch ? cityMatch[1] : null,
          state: stateMatch ? stateMatch[1] : null,
          zipcode: zipMatch ? zipMatch[1] : null,
          yearBuilt: yearMatch ? yearMatch[1] : null,
          homeType: homeTypeMatch ? homeTypeMatch[1] : null,
        };
      }
    }

    if (!property) {
      console.error('Property data not found.');
      return null;
    }

    console.log('Property data found');

    return {
      zpid: property.zpid || null,
      price: property.price || property.unformattedPrice || property.zestimate || null,
      beds: property.bedrooms || property.bedRoom || null,
      baths: property.bathrooms || property.bathRoom || null,
      sqft: property.livingArea || property.living_area || null,
      lotSize: property.lotSize || property.lot_area || null,
      yearBuilt: property.yearBuilt || property.year_built || null,
      propertyType: property.homeType || property.home_type || null,
      address: property.streetAddress || property.address || null,
      city: property.city || property.addressCity || null,
      state: property.state || null,
      zipcode: property.zipcode || property.postalCode || null,
      lastSoldDate: property.dateSold || null,
      lastSoldPrice:
        property.historical && property.historical.lastSoldPrice
          ? property.historical.lastSoldPrice
          : null,
    };
  } catch (err) {
    console.error('scrapeZillow error:', err.message);
    return null;
  }
};

export { fetchWithFallback };
