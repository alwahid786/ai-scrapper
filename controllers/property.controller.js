import Property from '../models/property.js';
import { normalizeAddress } from '../utils/addressUtils.js';
import { scrapeZillow } from '../utils/scrapezillow.js';

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
    const { formattedAddress } = req.body;
    if (!formattedAddress) return res.status(400).json({ error: 'formattedAddress required' });

    // Find property in DB first
    const property = await Property.findOne({ formattedAddress });
    if (!property) return res.status(404).json({ error: 'Property not found in database' });

    // Scrape Zillow metadata
    const metadata = await scrapeZillow(property.formattedAddress);
    if (!metadata) return res.status(500).json({ error: 'Failed to fetch property metadata' });

    res.json({
      message: 'Property metadata fetched successfully',
      property: {
        ...property.toObject(),
        metadata,
      },
    });
  } catch (err) {
    console.error('fetchMetadata error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
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
