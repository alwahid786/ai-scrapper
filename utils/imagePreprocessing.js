import axios from 'axios';

// Lazy load sharp - will be loaded on first use if available
let sharp = null;
const loadSharp = async () => {
  if (sharp !== null) return sharp; // Already tried

  try {
    const sharpModule = await import('sharp');
    sharp = sharpModule.default;
    return sharp;
  } catch (error) {
    sharp = false; // Mark as unavailable
    console.warn('Sharp not available - image preprocessing will be limited to deduplication. Install with: npm install sharp');
    return null;
  }
};

/**
 * Image Pre-processing Pipeline
 * Performs: resize, dedupe, orientation fix, enhance, compress
 */

const STANDARD_WIDTH = 1920;
const STANDARD_HEIGHT = 1080;
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

/**
 * Remove duplicate images based on URL or content hash
 */
export const removeDuplicateImages = (imageUrls) => {
  if (!Array.isArray(imageUrls)) return [];

  const seen = new Set();
  const unique = [];

  for (const url of imageUrls) {
    if (!url || typeof url !== 'string') continue;

    try {
      // Normalize URL (remove query params, fragments)
      const normalized = new URL(url).pathname.toLowerCase();

      if (!seen.has(normalized)) {
        seen.add(normalized);
        unique.push(url);
      }
    } catch (urlError) {
      // If URL parsing fails, use the URL as-is for deduplication
      if (!seen.has(url.toLowerCase())) {
        seen.add(url.toLowerCase());
        unique.push(url);
      }
    }
  }

  return unique;
};

/**
 * Normalize image inputs to a consistent metadata shape.
 * Accepts strings or objects like { url, imageUrl, photoType, captureOrder }.
 */
export const normalizeImageInputs = (images = []) => {
  if (!Array.isArray(images)) {
    return { urls: [], metas: [] };
  }

  const metas = [];
  images.forEach((img, index) => {
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

    if (!url || typeof url !== 'string') return;

    metas.push({ url, photoType, captureOrder });
  });

  return { urls: metas.map((meta) => meta.url), metas };
};

/**
 * Pre-process a single image: resize, fix orientation, enhance, compress
 */
