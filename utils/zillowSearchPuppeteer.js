// import puppeteer from 'puppeteer';

// const userAgents = [
//   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
//   'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/16.0 Safari/605.1.15',
//   'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Version/16.0 Mobile/15E148 Safari/604.1',
// ];

// // Fallback: Extract property data from HTML if JSON parsing fails
// const extractPropertiesFromHTML = async (page, limit) => {
//   console.log('🔄 Trying fallback HTML extraction...');
//   try {
//     const properties = await page.evaluate((limit) => {
//       const propertyCards = document.querySelectorAll('[data-test-id="property-card"]');
//       const results = [];

//       propertyCards.forEach((card, idx) => {
//         if (idx >= limit) return;

//         const addressEl = card.querySelector('[data-test-id="property-address"]');
//         const priceEl = card.querySelector('[data-test="price"]');
//         const bedsEl = card.querySelector('[data-test-id="property-beds"]');
//         const bathsEl = card.querySelector('[data-test-id="property-baths"]');
//         const sqftEl = card.querySelector('[data-test-id="property-sqft"]');

//         if (addressEl) {
//           results.push({
//             zpid: null,
//             address: addressEl.textContent?.trim() || null,
//             price: priceEl?.textContent?.trim() || null,
//             beds: bedsEl?.textContent?.match(/\d+/)?.[0] || null,
//             baths: bathsEl?.textContent?.match(/\d+/)?.[0] || null,
//             sqft: sqftEl?.textContent?.match(/\d+/)?.[0] || null,
//             latitude: null,
//             longitude: null,
//             status: null,
//           });
//         }
//       });

//       return results;
//     }, limit);

//     if (properties.length > 0) {
//       console.log('✅ Fallback extraction successful:', properties.length);
//       return properties;
//     }
//   } catch (err) {
//     console.error('❌ Fallback extraction failed:', err.message);
//   }

//   return [];
// };

// // export const scrapeZillowSearch = async (filters, limit = 20, proxy = null) => {
// //   const { minPrice, maxPrice, minSqft, maxSqft, propertyType, isSold } = filters;

// //   let url = 'https://www.zillow.com/homes/for_sale/';

// //   // Build URL with filters
// //   const filterParts = [];
// //   if (minPrice || maxPrice) filterParts.push(`${minPrice || 0}-${maxPrice || ''}_price`);
// //   if (minSqft || maxSqft) filterParts.push(`${minSqft || 0}-${maxSqft || ''}_size`);
// //   if (propertyType) filterParts.push(`${propertyType}`);
// //   url += filterParts.join('/') + '/';
// //   url += isSold === 'true' ? 'sold/' : 'for_sale/';

// //   console.log('🚀 Zillow URL:', url);
// //   console.log('📋 Filters:', { minPrice, maxPrice, minSqft, maxSqft, propertyType, isSold, limit });

// //   const launchOptions = {
// //     headless: 'new',
// //     args: [
// //       '--no-sandbox',
// //       '--disable-setuid-sandbox',
// //       '--disable-blink-features=AutomationControlled', // Hide automation
// //       '--disable-dev-shm-usage',
// //     ],
// //   };

// //   if (proxy && proxy.startsWith('http')) {
// //     console.log('🌐 Using proxy:', proxy);
// //     launchOptions.args.push(`--proxy-server=${proxy}`);
// //   }

// //   const browser = await puppeteer.launch(launchOptions);

// //   try {
// //     const page = await browser.newPage();

// //     // Block unnecessary resources to speed up loading
// //     await page.setRequestInterception(true);
// //     page.on('request', (req) => {
// //       const resourceType = req.resourceType();
// //       if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
// //         req.abort();
// //       } else {
// //         req.continue();
// //       }
// //     });

// //     // Random User-Agent
// //     const ua = userAgents[Math.floor(Math.random() * userAgents.length)];
// //     await page.setUserAgent(ua);
// //     await page.setViewport({ width: 1920, height: 1080 });
// //     await page.setExtraHTTPHeaders({
// //       'Accept-Language': 'en-US,en;q=0.9',
// //       'Accept-Encoding': 'gzip, deflate, br',
// //       Referer: 'https://www.zillow.com/',
// //     });

