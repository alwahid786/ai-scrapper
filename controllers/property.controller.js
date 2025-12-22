import Property from '../models/property.js';
import { normalizeAddress } from '../utils/addressUtils.js';
import { scrapeZillow } from '../utils/scrapezillow.js';
import { scrapeZillowSearch } from '../utils/zillowSearchPuppeteer.js';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const address = async (req, res) => {
  try {
    const { address } = req.body;
    if (!address) return res.status(400).json({ error: 'Address is required' });

    let existingProperty = await Property.findOne({ rawAddress: address });
    if (existingProperty) {
      return res.json({
        message: 'Address already exists',
        property: existingProperty,
      });
    }

    const normalized = await normalizeAddress(address);
    if (!normalized) return res.status(400).json({ error: 'Cannot normalize address' });

    let formattedDuplicate = await Property.findOne({
      formattedAddress: normalized.formattedAddress,
    });
    if (formattedDuplicate) {
      return res.json({
        message: 'Duplicate found by normalized address',
        property: formattedDuplicate,
      });
    }

    const newProperty = new Property({
      rawAddress: address,
      formattedAddress: normalized.formattedAddress,
      latitude: normalized.latitude,
      longitude: normalized.longitude,
    });
    await newProperty.save();

    res.json({
      message: 'Address normalized and saved',
      property: newProperty,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const fetchMetadata = async (req, res) => {
  try {
    const { formattedAddress, address } = req.body;

    // Accept either formattedAddress or raw address
    let targetAddress = formattedAddress;
    let normalized = null;
    let existingProperty = null;

    // If raw address provided, normalize it first
    if (!targetAddress && address) {
      normalized = await normalizeAddress(address);
      if (!normalized) {
        return res.status(400).json({ error: 'Cannot normalize address' });
      }
      targetAddress = normalized.formattedAddress;
    }

    if (!targetAddress) {
      return res.status(400).json({ error: 'formattedAddress or address required' });
    }

    // If we have normalization info, detect country and avoid calling Zillow for non-US
    const countryCode = normalized?.addressComponents?.country_code;
    const isUS = (code) => {
      if (!code) return /United States/i.test(targetAddress);
      return ['us', 'usa', 'united states'].includes(String(code).toLowerCase());
    };
    if (countryCode && !isUS(countryCode)) {
      return res.status(400).json({
        error:
          'Zillow covers primarily US properties. The provided address appears outside the US. Use a local data source or remove the country from the address to attempt a search.',
      });
    }

    // Check if property exists in DB
    existingProperty = await Property.findOne({ formattedAddress: targetAddress });

    // If property exists and has price, skip scraping
    if (existingProperty && existingProperty.price) {
      return res.json({
        message: 'Property metadata already exists in database',
        property: existingProperty,
      });
    }

    // Prefer a zillow-friendly query from normalization when available
    const getZillowQuery = (addr, normalized) => {
      if (normalized && normalized.zillowQuery) return normalized.zillowQuery;
      if (!addr) return addr;
      // strip trailing country names like 'United States'
      return addr.replace(/,?\s*United States$/i, '').trim();
    };

    const zillowQuery = getZillowQuery(targetAddress, normalized);
    console.log(`[fetchMetadata] Scraping Zillow for: ${zillowQuery} (original: ${targetAddress})`);

    // Scrape Zillow metadata using a cleaned query
    const metadata = await scrapeZillow(zillowQuery);
    if (!metadata) {
      return res.status(500).json({
        error: 'Failed to fetch property metadata from Zillow',
        zillowQuery,
        hint: 'If this is a non-US property (e.g., United Kingdom), Zillow likely has no data. Use debug endpoint to capture HTML or integrate a regional data source.',
      });
    }

    console.log(`[fetchMetadata] Metadata retrieved:`, {
      zpid: metadata.zpid,
      beds: metadata.beds,
      baths: metadata.baths,
      price: metadata.price,
      squareFootage: metadata.squareFootage,
      lotSize: metadata.lotSize,
      yearBuilt: metadata.yearBuilt,
      propertyType: metadata.propertyType,
    });

    // Prepare data to save/update
    const propertyData = {
      price: metadata.price, // store actual price here
      beds: metadata.beds,
      baths: metadata.baths,
      squareFootage: metadata.squareFootage,
      lotSize: metadata.lotSize,
      yearBuilt: metadata.yearBuilt,
      propertyType: metadata.propertyType,
      lastSoldDate: metadata.lastSoldDate,
      lastSoldPrice: metadata.lastSoldPrice,
    };

    let property;
    if (existingProperty) {
      // Update existing property with metadata
      property = await Property.findByIdAndUpdate(
        existingProperty._id,
        { ...propertyData },
        { new: true }
      );
    } else {
      // Create new property
      property = new Property({
        formattedAddress: targetAddress,
        rawAddress: address || targetAddress,
        latitude: normalized?.latitude,
        longitude: normalized?.longitude,
        ...propertyData,
      });
      await property.save();
    }

    res.json({
      message: 'Property metadata fetched and saved successfully',
      property,
    });
  } catch (err) {
    console.error('fetchMetadata error:', err.message);
    res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
};

export const saveProperty = async (req, res) => {
  const payload = req.body;
  if (!payload.formattedAddress)
    return res.status(400).json({ error: 'formattedAddress required' });

  try {
    const property = new Property(payload);
    await property.save();
    res.json({ success: true, property });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to save property' });
  }
};

export const searchProperties = async (req, res) => {
  const properties = await scrapeZillowSearch(req.body, 20);

  if (!properties.length) {
    return res.status(404).json({ message: 'No properties found' });
  }

  res.json({
    message: 'Properties fetched successfully',
    count: properties.length,
    properties,
  });
};

// Debug endpoint: capture raw HTML for inspection
export const debugHtml = async (req, res) => {
  try {
    const { formattedAddress, address } = req.body;

    let targetAddress = formattedAddress;
    let normalized = null;
    if (!targetAddress && address) {
      normalized = await normalizeAddress(address);
      if (!normalized) {
        return res.status(400).json({ error: 'Cannot normalize address' });
      }
      targetAddress = normalized.formattedAddress;
    }

    if (!targetAddress) {
      return res.status(400).json({ error: 'formattedAddress or address required' });
    }

    // Build zillow-friendly query
    const getZillowQuery = (addr, normalized) => {
      if (normalized && normalized.zillowQuery) return normalized.zillowQuery;
      if (!addr) return addr;
      return addr.replace(/,?\s*United States$/i, '').trim();
    };

    const zillowQuery = getZillowQuery(targetAddress, normalized);
    console.log(`[debugHtml] Fetching raw HTML for: ${zillowQuery} (original: ${targetAddress})`);

    // Import the fetchWithFallback function from scrapezillow
    const { fetchWithFallback } = await import('../utils/scrapezillow.js');

    // Get ZPID first
    const searchURL = `https://www.zillow.com/homes/${encodeURIComponent(zillowQuery)}/`;
    const { data: searchHTML } = await fetchWithFallback(searchURL);

    let zpid = null;
    const zpidMatch = searchHTML && searchHTML.match(/"zpid"\s*:\s*(\d+)/);
    if (zpidMatch) zpid = zpidMatch[1];

    if (!zpid) {
      return res.status(400).json({ error: 'ZPID not found' });
    }

    // Fetch property detail page
    const propertyURL = `https://www.zillow.com/homedetails/${zpid}_zpid/`;
    const { data: propertyHTML } = await fetchWithFallback(propertyURL);

    // Create debug folder if it doesn't exist
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const debugDir = path.join(__dirname, '../debug');
    if (!fs.existsSync(debugDir)) {
      fs.mkdirSync(debugDir, { recursive: true });
    }

    // Save HTML to file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `zillow_${zpid}_${timestamp}.html`;
    const filepath = path.join(debugDir, filename);
    fs.writeFileSync(filepath, propertyHTML);

    res.json({
      message: 'HTML captured and saved',
      zpid,
      address: targetAddress,
      htmlLength: propertyHTML.length,
      savedFile: filename,
      filepath,
      sampleSize: 1000,
      htmlSample: propertyHTML.substring(0, 1000),
    });
  } catch (err) {
    console.error('debugHtml error:', err.message);
    res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
};