export const preprocessImage = async (imageUrl) => {
  try {
    // Fetch image
    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: 10 * 1024 * 1024, // 10MB max
    });

    let imageBuffer = Buffer.from(imageResponse.data);
    const originalSize = imageBuffer.length;
    const originalMimeType = imageResponse.headers['content-type'] || 'image/jpeg';

    // Try to load sharp if not already loaded
    const sharpLib = await loadSharp();

    // If sharp is not available, return original with basic info
    if (!sharpLib) {
      return {
        buffer: imageBuffer,
        mimeType: originalMimeType,
        originalSize,
        processedSize: originalSize,
        preprocessingSkipped: true,
      };
    }

    // Use sharp for image processing
    let sharpImage = sharpLib(imageBuffer);

    // Get metadata to check orientation
    const metadata = await sharpImage.metadata();

    // Auto-rotate based on EXIF orientation
    sharpImage = sharpImage.rotate();

    // Resize to standard resolution (maintain aspect ratio)
    sharpImage = sharpImage.resize(STANDARD_WIDTH, STANDARD_HEIGHT, {
      fit: 'inside',
      withoutEnlargement: true,
    });

    // Enhance brightness/contrast if image quality is low (dark, low contrast, or poor exposure)
    // Check image statistics to determine if enhancement is needed
    const stats = await sharpImage.stats();
    const avgBrightness = stats.channels.reduce((sum, ch) => sum + (ch.mean || 0), 0) / stats.channels.length;
    const avgStdDev = stats.channels.reduce((sum, ch) => sum + (ch.stdev || 0), 0) / stats.channels.length;

    // Enhanced quality detection: 
    // - Dark images: brightness < 110 (out of 255) - more lenient threshold
    // - Low contrast: std dev < 35 - more lenient threshold
    // - Very dark: brightness < 80 - needs stronger enhancement
    // - Very low contrast: std dev < 25 - needs stronger enhancement
    const isDark = avgBrightness < 110;
    const isLowContrast = avgStdDev < 35;
    const isVeryDark = avgBrightness < 80;
    const isVeryLowContrast = avgStdDev < 25;
    const isLowQuality = isDark || isLowContrast;

    if (isLowQuality) {
      // Determine enhancement strength based on severity
      let brightnessBoost = 1.1; // Default 10% boost
      let saturationBoost = 1.05; // Default 5% boost

      if (isVeryDark) {
        brightnessBoost = 1.2; // 20% boost for very dark images
        saturationBoost = 1.08; // 8% saturation boost
      } else if (isDark) {
        brightnessBoost = 1.15; // 15% boost for dark images
        saturationBoost = 1.06; // 6% saturation boost
      }

      if (isVeryLowContrast) {
        brightnessBoost = Math.max(brightnessBoost, 1.15); // Ensure minimum boost
        saturationBoost = Math.max(saturationBoost, 1.07); // Higher saturation for low contrast
      }

      // Apply enhancement
      sharpImage = sharpImage.modulate({
        brightness: brightnessBoost,
        saturation: saturationBoost,
      });
      console.log(`Image quality low (brightness: ${avgBrightness.toFixed(1)}, contrast: ${avgStdDev.toFixed(1)}), applying ${((brightnessBoost - 1) * 100).toFixed(0)}% brightness enhancement`);
    }

    // Compress and convert to JPEG for consistency
    const processedBuffer = await sharpImage
      .jpeg({
        quality: 85, // Good quality with compression
        progressive: true,
      })
      .toBuffer();

    // If still too large, compress more aggressively
    let finalBuffer = processedBuffer;
    if (processedBuffer.length > MAX_FILE_SIZE) {
      finalBuffer = await sharpLib(processedBuffer)
        .jpeg({ quality: 75 })
        .toBuffer();
    }

    const finalSize = finalBuffer.length;
    const compressionRatio = ((originalSize - finalSize) / originalSize * 100).toFixed(1);

    console.log(`Image preprocessed: ${imageUrl.substring(0, 50)}... | ${(originalSize / 1024).toFixed(1)}KB → ${(finalSize / 1024).toFixed(1)}KB (${compressionRatio}% reduction)`);

    return {
      buffer: finalBuffer,
      mimeType: 'image/jpeg',
      originalSize,
      processedSize: finalSize,
      width: metadata.width,
      height: metadata.height,
    };
  } catch (error) {
    console.warn(`Failed to preprocess image ${imageUrl}:`, error.message);
    // Return original if preprocessing fails
    try {
      const imageResponse = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });
      return {
        buffer: Buffer.from(imageResponse.data),
        mimeType: imageResponse.headers['content-type'] || 'image/jpeg',
        originalSize: imageResponse.data.length,
        processedSize: imageResponse.data.length,
        preprocessingFailed: true,
      };
    } catch (fallbackError) {
      throw new Error(`Failed to fetch image: ${fallbackError.message}`);
    }
  }
};

/**
 * Pre-process multiple images
 */
export const preprocessImages = async (imageUrls) => {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    return [];
  }

  // Step 1: Remove duplicates
  const uniqueUrls = removeDuplicateImages(imageUrls);
  console.log(`Removed ${imageUrls.length - uniqueUrls.length} duplicate images`);

  // Step 2: Pre-process each image
  const processedImages = [];

  for (const url of uniqueUrls) {
    try {
      const processed = await preprocessImage(url);
      processedImages.push({
        url,
        ...processed,
      });
      // Small delay to avoid overwhelming the system
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (error) {
      console.warn(`Skipping image ${url} due to error:`, error.message);
      // Continue with other images
    }
  }

  console.log(`Preprocessed ${processedImages.length} images successfully`);
  return processedImages;
};

/**
 * Convert processed image buffer to base64 for Gemini API
 */
export const bufferToBase64 = (buffer) => {
  return buffer.toString('base64');
};
