/**
 * Input validation and sanitization utilities
 */

/**
 * Validate and sanitize address input
 */
export const validateAddress = (address) => {
  if (!address || typeof address !== 'string') {
    throw new Error('Address must be a non-empty string');
  }

  const sanitized = address.trim().slice(0, 500); // Max 500 chars

  // Basic validation - should contain at least street and city/state
  if (sanitized.length < 5) {
    throw new Error('Address is too short');
  }

  // Check for potentially malicious patterns
  const dangerousPatterns = [
    /<script/i,
    /javascript:/i,
    /on\w+\s*=/i,
    /eval\(/i,
    /expression\(/i,
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(sanitized)) {
      throw new Error('Invalid characters in address');
    }
  }

  return sanitized;
};

/**
 * Validate image URLs
 */
export const validateImageUrls = (images) => {
  if (!Array.isArray(images)) {
    throw new Error('Images must be an array');
  }

  if (images.length > 50) {
    throw new Error('Maximum 50 images allowed');
  }

  const validImages = [];
  for (const [index, img] of images.entries()) {
    let url = null;
    let photoType = null;
    let captureOrder = index;

    if (typeof img === 'string') {
      url = img;
    } else if (img && typeof img === 'object') {
      url = img.url || img.imageUrl || img.image_url || null;
      photoType = img.photoType || img.type || img.photo_type || null;
      if (Number.isFinite(img.captureOrder)) {
        captureOrder = img.captureOrder;
      }
    }

    if (!url || typeof url !== 'string') continue;

    try {
      const parsedUrl = new URL(url);
      // Only allow http/https
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        continue;
      }
      // Basic URL length limit
      if (url.length > 2000) {
        continue;
      }
      validImages.push({ url, photoType, captureOrder });
    } catch {
      // Invalid URL, skip
      continue;
    }
  }

  return validImages;
};

/**
 * Validate MAO inputs
 */
export const validateMaoInputs = (inputs) => {
  const validated = {
    estimatedRepairs: 0,
    holdingCost: 0,
    closingCost: 0,
    wholesaleFee: 0,
    maoRule: '70%',
    maoRulePercent: null,
  };

  if (inputs) {
    if (inputs.estimatedRepairs !== undefined) {
      const val = parseFloat(inputs.estimatedRepairs);
      if (isNaN(val) || val < 0 || val > 10000000) {
        throw new Error('Estimated repairs must be between 0 and 10,000,000');
      }
      validated.estimatedRepairs = val;
    }

    if (inputs.holdingCost !== undefined) {
      const val = parseFloat(inputs.holdingCost);
      if (isNaN(val) || val < 0 || val > 1000000) {
        throw new Error('Holding cost must be between 0 and 1,000,000');
      }
      validated.holdingCost = val;
    }

    if (inputs.closingCost !== undefined) {
      const val = parseFloat(inputs.closingCost);
      if (isNaN(val) || val < 0 || val > 1000000) {
        throw new Error('Closing cost must be between 0 and 1,000,000');
      }
      validated.closingCost = val;
    }

    if (inputs.wholesaleFee !== undefined) {
      const val = parseFloat(inputs.wholesaleFee);
      if (isNaN(val) || val < 0 || val > 1000000) {
        throw new Error('Wholesale fee must be between 0 and 1,000,000');
      }
      validated.wholesaleFee = val;
    }

    if (inputs.maoRule !== undefined) {
      if (!['65%', '70%', '75%', 'custom'].includes(inputs.maoRule)) {
        throw new Error('MAO rule must be 65%, 70%, 75%, or custom');
      }
      validated.maoRule = inputs.maoRule;
    }

    if (inputs.maoRule === 'custom') {
      const percent = parseFloat(inputs.maoRulePercent);
      if (isNaN(percent) || percent < 50 || percent > 90) {
        throw new Error('Custom MAO percent must be between 50 and 90');
      }
      validated.maoRulePercent = percent;
    }
  }

  return validated;
};

/**
 * Sanitize MongoDB ObjectId
 */
export const validateObjectId = (id) => {
  if (!id || typeof id !== 'string') {
    return false;
  }
  // MongoDB ObjectId is 24 hex characters
  return /^[0-9a-fA-F]{24}$/.test(id);
};

/**
 * Rate limiting helper (would integrate with Redis in production)
 */
const requestCounts = new Map();

export const checkRateLimit = (identifier, maxRequests = 10, windowMs = 60000) => {
  const now = Date.now();
  const key = identifier;

  if (!requestCounts.has(key)) {
    requestCounts.set(key, { count: 1, resetTime: now + windowMs });
    return true;
  }

  const record = requestCounts.get(key);

  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + windowMs;
    return true;
  }

  if (record.count >= maxRequests) {
    return false;
  }

  record.count++;
  return true;
};
