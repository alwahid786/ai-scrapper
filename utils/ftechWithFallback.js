import axios from 'axios';
import { getEnv } from '../config/config.js';

const safeGetEnv = (key) => {
  try {
    return getEnv(key);
  } catch {
    return null;
  }
};

const buildProxyUrl = (apiKey, targetUrl, render = true) =>
  `https://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(
    targetUrl
  )}&render=${render}`;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1',
];

export const fetchWithFallback = async (url) => {
  console.log('--- fetchWithFallback START ---');
  console.log('Target URL:', url);

  const scraperKey = safeGetEnv('SCRAPPER_API_KEY');

  if (scraperKey && scraperKey.length > 20) {
    console.log('Trying ScraperAPI...');
    try {
      const proxyUrl = buildProxyUrl(scraperKey, url, true);
      const res = await axios.get(proxyUrl, { timeout: 8000 });
      console.log('ScraperAPI status:', res.status);

      if (res.data?.length) {
        console.log('✅ ScraperAPI SUCCESS');
        return { data: res.data, provider: 'scraperapi' };
      }
    } catch (err) {
      console.warn('❌ ScraperAPI FAILED:', err.message);
    }
  } else {
    console.warn('⚠️ ScraperAPI key missing or invalid');
  }

  // AXIOS FALLBACK

  console.log('➡️ Moving to AXIOS fallback');

  for (const ua of USER_AGENTS) {
    try {
      console.log('Trying Axios UA:', ua.slice(0, 40));
      const res = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': ua,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: 'https://www.zillow.com/',
        },
        validateStatus: (s) => s < 500,
      });

      console.log('Axios status:', res.status);

      if (res.status === 200 && res.data?.length) {
        console.log('✅ AXIOS SUCCESS');
        return { data: res.data, provider: 'axios' };
      }
    } catch (err) {
      console.warn('Axios UA failed:', err.message);
    }
  }

  /* ==============================
     3️⃣ PUPPETEER FALLBACK
  ============================== */
  console.log('➡️ Moving to PUPPETEER fallback');

  try {
    const mod = await import('puppeteer');
    const puppeteer = mod.default || mod;

    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENTS[0]);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    const html = await page.content();
    await browser.close();

    if (html?.length) {
      console.log('✅ PUPPETEER SUCCESS');
      return { data: html, provider: 'puppeteer' };
    }
  } catch (err) {
    console.warn('❌ Puppeteer FAILED:', err.message);
  }

  /* ==============================
     4️⃣ NEVER CRASH
  ============================== */
  console.warn('⚠️ All fetch attempts failed — returning empty HTML');
  return { data: '', provider: 'none' };
};
