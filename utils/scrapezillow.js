// import axios from 'axios';
// import * as cheerio from 'cheerio';
// import { getEnv } from '../config/config.js';

// const safeGetEnv = (key) => {
//   try {
//     return getEnv(key);
//   } catch (err) {
//     return null;
//   }
// };

// const buildProxyUrl = (provider, apiKey, targetUrl, render = true) => {
//   if (!apiKey) return null;
//   if (provider === 'zenrows') {
//     return `https://api.zenrows.com/v1/?apikey=${apiKey}&url=${encodeURIComponent(
//       targetUrl
//     )}&js_render=${render}&m_proxy=true`;
//   }
//   if (provider === 'scraperapi') {
//     return `https://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(
//       targetUrl
//     )}&render=${render}`;
//   }
//   return null;
// };

// const fetchWithFallback = async (url) => {
//   const zenrowsKey = safeGetEnv('ZENROWS_API_KEY');
//   const scraperKey = safeGetEnv('SCRAPPER_API_KEY');

//   const providers = [];
//   // Only add providers if they have real, non-dummy keys
//   if (zenrowsKey && zenrowsKey.length > 20) providers.push({ name: 'zenrows', key: zenrowsKey });
//   if (scraperKey && scraperKey.length > 20) providers.push({ name: 'scraperapi', key: scraperKey });

//   // Try configured proxy providers first (with short timeout)
//   for (const p of providers) {
//     const proxyUrl = buildProxyUrl(p.name, p.key, url, true);
//     if (!proxyUrl) continue;
//     try {
//       const { data } = await axios.get(proxyUrl, { timeout: 5000 });
//       if (data && data.length) return { data, provider: p.name };
//     } catch (err) {
//       console.warn(`Proxy ${p.name} skipped (invalid key or network error)`);
//       // Continue to next provider
//     }
//   }

//   // Final fallback: direct request with browser-like headers
//   try {
//     const userAgents = [
//       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
//       'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15',
//       'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
//     ];

//     const extraHeaders = {
//       Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
//       'Accept-Language': 'en-US,en;q=0.9',
//       Connection: 'keep-alive',
//       Referer: 'https://www.zillow.com/',
//     };

//     for (const ua of userAgents) {
//       try {
//         const { data, status } = await axios.get(url, {
//           timeout: 15000,
//           headers: {
//             'User-Agent': ua,
//             ...extraHeaders,
//           },
//           validateStatus: (s) => s < 500,
//         });
//         if (status === 200 && data && data.length) return { data, provider: 'direct' };
//       } catch (err) {
//         // try next UA
//       }
//     }

//     throw new Error(`All fetch attempts failed for ${url}`);
//   } catch (err) {
//     throw new Error(`All fetch attempts failed for ${url}: ${err.message}`);
//   }
// };

// export const scrapeZillow = async (formattedAddress) => {
//   try {
//     console.log('--- Zillow Scraper Started ---');
//     console.log('Formatted address:', formattedAddress);

//     const searchURL = `https://www.zillow.com/homes/${encodeURIComponent(formattedAddress)}/`;
//     console.log('Generated Zillow search URL:', searchURL);

//     console.log('Fetching Zillow search page (with proxy fallback)...');
//     const { data: searchHTML, provider: searchProvider } = await fetchWithFallback(searchURL);
//     console.log(
//       'Fetched search HTML length:',
//       (searchHTML && searchHTML.length) || 0,
//       'via',
//       searchProvider
//     );

//     const $search = cheerio.load(searchHTML || '');

//     let zpid = null;
//     $search('script').each((_, el) => {
//       const text = $search(el).html();
//       if (!text) return;
//       const m1 = text.match(/"zpid":\s*"?(\d+)"?/);
//       const m2 = text.match(/"zpid"\s*:\s*(\d+)/);
//       if (m1) zpid = m1[1];
//       else if (m2) zpid = m2[1];
//     });

//     if (!zpid) {
//       console.error('ZPID not found on search page.');
//       return null;
//     }
//     console.log('ZPID found:', zpid);