// //     console.log('🌐 Navigating to Zillow...');
// //     try {
// //       // Prefer domcontentloaded for faster timeout
// //       await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
// //     } catch (err) {
// //       console.warn('⚠️ Page did not load in 60s, trying networkidle2...');
// //       try {
// //         await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
// //       } catch (err2) {
// //         console.warn('⚠️ Page still did not load. Continuing anyway...');
// //       }
// //     }

// //     // Wait for JS-rendered content
// //     await new Promise((resolve) => setTimeout(resolve, 4000));

// //     console.log('🔍 Extracting properties via __NEXT_DATA__...');
// //     const properties = await page.evaluate((limit) => {
// //       const el = document.querySelector('#__NEXT_DATA__');
// //       if (!el) return [];

// //       let json;
// //       try {
// //         json = JSON.parse(el.innerText);
// //       } catch (err) {
// //         console.error('Failed to parse JSON:', err.message);
// //         return [];
// //       }

// //       let results = [];
// //       const paths = [
// //         json.props?.pageProps?.searchPageState?.cat1?.searchResults?.mapResults,
// //         json.props?.pageProps?.listData?.mapResults,
// //         json.props?.pageProps?.cat1?.searchResults?.mapResults,
// //         json.props?.pageProps?.searchResults?.results,
// //       ];

// //       for (const path of paths) {
// //         if (Array.isArray(path) && path.length > 0) {
// //           results = path;
// //           console.log('✅ Found results at path:', path.length);
// //           break;
// //         }
// //       }

// //       if (results.length === 0) {
// //         console.error('⚠️ No results found at any path');
// //         console.log('Available JSON structure:', Object.keys(json));
// //         return [];
// //       }

// //       return results.slice(0, limit).map((p) => ({
// //         zpid: p.zpid,
// //         address: p.address || null,
// //         price: p.price || null,
// //         beds: p.bedrooms || null,
// //         baths: p.bathrooms || null,
// //         sqft: p.livingArea || null,
// //         latitude: p.latLong?.latitude || null,
// //         longitude: p.latLong?.longitude || null,
// //         status: p.statusType || null,
// //       }));
// //     }, limit);

// //     console.log('✅ Properties extracted:', properties.length);

// //     // Fallback HTML extraction
// //     if (properties.length === 0) {
// //       console.warn('⚠️ No properties found via JSON. Trying HTML fallback...');
// //       const fallbackProperties = await extractPropertiesFromHTML(page, limit);
// //       if (fallbackProperties.length > 0) {
// //         console.log('✅ Fallback extraction successful:', fallbackProperties.length);
// //         return fallbackProperties;
// //       }
// //       console.warn(
// //         '⚠️ No properties found. Could be due to filters, JSON change, page load, or anti-bot.'
// //       );
// //     }

// //     return properties;
// //   } catch (err) {
// //     console.error('❌ Puppeteer search error:', err.message);
// //     return [];
// //   } finally {
// //     await browser.close();
// //     console.log('🟢 Browser closed');
// //   }
// // };

// export const scrapeZillowSearch = async (filters, limit = 20, proxy = null) => {
//   const { minPrice, maxPrice, minSqft, maxSqft, propertyType, isSold } = filters;

//   let url = 'https://www.zillow.com/homes/for_sale/';
//   const filterParts = [];
//   if (minPrice || maxPrice) filterParts.push(`${minPrice || 0}-${maxPrice || ''}_price`);
//   if (minSqft || maxSqft) filterParts.push(`${minSqft || 0}-${maxSqft || ''}_size`);
//   if (propertyType) filterParts.push(`${propertyType}`);
//   url += filterParts.join('/') + '/';
//   url += isSold === 'true' ? 'sold/' : 'for_sale/';

//   console.log('🚀 Zillow URL:', url);
//   console.log('📋 Filters:', { minPrice, maxPrice, minSqft, maxSqft, propertyType, isSold, limit });

//   const launchOptions = { headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] };
//   if (proxy) launchOptions.args.push(`--proxy-server=${proxy}`);

//   const browser = await puppeteer.launch(launchOptions);

//   try {
//     const page = await browser.newPage();

//     // -------------------------------
//     // 1️⃣ Set user-agent and block images/fonts
//     // -------------------------------
//     await page.setUserAgent(userAgents[Math.floor(Math.random() * userAgents.length)]);
//     await page.setViewport({ width: 1920, height: 1080 });
//     await page.setRequestInterception(true);
//     page.on('request', (req) => {
//       if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
//       else req.continue();
//     });

