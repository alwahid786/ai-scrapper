import Property from '../models/property.js';
import { normalizeAddress } from '../utils/addressUtils.js';
import { scrapeZillowProperty } from '../scraper/zillowScrapper.js';

export const normalize = async (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: 'Address is required' });

  const normalized = await normalizeAddress(address);
  if (!normalized) return res.status(400).json({ error: 'Cannot normalize address' });

  res.json({ rawAddress: address, ...normalized });
};

export const checkDuplicate = async (req, res) => {
  const { formattedAddress } = req.body;
  if (!formattedAddress) return res.status(400).json({ error: 'formattedAddress required' });

  const exists = await Property.findOne({ formattedAddress });
  res.json({ duplicate: !!exists });
};

export const fetchMetadata = async (req, res) => {
  const { propertyUrl } = req.body;
  if (!propertyUrl) return res.status(400).json({ error: 'propertyUrl is required' });

  const data = await scrapeZillowProperty(propertyUrl);
  if (!data) return res.status(400).json({ error: 'Failed to scrape property' });

  const normalized = await normalizeAddress(data.rawAddress);
  const propertyData = { ...data, ...normalized };

  res.json(propertyData);
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