//     const propertyURL = `https://www.zillow.com/homedetails/${zpid}_zpid/`;
//     console.log('Generated Zillow property URL:', propertyURL);

//     console.log('Fetching Zillow property page (with proxy fallback)...');
//     const { data: propertyHTML, provider: propertyProvider } = await fetchWithFallback(propertyURL);
//     console.log(
//       'Fetched property HTML length:',
//       (propertyHTML && propertyHTML.length) || 0,
//       'via',
//       propertyProvider
//     );

//     const $details = cheerio.load(propertyHTML || '');
//     const nextDataRaw = $details('#__NEXT_DATA__').html() || '';

//     if (!nextDataRaw) {
//       console.warn('__NEXT_DATA__ not found, will use alternative extraction');
//     }

//     let nextData = null;
//     if (nextDataRaw) {
//       try {
//         nextData = JSON.parse(nextDataRaw);
//         console.log('Parsed __NEXT_DATA__ JSON');
//       } catch (err) {
//         console.warn('Failed to parse __NEXT_DATA__ JSON');
//       }
//     }

//     const findProperty = (obj) => {
//       if (!obj || typeof obj !== 'object') return null;
//       if (obj.zpid && (obj.price || obj.unformattedPrice || obj.zestimate || obj.homeType))
//         return obj;
//       for (const key in obj) {
//         const result = findProperty(obj[key]);
//         if (result) return result;
//       }
//       return null;
//     };

//     let property = null;
//     if (nextData) {
//       property = findProperty(nextData);
//     }

//     if (!property) {
//       console.log('Attempting regex-based extraction from raw HTML...'); //

//       // Extract from meta tags and JSON-LD (more reliable locations)
//       const bedsMetaMatch = propertyHTML && propertyHTML.match(/zillow_fb:beds"\s+content="(\d+)"/);
//       const bathsMetaMatch =
//         propertyHTML && propertyHTML.match(/zillow_fb:baths"\s+content="([\d.]+)"/);
//       const priceMatch = propertyHTML && propertyHTML.match(/"price"\s*:\s*(\d+)/);
//       const zpidFromMatch = propertyHTML && propertyHTML.match(/"pid"\s*:\s*"?(\d+)/);
//       const sqftMatch = propertyHTML && propertyHTML.match(/"floorSize":\{"[^}]*"value":(\d+)/);
//       const addressMatch = propertyHTML && propertyHTML.match(/"streetAddress"\s*:\s*"([^"]+)"/);
//       const cityMatch = propertyHTML && propertyHTML.match(/"city"\s*:\s*"([^"]+)"/);
//       const stateMatch = propertyHTML && propertyHTML.match(/"state"\s*:\s*"([A-Z]{2})"/);
//       const zipMatch = propertyHTML && propertyHTML.match(/"zipcode"\s*:\s*"(\d{5})"/);
//       const yearMatch = propertyHTML && propertyHTML.match(/"yrblt"\s*:\s*"([^"]+)"/);
//       const homeTypeMatch = propertyHTML && propertyHTML.match(/"homeType"\s*:\s*"([^"]+)"/);

//       console.log(
//         //Regex can only find text that actually exists in the HTML file
//         '[regex] beds:',
//         bedsMetaMatch?.[1],
//         'baths:',
//         bathsMetaMatch?.[1],
//         'price:',
//         priceMatch?.[1]
//       );

//       if (bedsMetaMatch || bathsMetaMatch || priceMatch || zpidFromMatch) {
//         console.log('Regex extraction successful');
//         property = {
//           zpid: zpidFromMatch ? zpidFromMatch[1] : null,
//           price: priceMatch ? parseInt(priceMatch[1]) : null,
//           bedrooms: bedsMetaMatch ? parseInt(bedsMetaMatch[1]) : null,
//           bathrooms: bathsMetaMatch ? parseFloat(bathsMetaMatch[1]) : null,
//           livingArea: sqftMatch ? parseInt(sqftMatch[1]) : null,
//           streetAddress: addressMatch ? addressMatch[1] : null,
//           city: cityMatch ? cityMatch[1] : null,
//           state: stateMatch ? stateMatch[1] : null,
//           zipcode: zipMatch ? zipMatch[1] : null,
//           yearBuilt: yearMatch ? yearMatch[1] : null,
//           homeType: homeTypeMatch ? homeTypeMatch[1] : null,
//         };
//       }
//     }