//     // -------------------------------
//     // 2️⃣ Go to Zillow page
//     // -------------------------------
//     await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });

//     // -------------------------------
//     // 3️⃣ Take screenshot for debugging
//     // -------------------------------
//     await page.screenshot({ path: 'debug.png', fullPage: true });
//     console.log('📸 Screenshot saved as debug.png');

//     // -------------------------------
//     // 4️⃣ Try JSON extraction
//     // -------------------------------
//     const properties = await page.evaluate((limit) => {
//       const el = document.querySelector('#__NEXT_DATA__');
//       if (!el) return [];
//       let json;
//       try {
//         json = JSON.parse(el.innerText);
//       } catch {
//         return [];
//       }

//       let results = [];
//       const paths = [
//         json.props?.pageProps?.searchPageState?.cat1?.searchResults?.mapResults,
//         json.props?.pageProps?.listData?.mapResults,
//         json.props?.pageProps?.cat1?.searchResults?.mapResults,
//         json.props?.pageProps?.searchResults?.results,
//       ];
//       for (const path of paths)
//         if (Array.isArray(path) && path.length > 0) {
//           results = path;
//           break;
//         }
//       return results.slice(0, limit).map((p) => ({
//         zpid: p.zpid,
//         address: p.address || null,
//         price: p.price || null,
//         beds: p.bedrooms || null,
//         baths: p.bathrooms || null,
//         sqft: p.livingArea || null,
//         latitude: p.latLong?.latitude || null,
//         longitude: p.latLong?.longitude || null,
//         status: p.statusType || null,
//       }));
//     }, limit);

//     // -------------------------------
//     // 5️⃣ If JSON fails, use HTML fallback
//     // -------------------------------
//     if (properties.length === 0) {
//       console.warn('⚠️ JSON extraction failed. Trying HTML fallback...');
//       const fallbackProperties = await page.evaluate((limit) => {
//         const propertyCards = document.querySelectorAll('[data-test="property-card"]'); // <-- Update selector if needed
//         const results = [];
//         propertyCards.forEach((card, idx) => {
//           if (idx >= limit) return;
//           const addressEl = card.querySelector('[data-test="property-address"]'); // <-- Update selector
//           const priceEl = card.querySelector('[data-test="price"]'); // <-- Update selector
//           const bedsEl = card.querySelector('[data-test="property-beds"]'); // <-- Update selector
//           const bathsEl = card.querySelector('[data-test="property-baths"]'); // <-- Update selector
//           const sqftEl = card.querySelector('[data-test="property-sqft"]'); // <-- Update selector

//           if (addressEl) {
//             results.push({
//               zpid: null,
//               address: addressEl.textContent?.trim() || null,
//               price: priceEl?.textContent?.trim() || null,
//               beds: bedsEl?.textContent?.match(/\d+/)?.[0] || null,
//               baths: bathsEl?.textContent?.match(/\d+/)?.[0] || null,
//               sqft: sqftEl?.textContent?.match(/\d+/)?.[0] || null,
//               latitude: null,
//               longitude: null,
//               status: null,
//             });
//           }
//         });
//         return results;
//       }, limit);

//       if (fallbackProperties.length > 0) return fallbackProperties;
//       console.warn('⚠️ No properties found. Check debug.png and update selectors.');
//     }

//     return properties;
//   } catch (err) {
//     console.error('❌ Puppeteer search error:', err.message);
//     return [];
//   } finally {
//     await browser.close();
//     console.log('🟢 Browser closed');
//   }
// };

import puppeteer from 'puppeteer';

const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/16.0 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Version/16.0 Mobile/15E148 Safari/604.1',
];

