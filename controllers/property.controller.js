import Property from '../models/property.js';
import { normalizeAddress } from '../utils/addressUtils.js';
import { scrapeZillow } from '../utils/scrapezillow.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

//     if (!address) return res.status(400).json({ error: 'Address is required' });

//     const normalized = await normalizeAddress(address);
//     if (!normalized) return res.status(400).json({ error: 'Cannot normalize address' });

//     let existingProperty = await Property.findOne({
//       formattedAddress: normalized.formattedAddress,
//     });

//     if (existingProperty) {
//       existingProperty.latitude = normalized.latitude;
//       existingProperty.longitude = normalized.longitude;
//       await existingProperty.save();

//       return res.json({
//         message: 'Duplicate address found and updated',
//         property: existingProperty,
//       });
//     }

//     const newProperty = new Property({
//       rawAddress: address,
//       formattedAddress: normalized.formattedAddress,
//       latitude: normalized.latitude,
//       longitude: normalized.longitude,
//     });
//     await newProperty.save();

//     res.json({
//       message: 'Address normalized and saved',
//       property: newProperty,
//     });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: 'Internal server error' });
//   }
// };

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

//     if (!address) {
//       return res.status(400).json({ error: 'address is required' });
//     }

//     const normalized = await normalizeAddress(address);
//     if (!normalized) {
//       return res.status(400).json({ error: 'Invalid address' });
//     }

//     const zpid = await searchZillowZPID(normalized.formattedAddress);
//     if (!zpid) {
//       return res.status(404).json({
//         error: 'Property not found on Zillow',
//       });
//     }

//     const data = await scrapeZillowPropertyByZPID(zpid);
//     if (!data) {
//       return res.status(400).json({
//         error: 'Failed to scrape property metadata from Zillow',
//       });
//     }

//     res.json({
//       ...normalized,
//       zpid,
//       ...data,
//     });
//   } catch (err) {
//     console.error('fetchMetadata error:', err.message);
//     res.status(500).json({ error: 'Internal server error' });
//   }
// };

// export const fetchMetadata = async (req, res) => {
//   try {
//     const { formattedAddress } = req.body;
//     if (!formattedAddress) return res.status(400).json({ error: 'formattedAddress is required' });

//     // Check DB first
//     let existing = await Property.findOne({ formattedAddress });
//     if (existing && existing.beds) {
//       return res.json({
//         message: 'Property metadata already exists',
//         property: existing,
//       });
//     }

//     // Scrape Zillow for property metadata
//     const metadata = await scrapeZillow(formattedAddress);
//     if (!metadata) return res.status(400).json({ error: 'Failed to fetch property metadata' });

//     let property;
//     if (existing) {
//       property = await Property.findByIdAndUpdate(existing._id, { ...metadata }, { new: true });
//     } else {
//       property = new Property({
//         formattedAddress,
//         ...metadata,
//       });
//       await property.save();
//     }

//     res.json({
//       message: 'Property metadata fetched successfully',
//       property,
//     });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: 'Internal server error' });
//   }
// };

export const fetchMetadata = async (req, res) => {
  try {
    const { formattedAddress, address } = req.body;

    // Accept either formattedAddress or raw address
    let targetAddress = formattedAddress;
    let existingProperty = null;

    // If raw address provided, normalize it first
    if (!targetAddress && address) {
      const normalized = await normalizeAddress(address);
      if (!normalized) {
        return res.status(400).json({ error: 'Cannot normalize address' });
      }
      targetAddress = normalized.formattedAddress;
    }

    if (!targetAddress) {
      return res.status(400).json({ error: 'formattedAddress or address required' });
    }

    // Check if property exists in DB
    existingProperty = await Property.findOne({ formattedAddress: targetAddress });

    // If property exists and has metadata, skip scraping
    if (existingProperty && existingProperty.zpid) {
      return res.json({
        message: 'Property metadata already exists in database',
        property: existingProperty,
      });
    }

    console.log(`[fetchMetadata] Scraping Zillow for: ${targetAddress}`);

    // Scrape Zillow metadata
    const metadata = await scrapeZillow(targetAddress);
    if (!metadata) {
      return res.status(500).json({ error: 'Failed to fetch property metadata from Zillow' });
    }

    console.log(`[fetchMetadata] Metadata retrieved:`, {
      zpid: metadata.zpid,
      beds: metadata.beds,
      price: metadata.price,
    });

    // Update or create property in DB
    let property;
    if (existingProperty) {
      // Update existing property with metadata
      property = await Property.findByIdAndUpdate(
        existingProperty._id,
        {
          ...metadata,
          formattedAddress: targetAddress,
        },
        { new: true }
      );
    } else {
      // Create new property
      property = new Property({
        formattedAddress: targetAddress,
        rawAddress: address || targetAddress,
        ...metadata,
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

//   try {
//     const { zillowURL, formattedAddress } = req.body;

//     if (!zillowURL) return res.status(400).json({ error: 'zillowURL required' });

//     // Check DB
//     const property = await Property.findOne({ formattedAddress });
//     if (!property) return res.status(404).json({ error: 'Property not found in database' });

//     // Scrape metadata using the exact property URL
//     const metadata = await scrapeZillow(zillowURL);
//     if (!metadata) return res.status(500).json({ error: 'Failed to fetch property metadata' });

//     res.json({
//       message: 'Property metadata fetched successfully',
//       property: {
//         ...property.toObject(),
//         metadata,
//       },
//     });
//   } catch (err) {
//     console.error('fetchMetadata error:', err.message);
//     res.status(500).json({ error: 'Internal server error' });
//   }
// };
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

// Debug endpoint: capture raw HTML for inspection
export const debugHtml = async (req, res) => {
  try {
    const { formattedAddress, address } = req.body;

    let targetAddress = formattedAddress;
    if (!targetAddress && address) {
      const normalized = await normalizeAddress(address);
      if (!normalized) {
        return res.status(400).json({ error: 'Cannot normalize address' });
      }
      targetAddress = normalized.formattedAddress;
    }

    if (!targetAddress) {
      return res.status(400).json({ error: 'formattedAddress or address required' });
    }

    console.log(`[debugHtml] Fetching raw HTML for: ${targetAddress}`);

    // Import the fetchWithFallback function from scrapezillow
    const { fetchWithFallback } = await import('../utils/scrapezillow.js');

    // Get ZPID first
    const searchURL = `https://www.zillow.com/homes/${encodeURIComponent(targetAddress)}/`;
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