//     if (!property) {
//       console.error('Property data not found.');
//       return null;
//     }

//     console.log('Property data found');

//     return {
//       zpid: property.zpid || null,
//       price: property.price || property.unformattedPrice || property.zestimate || null,
//       beds: property.bedrooms || property.bedRoom || null,
//       baths: property.bathrooms || property.bathRoom || null,
//       sqft: property.livingArea || property.living_area || null,
//       lotSize: property.lotSize || property.lot_area || null,
//       yearBuilt: property.yearBuilt || property.year_built || null,
//       propertyType: property.homeType || property.home_type || null,
//       address: property.streetAddress || property.address || null,
//       city: property.city || property.addressCity || null,
//       state: property.state || null,
//       zipcode: property.zipcode || property.postalCode || null,
//       lastSoldDate: property.dateSold || null,
//       lastSoldPrice:
//         property.historical && property.historical.lastSoldPrice
//           ? property.historical.lastSoldPrice
//           : null,
//     };
//   } catch (err) {
//     console.error('scrapeZillow error:', err.message);
//     return null;
//   }
// };

// export { fetchWithFallback };

//2nd way

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

const buildProxyUrl = (apiKey, targetUrl, render = true) => {
  if (!apiKey) return null;
  return `https://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(
    targetUrl
  )}&render=${render}`;
};