export const scrapeZillowSearch = async (filters, limit = 20, proxy = null) => {
  const { minPrice, maxPrice, minSqft, maxSqft, propertyType, isSold } = filters;

  // Build Zillow URL with filters
  let url = 'https://www.zillow.com/homes/for_sale/';
  const filterParts = [];
  if (minPrice || maxPrice) filterParts.push(`${minPrice || 0}-${maxPrice || ''}_price`);
  if (minSqft || maxSqft) filterParts.push(`${minSqft || 0}-${maxSqft || ''}_size`);
  if (propertyType) filterParts.push(`${propertyType}`);
  url += filterParts.join('/') + '/';
  url += isSold === 'true' ? 'sold/' : 'for_sale/';

  console.log('🚀 Zillow URL:', url);
  console.log('📋 Filters:', { minPrice, maxPrice, minSqft, maxSqft, propertyType, isSold, limit });

  // Launch browser in non-headless mode
  const launchOptions = {
    headless: false,
    defaultViewport: null,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  };
  if (proxy) launchOptions.args.push(`--proxy-server=${proxy}`);

  const browser = await puppeteer.launch(launchOptions);

  try {
    const page = await browser.newPage();

    // -------------------------------
    // 1️⃣ Set User-Agent and block only media
    // -------------------------------
    await page.setUserAgent(userAgents[Math.floor(Math.random() * userAgents.length)]);
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    // -------------------------------
    // 2️⃣ Go to Zillow page
    // -------------------------------
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

    // -------------------------------
    // 3️⃣ Pause for human CAPTCHA
    // -------------------------------
    console.log('🧑‍💻 Please solve the "Press & Hold" CAPTCHA in the opened browser...');
    await new Promise((resolve) => setTimeout(resolve, 60000));

    // -------------------------------
    // 4️⃣ Take screenshot for debugging
    // -------------------------------
    await page.screenshot({ path: 'debug.png', fullPage: true });
    console.log('📸 Screenshot saved as debug.png');

    // -------------------------------
    // 5️⃣ Try JSON extraction first
    // -------------------------------
    let properties = await page.evaluate((limit) => {
      const el = document.querySelector('#__NEXT_DATA__');
      if (!el) return [];
      let json;
      try {
        json = JSON.parse(el.innerText);
      } catch {
        return [];
      }

      let results = [];
      const paths = [
        json.props?.pageProps?.searchPageState?.cat1?.searchResults?.mapResults,
        json.props?.pageProps?.listData?.mapResults,
        json.props?.pageProps?.cat1?.searchResults?.mapResults,
        json.props?.pageProps?.searchResults?.results,
      ];
      for (const path of paths)
        if (Array.isArray(path) && path.length > 0) {
          results = path;
          break;
        }

      return results.slice(0, limit).map((p) => ({
        zpid: p.zpid || null,
        address: p.address || null,
        price: p.price || null,
        beds: p.bedrooms || null,
        baths: p.bathrooms || null,
        sqft: p.livingArea || null,
        latitude: p.latLong?.latitude || null,
        longitude: p.latLong?.longitude || null,
        status: p.statusType || null,
      }));
    }, limit);

    // -------------------------------
    // 6️⃣ Fallback: HTML extraction if JSON fails
    // -------------------------------
    if (properties.length === 0) {
      console.warn('⚠️ JSON extraction failed. Trying HTML fallback...');
      properties = await page.evaluate((limit) => {
        const cards = document.querySelectorAll('[data-test="property-card"]');
        const results = [];
        cards.forEach((card, idx) => {
          if (idx >= limit) return;
          const addressEl = card.querySelector('[data-test="property-address"]');
          const priceEl = card.querySelector('[data-test="price"]');
          const bedsEl = card.querySelector('[data-test="property-beds"]');
          const bathsEl = card.querySelector('[data-test="property-baths"]');
          const sqftEl = card.querySelector('[data-test="property-sqft"]');

          if (addressEl) {
            results.push({
              zpid: null,
              address: addressEl.textContent?.trim() || null,
              price: priceEl?.textContent?.trim() || null,
              beds: bedsEl?.textContent?.match(/\d+/)?.[0] || null,
              baths: bathsEl?.textContent?.match(/\d+/)?.[0] || null,
              sqft: sqftEl?.textContent?.match(/\d+/)?.[0] || null,
              latitude: null,
              longitude: null,
              status: null,
            });
          }
        });
        return results;
      }, limit);

      if (properties.length === 0)
        console.warn('⚠️ No properties found. Check debug.png and update selectors.');
    }

    console.log('✅ Properties extracted:', properties.length);
    return properties;
  } catch (err) {
    console.error('❌ Puppeteer search error:', err.message);
    return [];
  } finally {
    await browser.close();
    console.log('🟢 Browser closed');
  }
};