const fetchWithFallback = async (url) => {
  const scraperKey = safeGetEnv('SCRAPPER_API_KEY');

  // Try ScraperAPI first
  if (scraperKey && scraperKey.length > 20) {
    const proxyUrl = buildProxyUrl(scraperKey, url, true);
    try {
      const { data } = await axios.get(proxyUrl, { timeout: 5000 });
      if (data && data.length) return { data, provider: 'scraperapi' };
    } catch (err) {
      console.warn('ScraperAPI failed (invalid key or network error)');
    }
  }

  // Fallback: direct request with browser-like headers
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

    // Puppeteer fallback: try headless browser to render JS-heavy pages
    try {
      let mod;
      try {
        mod = await import('puppeteer');
      } catch (e) {
        // dynamic import failed (module not installed)
        throw new Error('puppeteer not installed');
      }
      const puppeteer = mod.default || mod;
      const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      const page = await browser.newPage();
      await page.setUserAgent(userAgents[0]);
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://www.zillow.com/',
      });
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      const content = await page.content();
      await browser.close();
      if (content && content.length) return { data: content, provider: 'puppeteer' };
    } catch (err) {
      console.warn('Puppeteer fallback skipped or failed:', err.message);
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

    let nextData = null;
    if (nextDataRaw) {
      try {
        nextData = JSON.parse(nextDataRaw);
        console.log('Parsed __NEXT_DATA__ JSON');
      } catch (err) {
        console.warn('Failed to parse __NEXT_DATA__ JSON');
      }
    }

    // --- Robust JSON and HTML extraction ---
    let property = null;

    const isObject = (v) => v && typeof v === 'object';

    // deep walker to find an object that looks like a property
    const findCandidate = (obj, seen = new WeakSet()) => {
      if (!isObject(obj) || seen.has(obj)) return null;
      seen.add(obj);

      const keys = Object.keys(obj);
      const hasZpid = keys.includes('zpid');
      const hasAddress = isObject(obj.address) && (obj.address.streetAddress || obj.address.street);
      const hasCommon =
        keys.includes('price') ||
        keys.includes('bedrooms') ||
        keys.includes('bathrooms') ||
        keys.includes('homeType') ||
        keys.includes('livingArea');

      if (hasZpid || hasAddress || hasCommon) return obj;

      for (const k of keys) {
        try {
          const res = findCandidate(obj[k], seen);
          if (res) return res;
        } catch (e) {
          // ignore
        }
      }
      return null;
    };

    if (nextData) {
      property = findCandidate(nextData);
      // fallbacks for common nextData paths
      if (!property)
        property =
          nextData.props?.pageProps?.property ||
          nextData.props?.pageProps?.hdp ||
          nextData.props?.initialState?.property ||
          null;
    }

    // If we found nextData-based property, try to fill specific fields by searching nextData globally
    const deepFind = (obj, candidates = []) => {
      if (!isObject(obj)) return null;
      const seen = new Set();
      const stack = [obj];
      while (stack.length) {
        const cur = stack.pop();
        // skip primitives early
        if (!isObject(cur)) continue;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const k of Object.keys(cur)) {
          if (candidates.includes(k) && cur[k] != null) return cur[k];
          try {
            stack.push(cur[k]);
          } catch (e) {}
        }
      }
      return null;
    };

    // regex/text fallbacks (look for lotsize, year built, property type in HTML)
    const htmlLotMatch = propertyHTML?.match(
      /Lot Size[:\s]*([0-9.,]+\s*(?:acre|acres|sqft|sq ft|ft2))/i
    );
    const htmlYearMatch =
      propertyHTML?.match(/Year Built[:\s]*([0-9]{3,4})/i) ||
      propertyHTML?.match(/Built in\s*([0-9]{3,4})/i);
    const htmlTypeMatch =
      propertyHTML?.match(/Property Type[:\s]*([A-Za-z\s]+)/i) ||
      propertyHTML?.match(/Home Type[:\s]*([A-Za-z\s]+)/i);

    // Try to extract values from nextData if still missing
    if (!property) {
      // Attempt to extract minimal info from HTML regexes to build a property object
      const bedsMetaMatch = propertyHTML?.match(/(\d+)\s+bd/);
      const bathsMetaMatch = propertyHTML?.match(/(\d+(?:\.\d+)?)\s+ba/);
      const priceMatch = propertyHTML?.match(/\$([0-9,]+)/);
      const sqftMatch = propertyHTML?.match(/([0-9,]+)\s+sqft/i);

      if (bedsMetaMatch || bathsMetaMatch || priceMatch) {
        property = {
          zpid: zpid || null,
          price: priceMatch ? parseInt(priceMatch[1].replace(/,/g, ''), 10) : null,
          bedrooms: bedsMetaMatch ? parseInt(bedsMetaMatch[1], 10) : null,
          bathrooms: bathsMetaMatch ? parseFloat(bathsMetaMatch[1]) : null,
          livingArea: sqftMatch ? parseInt(sqftMatch[1].replace(/,/g, ''), 10) : null,
        };
      }
    }

    // If we have some property object, try to augment missing fields by scanning nextData
    if (property) {
      // keys we want to locate
      const lotCandidate = deepFind(nextData, [
        'lotSize',
        'lot_area',
        'lot',
        'lotArea',
        'lotSizeSqFt',
      ]);
      const yrCandidate = deepFind(nextData, ['yearBuilt', 'year_built', 'yrblt', 'year']);
      const typeCandidate = deepFind(nextData, [
        'homeType',
        'home_type',
        'propertyType',
        'property_type',
        'propertySubType',
      ]);
      const sqftCandidate = deepFind(nextData, ['livingArea', 'finishedSqFt', 'sqft', 'floorSize']);

      if (!property.livingArea && sqftCandidate) property.livingArea = sqftCandidate;
      if (!property.lotSize && lotCandidate) property.lotSize = lotCandidate;
      if (!property.yearBuilt && yrCandidate) property.yearBuilt = yrCandidate;
      if (!property.homeType && typeCandidate) property.homeType = typeCandidate;

      // HTML fallbacks
      if (!property.lotSize && htmlLotMatch) property.lotSize = htmlLotMatch[1];
      if (!property.yearBuilt && htmlYearMatch) property.yearBuilt = htmlYearMatch[1];
      if (!property.homeType && htmlTypeMatch) property.homeType = htmlTypeMatch[1].trim();
    }

    if (!property) {
      console.error('Property data not found.');
      return null;
    }

    console.log('Property data found (keys):', Object.keys(property));

    // Merge common Zillow locations into the property object when fields missing
    const mergeFrom = (src) => {
      if (!isObject(src)) return;
      if (!property.price && (src.price || src.unformattedPrice || src.zestimate)) {
        property.price =
          src.price || src.unformattedPrice || (src.zestimate && src.zestimate.amount) || null;
      }
      if (!property.bedrooms && (src.bedrooms || src.bedRoom))
        property.bedrooms = src.bedrooms || src.bedRoom;
      if (!property.bathrooms && (src.bathrooms || src.bathRoom))
        property.bathrooms = src.bathrooms || src.bathRoom;
      if (!property.livingArea && (src.livingArea || src.finishedSqFt || src.floorSize || src.sqft))
        property.livingArea = src.livingArea || src.finishedSqFt || src.floorSize || src.sqft;
      if (!property.lotSize && (src.lotSize || src.lot_area || src.lot || src.lotArea))
        property.lotSize = src.lotSize || src.lot_area || src.lot || src.lotArea;
      if (!property.yearBuilt && (src.yearBuilt || src.year_built || src.yrblt))
        property.yearBuilt = src.yearBuilt || src.year_built || src.yrblt;
      if (!property.homeType && (src.homeType || src.home_type || src.propertyType))
        property.homeType = src.homeType || src.home_type || src.propertyType;
    };

    // Common paths in Zillow's __NEXT_DATA__
    try {
      mergeFrom(nextData.props?.pageProps?.hdp?.homeInfo);
      mergeFrom(nextData.props?.pageProps?.hdp);
      mergeFrom(nextData.props?.pageProps?.property || nextData.props?.pageProps?.propertyInfo);
      mergeFrom(nextData.props?.pageProps?.listing || nextData.props?.pageProps?.listingInfo);

      // gdpClientCache: merge all contained objects — many Zillow fields live here
      const maybeGdp =
        nextData.gdpClientCache || nextData.props?.pageProps?.componentProps?.gdpClientCache;
      if (maybeGdp) {
        let gdpObj = maybeGdp;
        if (typeof maybeGdp === 'string') {
          try {
            gdpObj = JSON.parse(maybeGdp);
          } catch (e) {
            // try to unescape common double-escaped forms
            try {
              gdpObj = JSON.parse(maybeGdp.replace(/^"|"$/g, '').replace(/\\"/g, '"'));
            } catch (ee) {
              gdpObj = null;
            }
          }
        }

        if (gdpObj && isObject(gdpObj)) {
          try {
            const keys = Object.keys(gdpObj);
            console.log('gdpClientCache keys:', keys.slice(0, 50));
            const mergeDeep = (obj, seen = new Set()) => {
              if (!isObject(obj) || seen.has(obj)) return;
              seen.add(obj);
              try {
                mergeFrom(obj);
              } catch (e) {}
              for (const kk of Object.keys(obj)) {
                try {
                  mergeDeep(obj[kk], seen);
                } catch (e) {}
              }
            };

            for (const k of keys) {
              try {
                const val = gdpObj[k];
                mergeDeep(val);
              } catch (e) {
                // ignore per-key errors
              }
            }
          } catch (e) {
            // ignore
          }
        }
      }
    } catch (e) {
      // ignore merging errors
    }

    // Normalize numeric and string values for downstream usage
    const normalizeNumber = (v) => {
      if (v == null) return null;
      if (typeof v === 'number') return v;
      const s = String(v);
      const m = s.match(/([0-9,]+(\.[0-9]+)?)/);
      if (!m) return null;
      return parseInt(m[1].replace(/,/g, ''), 10) || null;
    };

    const parseLotSize = (v) => {
      if (v == null) return null;
      if (typeof v === 'number') return v;
      const s = String(v).toLowerCase();
      // acres -> sqft
      const acresMatch = s.match(/([0-9,.]+)\s*acre/);
      if (acresMatch) return Math.round(parseFloat(acresMatch[1].replace(/,/g, '')) * 43560);
      const sqftMatch = s.match(/([0-9,]+)\s*(sqft|ft2)/);
      if (sqftMatch) return parseInt(sqftMatch[1].replace(/,/g, ''), 10) || null;
      // fallback to any number in string
      return normalizeNumber(s);
    };

    const squareFootage =
      normalizeNumber(property.livingArea) ||
      normalizeNumber(property.living_area) ||
      normalizeNumber(property.sqft) ||
      null;

    const normalizedLot = parseLotSize(property.lotSize || property.lot_area || property.lot);

    const normalizedYear = (() => {
      const y = property.yearBuilt || property.year_built || property.yrblt || property.year;
      const n = normalizeNumber(y);
      return n && n > 1000 ? n : null;
    })();

    const normalizedPropertyType =
      property.homeType || property.home_type || property.propertyType || property['@type'] || null;

    // --- Extract last-sold info from multiple locations (price history, resoFacts, common fields)
    const extractLastSold = () => {
      let lastSoldPrice = null;
      let lastSoldDate = null;

      // direct common fields
      const directPrice = deepFind(nextData, ['lastSoldPrice', 'lastSold', 'last_sold_price']);
      const directDate = deepFind(nextData, [
        'lastSoldDate',
        'dateSold',
        'dateSoldString',
        'last_sold_date',
      ]);
      if (directPrice) lastSoldPrice = normalizeNumber(directPrice);
      if (directDate) lastSoldDate = String(directDate);

      // resoFacts often contains last sold info
      try {
        const reso = deepFind(nextData, ['resoFacts', 'res0Facts', 'resFacts']);
        if (reso && typeof reso === 'object') {
          if (!lastSoldPrice && (reso.lastSoldPrice || reso.lastsoldprice))
            lastSoldPrice = normalizeNumber(reso.lastSoldPrice || reso.lastsoldprice);
          if (!lastSoldDate && (reso.dateSold || reso.date_sold || reso.dateSoldString))
            lastSoldDate = reso.dateSold || reso.dateSoldString || reso.date_sold || lastSoldDate;
        }
      } catch (e) {}

      // priceHistory arrays: look for the most recent 'Sold'/'Sale' event
      try {
        const ph =
          deepFind(nextData, [
            'priceHistory',
            'priceHistoryByDate',
            'price_events',
            'priceEvents',
            'priceHistoryData',
          ]) || null;
        if (Array.isArray(ph) && ph.length) {
          for (let i = ph.length - 1; i >= 0; i--) {
            const ev = ph[i];
            if (!ev) continue;
            const type = String(
              ev.eventType || ev.type || ev.event || ev.typeName || ''
            ).toLowerCase();
            const evPrice = ev.price || ev.amount || ev.soldPrice || ev.value;
            const evDate = ev.date || ev.dateString || ev.eventDate || ev.transactionDate;
            if (type.includes('sold') || type.includes('sale')) {
              if (!lastSoldPrice && evPrice) lastSoldPrice = normalizeNumber(evPrice);
              if (!lastSoldDate && evDate) lastSoldDate = String(evDate);
              break;
            }
          }
        }
      } catch (e) {}

      return { lastSoldPrice: lastSoldPrice || null, lastSoldDate: lastSoldDate || null };
    };

    const { lastSoldPrice, lastSoldDate } = extractLastSold();

    return {
      zpid: property.zpid || null,
      price: property.price || property.unformattedPrice || property.zestimate || null,
      beds: property.bedrooms || property.bedRoom || null,
      baths: property.bathrooms || property.bathRoom || null,
      // keep legacy key
      sqft: squareFootage,
      // preferred name used by controller
      squareFootage: squareFootage,
      lotSize: normalizedLot,
      yearBuilt: normalizedYear,
      propertyType: normalizedPropertyType,
      address: property.streetAddress || property.address || null,
      city: property.city || property.addressCity || null,
      state: property.state || null,
      zipcode: property.zipcode || property.postalCode || null,
      lastSoldDate: lastSoldDate || property.dateSold || null,
      lastSoldPrice: lastSoldPrice || property.historical?.lastSoldPrice || null,
    };
  } catch (err) {
    console.error('scrapeZillow error:', err.message);
    return null;
  }
};

export { fetchWithFallback };
