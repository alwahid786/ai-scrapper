import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import { getEnv } from '../config/config.js';
import { preprocessImage, bufferToBase64, normalizeImageInputs } from '../utils/imagePreprocessing.js';
import { uploadOnCloudinary } from '../utils/cloudinary.js';

const GEMINI_API_KEY = getEnv('GEMINI_API_KEY');
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

/**
 * Get Gemini model with fallback support
 * Tries newer models first, falls back to older ones if needed
 */
  const getGeminiModel = (preferredModel = null) => {
  // Try preferred model first, or use default order
  // Use gemini-2.5-flash-image first (recommended for higher quota limits)
  const modelOrder = preferredModel 
    ? [preferredModel, 'gemini-2.5-flash-image', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-pro']
    : ['gemini-2.5-flash-image', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-pro'];
  
  // Return the first model (we'll handle errors in generateContent)
  return genAI.getGenerativeModel({ model: modelOrder[0] });
};

/**
 * Generate content with model fallback and rate limit handling
 */
const generateContentWithFallback = async (model, content, preferredModelName = 'gemini-2.5-flash-image') => {
  // Use gemini-2.5-flash-image first (recommended for higher quota limits)
  // Fallback order: gemini-2.5-flash-image → gemini-2.5-flash → gemini-2.0-flash → gemini-pro
  const modelOrder = preferredModelName 
    ? [preferredModelName, 'gemini-2.5-flash-image', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-pro']
    : ['gemini-2.5-flash-image', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-pro'];
  
  let lastError = null;
  
  for (const modelName of modelOrder) {
    try {
      const currentModel = genAI.getGenerativeModel({ model: modelName });
      
      // Try with retry logic for rate limits
      let result;
      let retries = 3;
      let retryDelay = 1000; // Start with 1 second
      
      while (retries > 0) {
        try {
          result = await currentModel.generateContent(content);
          return { result, modelName };
        } catch (rateLimitError) {
          // Check if it's a rate limit error (429)
          const isRateLimit = rateLimitError.message && (
            rateLimitError.message.includes('429') ||
            rateLimitError.message.includes('Too Many Requests') ||
            rateLimitError.message.includes('quota') ||
            rateLimitError.message.includes('rate limit')
          );
          
          if (isRateLimit && retries > 1) {
            // Extract retry delay from error if available
            let delay = retryDelay;
            try {
              const errorJson = JSON.parse(rateLimitError.message.split('[')[1]?.split(']')[0] || '{}');
              if (errorJson['@type'] === 'type.googleapis.com/google.rpc.RetryInfo' && errorJson.retryDelay) {
                delay = parseInt(errorJson.retryDelay) * 1000 || retryDelay;
              }
            } catch (e) {
              // Use exponential backoff
              delay = retryDelay;
            }
            
            console.warn(`⚠️ Rate limit hit for ${modelName}. Retrying in ${delay/1000}s... (${retries-1} retries left)`);
            await new Promise(resolve => setTimeout(resolve, delay));
            retryDelay *= 2; // Exponential backoff
            retries--;
            continue;
          }
          
          // If not rate limit or out of retries, throw to try next model
          throw rateLimitError;
        }
      }
      
      // If we get here, all retries failed
      throw new Error('Rate limit exceeded after retries');
      
    } catch (error) {
      lastError = error;
      const errorMsg = error.message || '';
      
      // If it's a 404 (model not found), try next model
      if (errorMsg.includes('404') || errorMsg.includes('not found')) {
        console.warn(`⚠️ Model ${modelName} not available, trying next model...`);
        continue;
      }
      
      // If it's a rate limit and we've tried all models, throw
      if (errorMsg.includes('429') || errorMsg.includes('Too Many Requests') || errorMsg.includes('quota')) {
        // If this is the last model, throw the error
        if (modelName === modelOrder[modelOrder.length - 1]) {
          console.error(`❌ All models hit rate limits. Please wait and try again later.`);
          throw error;
        }
        // Otherwise, try next model
        console.warn(`⚠️ Rate limit for ${modelName}, trying next model...`);
        continue;
      }
      
      // For other errors, rethrow
      throw error;
    }
  }
  
  // If all models failed, throw the last error
  throw lastError || new Error('All Gemini models failed');
};

/**
 * Analyze property image using Gemini Vision API
 */
export const analyzePropertyImage = async (imageUrl, propertyContext = {}) => {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  try {
    // Pre-process image (resize, dedupe, orientation, enhance, compress)
    const processedImage = await preprocessImage(imageUrl);
    const base64Image = bufferToBase64(processedImage.buffer);
    const mimeType = processedImage.mimeType;

    const prompt = `Analyze this property image and provide a detailed assessment in JSON format. 

Property Context:
- Address: ${propertyContext.address || 'Unknown'}
- Property Type: ${propertyContext.propertyType || 'Unknown'}

Please analyze the image and return ONLY a valid JSON object with the following structure (no markdown, no code blocks, just the JSON):
{
  "imageType": "exterior-front|exterior-back|kitchen|bedroom|bathroom|living-room|basement|garage|backyard|roof|interior|uncertain",
  "confidence": 0-100,
  "conditionScore": 1-5,
  "conditionDetails": {
    "flooringType": "string or null",
    "flooringCondition": "string or null",
    "wallCondition": "string or null",
    "paintQuality": "string or null",
    "cabinetryMaterials": "string or null",
    "countertopType": "string or null",
    "appliances": "string or null",
    "bathroomFixtures": "string or null",
    "roofWear": "string or null",
    "landscapingCondition": "string or null",
    "windowsCondition": "string or null"
  },
  "renovationIndicators": [],
  "hasNewCabinets": false,
  "hasStainlessAppliances": false,
  "hasModernLightFixtures": false,
  "hasUpdatedBathroom": false,
  "hasNewFlooring": false,
  "hasFreshPaint": false,
  "hasModernWindows": false,
  "hasUpgradedSiding": false,
  "hasNewRoof": false,
  "damageFlags": [],
  "hasWaterDamage": false,
  "hasMold": false,
  "hasCracks": false,
  "hasBrokenWindows": false,
  "hasMissingShingles": false,
  "hasFoundationCracks": false,
  "hasYardNeglect": false,
  "damageNotes": null
}

Be thorough and accurate. Only include fields that are visible in the image. Return ONLY the JSON object, no other text.`;

    // Generate content with model fallback
    const { result, modelName } = await generateContentWithFallback(
      null,
      [
        {
          inlineData: {
            data: base64Image,
            mimeType: mimeType,
          },
        },
        prompt,
      ],
      'gemini-2.5-flash-image'
    );

    const response = result.response;
    let text = response.text();

    // Clean up the response - remove markdown code blocks if present
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    // Extract JSON from response
    let jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // Try to find JSON in the entire text
      const jsonStart = text.indexOf('{');
      const jsonEnd = text.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
        jsonMatch = [text.substring(jsonStart, jsonEnd + 1)];
      }
    }

    if (!jsonMatch || !jsonMatch[0]) {
      console.error('Gemini response text:', text);
      throw new Error('No JSON found in Gemini response');
    }

    let analysis;
    try {
      analysis = JSON.parse(jsonMatch[0]);
    } catch (parseError) {
      console.error('JSON parse error:', parseError.message);
      console.error('Attempted to parse:', jsonMatch[0]);
      throw new Error(`Failed to parse Gemini JSON response: ${parseError.message}`);
    }

    return {
      ...analysis,
      analyzedAt: new Date(),
      geminiModel: modelName || 'gemini-2.5-flash-image',
      analysisVersion: '1.0',
    };
  } catch (error) {
    console.error('Gemini Image Analysis Error:', error.message);
    throw new Error(`Failed to analyze image: ${error.message}`);
  }
};

/**
 * Analyze multiple images for a property
 * Images are pre-processed (deduplicated, resized, enhanced) before analysis
 */
export const analyzePropertyImages = async (imageUrls, propertyContext = {}) => {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    return [];
  }

  // Pre-process images (deduplication happens here)
  const { removeDuplicateImages } = await import('../utils/imagePreprocessing.js');
  const { metas } = normalizeImageInputs(imageUrls);
  const urls = metas.map((meta) => meta.url);
  const uniqueUrls = removeDuplicateImages(urls);
  const uniqueMetaByUrl = new Map();
  metas.forEach((meta) => {
    if (!uniqueMetaByUrl.has(meta.url)) {
      uniqueMetaByUrl.set(meta.url, meta);
    }
  });
  const uniqueMetas = uniqueUrls.map((url) => uniqueMetaByUrl.get(url)).filter(Boolean);
  
  if (uniqueUrls.length < urls.length) {
    console.log(`Removed ${urls.length - uniqueUrls.length} duplicate images before analysis`);
  }

  const analyses = [];

  for (const meta of uniqueMetas) {
    try {
      const analysis = await analyzePropertyImage(meta.url, propertyContext);
      analyses.push({
        imageUrl: meta.url,
        photoType: meta.photoType || null,
        captureOrder: meta.captureOrder,
        ...analysis,
      });
      // Add delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      console.error(`Failed to analyze image ${meta.url}:`, error.message);
      // Continue with other images
    }
  }

  return analyses;
};

/**
 * Aggregate image analyses into property-level scores
 */
export const aggregateImageAnalyses = (analyses) => {
  if (!analyses || analyses.length === 0) {
    return {
      interiorScore: 3,
      exteriorScore: 3,
      overallConditionScore: 5,
      renovationScore: 0,
      damageRiskScore: 0,
      imageConfidence: 0,
    };
  }

  const interiorTypes = ['kitchen', 'bedroom', 'bathroom', 'living-room', 'basement', 'interior'];
  const exteriorTypes = ['exterior-front', 'exterior-back', 'roof', 'backyard', 'garage'];

  // Weight scores by confidence - higher confidence images have more weight
  const getWeightedScore = (score, confidence) => {
    if (!score || score === null) return null;
    const normalizedConfidence = (confidence || 50) / 100; // Normalize to 0-1
    const minWeight = 0.5; // Even low confidence images get some weight
    const weight = minWeight + (normalizedConfidence * (1 - minWeight));
    return { score, weight };
  };

  const interiorScores = analyses
    .filter((a) => interiorTypes.includes(a.imageType))
    .map((a) => getWeightedScore(a.conditionScore, a.confidence))
    .filter((s) => s != null && s.score != null);
  
  const exteriorScores = analyses
    .filter((a) => exteriorTypes.includes(a.imageType))
    .map((a) => getWeightedScore(a.conditionScore, a.confidence))
    .filter((s) => s != null && s.score != null);

  // Calculate weighted averages
  const interiorScore =
    interiorScores.length > 0
      ? interiorScores.reduce((sum, s) => sum + (s.score * s.weight), 0) / 
        interiorScores.reduce((sum, s) => sum + s.weight, 0)
      : 3;
  const exteriorScore =
    exteriorScores.length > 0
      ? exteriorScores.reduce((sum, s) => sum + (s.score * s.weight), 0) / 
        exteriorScores.reduce((sum, s) => sum + s.weight, 0)
      : 3;

  // Overall condition score should be 1-10 scale (not 1-5)
  // Convert from 1-5 scale to 1-10 scale
  const overallConditionScore = ((interiorScore + exteriorScore) / 2) * 2;

  // Calculate renovation score (0-100)
  const renovationIndicators = analyses.reduce((acc, a) => {
    if (a.renovationIndicators) acc.push(...a.renovationIndicators);
    return acc;
  }, []);
  const renovationScore = Math.min(renovationIndicators.length * 10, 100);

  // Calculate damage risk score (0-100, higher = more risk)
  const damageCount = analyses.reduce((count, a) => {
    if (a.hasWaterDamage) count++;
    if (a.hasMold) count++;
    if (a.hasCracks) count++;
    if (a.hasBrokenWindows) count++;
    if (a.hasMissingShingles) count++;
    if (a.hasFoundationCracks) count++;
    if (a.hasYardNeglect) count++;
    return count;
  }, 0);
  const damageRiskScore = Math.min(damageCount * 15, 100);

  const avgConfidence =
    analyses.length > 0
      ? analyses.reduce((sum, a) => sum + (a.confidence || 0), 0) / analyses.length
      : 0;

  // Determine condition category based on scores and damage
  const determineConditionCategory = (overallScore, damageRisk, renovationScore, estimatedRepairs = 0, arv = 0) => {
    // If high damage risk, likely heavy repairs
    if (damageRiskScore > 60) {
      return 'heavy-repairs';
    }
    
    // If low condition score (below 4 on 1-10 scale), likely needs work
    if (overallConditionScore < 4) {
      return 'heavy-repairs';
    }
    
    // If repair estimate is high relative to ARV
    if (arv > 0) {
      const repairPercent = (estimatedRepairs / arv) * 100;
      if (repairPercent >= 25) return 'heavy-repairs';
      if (repairPercent >= 10) return 'medium-repairs';
    }
    
    // If moderate condition and some damage
    if (overallConditionScore < 6 && damageRiskScore > 30) {
      return 'medium-repairs';
    }
    
    // If good condition and low damage
    if (overallConditionScore >= 6 && damageRiskScore < 30) {
      return 'light-repairs';
    }
    
    // Default to medium
    return 'medium-repairs';
  };

  return {
    interiorScore: Math.round(interiorScore * 10) / 10,
    exteriorScore: Math.round(exteriorScore * 10) / 10,
    overallConditionScore: Math.round(overallConditionScore * 10) / 10,
    renovationScore,
    damageRiskScore,
    imageConfidence: Math.round(avgConfidence),
    conditionCategory: determineConditionCategory(overallConditionScore, damageRiskScore, renovationScore),
    // Include all renovation indicators and damage flags for reference
    renovationIndicators: [...new Set(analyses.flatMap(a => a.renovationIndicators || []))],
    damageFlags: [...new Set(analyses.flatMap(a => a.damageFlags || []))],
  };
};

/**
 * Detect if an image is blurry or low quality using Gemini Vision API
 */
export const detectBlurryImage = async (imageUrl) => {
  if (!GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY not configured, skipping blur detection');
    return { isBlurry: false, qualityScore: 50, reason: 'Gemini not configured' };
  }

  try {
    // Fetch and preprocess image
    const processedImage = await preprocessImage(imageUrl);
    const base64Image = bufferToBase64(processedImage.buffer);
    const mimeType = processedImage.mimeType;

    const prompt = `Analyze this property image and determine if it is blurry or low quality. 

Return ONLY a valid JSON object with the following structure (no markdown, no code blocks, just the JSON):
{
  "isBlurry": true or false,
  "qualityScore": 0-100 (higher is better),
  "reason": "brief explanation of why it's blurry or not",
  "needsEnhancement": true or false
}

Consider:
- Image sharpness and focus
- Motion blur
- Compression artifacts
- Low resolution
- Noise/grain
- Overall clarity

Return ONLY the JSON object, no other text.`;

    // Generate content with model fallback
    const { result, modelName } = await generateContentWithFallback(
      null,
      [
        {
          inlineData: {
            data: base64Image,
            mimeType: mimeType,
          },
        },
        prompt,
      ],
      'gemini-2.5-flash-image'
    );

    const response = result.response;
    let text = response.text();

    // Clean up the response
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    // Extract JSON
    let jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      const jsonStart = text.indexOf('{');
      const jsonEnd = text.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
        jsonMatch = [text.substring(jsonStart, jsonEnd + 1)];
      }
    }

    if (!jsonMatch || !jsonMatch[0]) {
      console.warn('Failed to parse Gemini blur detection response, defaulting to not blurry');
      return { isBlurry: false, qualityScore: 50, reason: 'Failed to parse response', needsEnhancement: false };
    }

    const analysis = JSON.parse(jsonMatch[0]);
    return {
      isBlurry: analysis.isBlurry || false,
      qualityScore: analysis.qualityScore || 50,
      reason: analysis.reason || 'Unknown',
      needsEnhancement: analysis.needsEnhancement || (analysis.qualityScore < 60),
    };
  } catch (error) {
    console.error('Error detecting blurry image:', error.message);
    return { isBlurry: false, qualityScore: 50, reason: 'Error during detection', needsEnhancement: false };
  }
};

/**
 * Use Gemini to analyze image and get enhancement recommendations
 */
const getGeminiEnhancementRecommendations = async (imageUrl) => {
  try {
    if (!GEMINI_API_KEY) {
      console.warn('GEMINI_API_KEY not configured, using default enhancement parameters');
      return null;
    }

    // Fetch image for Gemini analysis
    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: 20 * 1024 * 1024,
    });

    const imageBuffer = Buffer.from(imageResponse.data);
    const base64Image = bufferToBase64(imageBuffer);
    const mimeType = imageResponse.headers['content-type'] || 'image/jpeg';

    const prompt = `Analyze this property image and provide enhancement recommendations in JSON format.

Return ONLY a valid JSON object with these exact fields (no markdown, no code blocks, just JSON):
{
  "blurLevel": 0-100,
  "brightness": 0-100,
  "contrast": 0-100,
  "saturation": 0-100,
  "sharpness": 0-100,
  "noiseLevel": 0-100,
  "resolution": "low|medium|high",
  "needsUpscaling": true|false,
  "recommendedWidth": number,
  "recommendedHeight": number,
  "enhancementPriority": "sharpness|brightness|contrast|saturation|all"
}

Analyze the image quality and provide specific numeric recommendations for enhancement.`;

    const model = getGeminiModel('gemini-2.5-flash-image');
    const content = [
      {
        inlineData: {
          data: base64Image,
          mimeType: mimeType,
        },
      },
      { text: prompt },
    ];

    const { result } = await generateContentWithFallback(model, content, 'gemini-2.5-flash-image');
    const responseText = result.response.text();

    // Extract JSON from response
    let jsonText = responseText.trim();
    // Remove markdown code blocks if present
    jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    try {
      const recommendations = JSON.parse(jsonText);
      console.log(`✅ Gemini enhancement recommendations:`, recommendations);
      return recommendations;
    } catch (parseError) {
      console.warn('Failed to parse Gemini recommendations, using defaults:', parseError.message);
      return null;
    }
  } catch (error) {
    console.warn('Gemini analysis failed, using default enhancement:', error.message);
    return null;
  }
};

/**
 * Enhance an image using Gemini-guided analysis + sharp (sharpen, denoise, upscale to higher resolution)
 * Uses Gemini to analyze image quality and apply intelligent, context-aware enhancements
 */
export const enhanceBlurryImage = async (imageUrl) => {
  try {
    // Import sharp - it should be a default export in ESM
    let sharpLib;
    try {
      const sharpModule = await import('sharp');
      // Sharp exports as default in ESM
      sharpLib = sharpModule.default;
      
      // If default doesn't exist, the module itself might be the function
      if (!sharpLib && typeof sharpModule === 'function') {
        sharpLib = sharpModule;
      }
      
      // Last resort: check if it's in the module exports
      if (!sharpLib && sharpModule && typeof sharpModule !== 'function') {
        // Try to get the default export or the module itself
        sharpLib = sharpModule.default || sharpModule;
      }
    } catch (importError) {
      console.error('❌ Failed to import Sharp library:', importError.message);
      console.error('💡 To fix: Run "npm install sharp" in the ai-scrapper directory');
      console.error('   Note: Sharp requires native build tools. If installation fails,');
      console.error('   you may need: npm install --build-from-source sharp');
      return { enhanced: false, url: imageUrl, error: `Sharp import failed: ${importError.message}` };
    }
    
    if (!sharpLib || typeof sharpLib !== 'function') {
      console.error('❌ Sharp library imported but is not a function');
      console.error('💡 Try reinstalling: npm uninstall sharp && npm install sharp');
      return { enhanced: false, url: imageUrl, error: 'Sharp not properly installed' };
    }

    // Fetch original high-quality image (don't use preprocessed versions)
    // Try to get the highest resolution version of the image
    let imageUrlToFetch = imageUrl;
    
    // For Zillow images, try to get higher resolution version
    // Zillow images often have multiple sizes: -p_d.jpg (detail), -p_f.jpg (full), -uncropped_scaled_within_*.jpg
    if (imageUrl.includes('zillowstatic.com')) {
      // Try to get full resolution version if available
      const fullResUrl = imageUrl.replace(/-p_[a-z]\.jpg/i, '-p_f.jpg')
                                  .replace(/-cc_ft_\d+\.jpg/i, '-p_f.jpg')
                                  .replace(/-d_d\.jpg/i, '-p_f.jpg');
      if (fullResUrl !== imageUrl) {
        console.log(`🔍 Attempting to fetch higher resolution version...`);
        imageUrlToFetch = fullResUrl;
      }
    }
    
    const imageResponse = await axios.get(imageUrlToFetch, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: 50 * 1024 * 1024, // Increased to 50MB for high-res images
      validateStatus: (status) => status < 500, // Accept 404 and retry with original URL
    }).catch(async (error) => {
      // If high-res version fails, fall back to original URL
      if (imageUrlToFetch !== imageUrl && (error.response?.status === 404 || error.code === 'ENOTFOUND')) {
        console.log(`⚠️ High-res version not available, using original URL`);
        return axios.get(imageUrl, {
          responseType: 'arraybuffer',
          timeout: 30000,
          maxContentLength: 50 * 1024 * 1024,
        });
      }
      throw error;
    });

    let imageBuffer = Buffer.from(imageResponse.data);
    let sharpImage = sharpLib(imageBuffer);

    // Get metadata
    const metadata = await sharpImage.metadata();
    const originalWidth = metadata.width || 1920;
    const originalHeight = metadata.height || 1080;
    const originalSize = imageBuffer.length;

    console.log(`📸 Original image: ${originalWidth}x${originalHeight} (${(originalSize / 1024).toFixed(1)}KB)`);

    // Get Gemini enhancement recommendations
    console.log(`🤖 Using Gemini to analyze image and get enhancement recommendations...`);
    const geminiRecommendations = await getGeminiEnhancementRecommendations(imageUrl);

    // Target resolution: 2560x1440 (2K) or higher if original is larger
    const TARGET_WIDTH = 2560;
    const TARGET_HEIGHT = 1440;
    const MAX_WIDTH = 3840; // 4K max
    const MAX_HEIGHT = 2160;

    // Determine target resolution based on Gemini recommendations or defaults
    let targetWidth = TARGET_WIDTH;
    let targetHeight = TARGET_HEIGHT;

    if (geminiRecommendations?.recommendedWidth && geminiRecommendations?.recommendedHeight) {
      // Use Gemini's recommended resolution
      targetWidth = Math.min(geminiRecommendations.recommendedWidth, MAX_WIDTH);
      targetHeight = Math.min(geminiRecommendations.recommendedHeight, MAX_HEIGHT);
      console.log(`📐 Using Gemini recommended resolution: ${targetWidth}x${targetHeight}`);
    } else {
      // If original is larger than target, keep original size (don't downscale)
      if (originalWidth > TARGET_WIDTH || originalHeight > TARGET_HEIGHT) {
        // Keep original size but cap at 4K
        targetWidth = Math.min(originalWidth, MAX_WIDTH);
        targetHeight = Math.min(originalHeight, MAX_HEIGHT);
        console.log(`📐 Keeping original size (capped at 4K): ${targetWidth}x${targetHeight}`);
      } else {
        // Upscale to target resolution
        const scaleFactor = Math.min(TARGET_WIDTH / originalWidth, TARGET_HEIGHT / originalHeight);
        if (scaleFactor > 1.05) { // Only upscale if significant (>5%)
          targetWidth = Math.round(originalWidth * scaleFactor);
          targetHeight = Math.round(originalHeight * scaleFactor);
          console.log(`📐 Upscaling from ${originalWidth}x${originalHeight} to ${targetWidth}x${targetHeight} (${(scaleFactor * 100).toFixed(0)}% increase)`);
        } else {
          targetWidth = originalWidth;
          targetHeight = originalHeight;
          console.log(`📐 Image is already close to target size, keeping original`);
        }
      }
    }

    // Calculate enhancement parameters based on Gemini recommendations
    let sharpenSigma = 2.0;
    let sharpenJagged = 2.5;
    let denoiseLevel = 3;
    let brightnessBoost = 1.05;
    let saturationBoost = 1.15;
    let contrastBoost = 1.0;

    if (geminiRecommendations) {
      // Map Gemini recommendations (0-100 scale) to sharp parameters
      // Blur level: higher = more sharpening needed (more aggressive for blurry images)
      if (geminiRecommendations.blurLevel !== undefined) {
        const blurFactor = geminiRecommendations.blurLevel / 100;
        sharpenSigma = 2.0 + (blurFactor * 3.0); // 2.0 to 5.0 (more aggressive)
        sharpenJagged = 2.0 + (blurFactor * 3.0); // 2.0 to 5.0 (more aggressive)
        console.log(`🔪 Applying aggressive sharpening (blur level: ${geminiRecommendations.blurLevel}%, sigma: ${sharpenSigma.toFixed(1)})`);
      }

      // Brightness: map 0-100 to 0.85-1.25 multiplier (more aggressive for dark images)
      if (geminiRecommendations.brightness !== undefined) {
        brightnessBoost = 0.85 + ((100 - geminiRecommendations.brightness) / 100 * 0.4);
        console.log(`💡 Adjusting brightness (current: ${geminiRecommendations.brightness}%, boost: ${((brightnessBoost - 1) * 100).toFixed(0)}%)`);
      }

      // Contrast: map 0-100 to 0.85-1.25 multiplier (more aggressive)
      if (geminiRecommendations.contrast !== undefined) {
        contrastBoost = 0.85 + ((100 - geminiRecommendations.contrast) / 100 * 0.4);
        console.log(`🎨 Adjusting contrast (current: ${geminiRecommendations.contrast}%, boost: ${((contrastBoost - 1) * 100).toFixed(0)}%)`);
      }

      // Saturation: map 0-100 to 0.9-1.4 multiplier (more vibrant colors)
      if (geminiRecommendations.saturation !== undefined) {
        saturationBoost = 0.9 + ((100 - geminiRecommendations.saturation) / 100 * 0.5);
        console.log(`🌈 Adjusting saturation (current: ${geminiRecommendations.saturation}%, boost: ${((saturationBoost - 1) * 100).toFixed(0)}%)`);
      }

      // Noise level: higher = more denoising needed
      if (geminiRecommendations.noiseLevel !== undefined) {
        const noiseFactor = geminiRecommendations.noiseLevel / 100;
        denoiseLevel = Math.round(2 + (noiseFactor * 3)); // 2 to 5
        console.log(`🔇 Applying denoising (noise level: ${geminiRecommendations.noiseLevel}%)`);
      }
    }

    // Enhance the image with Gemini-guided parameters
    // 1. Sharpen (reduce blur) - using Gemini recommendations
    sharpImage = sharpImage.sharpen({
      sigma: sharpenSigma,
      flat: 1.0,
      jagged: sharpenJagged,
    });

    // 2. Denoise (reduce noise/grain) - using Gemini recommendations
    if (denoiseLevel > 0) {
      sharpImage = sharpImage.median(denoiseLevel);
    }

    // 3. Enhance contrast and brightness - using Gemini recommendations
    sharpImage = sharpImage.normalise(); // Always normalize contrast first
    
    // Apply additional contrast boost if needed
    if (contrastBoost !== 1.0 && contrastBoost > 1.0) {
      // Apply contrast using linear adjustment
      sharpImage = sharpImage.linear(contrastBoost, -(128 * contrastBoost) + 128);
    }

    // 4. Resize to target resolution with high-quality upscaling
    if (targetWidth !== originalWidth || targetHeight !== originalHeight) {
      sharpImage = sharpImage.resize(targetWidth, targetHeight, {
        kernel: 'lanczos3', // Highest quality upscaling algorithm
        withoutEnlargement: false, // Allow upscaling
      });
    }

    // 5. Apply saturation and brightness boost - using Gemini recommendations
    sharpImage = sharpImage.modulate({
      brightness: brightnessBoost,
      saturation: saturationBoost,
    });

    // Process the enhanced image with maximum quality
    // Use quality 98-100 for best results (Gemini-analyzed images deserve maximum quality)
    const jpegQuality = geminiRecommendations?.blurLevel > 50 ? 100 : 98; // Maximum quality for blurry images
    
    const enhancedBuffer = await sharpImage
      .jpeg({ 
        quality: jpegQuality, // Maximum quality (98-100%) for best image clarity
        progressive: true,
        mozjpeg: true, // Use mozjpeg for better compression at same quality
        optimizeScans: true, // Optimize for progressive loading
      })
      .toBuffer();

    const enhancedSize = enhancedBuffer.length;
    const sizeChange = ((enhancedSize - originalSize) / originalSize * 100).toFixed(1);
    console.log(`✅ Gemini-guided enhanced image: ${targetWidth}x${targetHeight} | Quality: ${jpegQuality}% | ${(originalSize / 1024).toFixed(1)}KB → ${(enhancedSize / 1024).toFixed(1)}KB (${sizeChange > 0 ? '+' : ''}${sizeChange}%)`);

    // Upload enhanced image to Cloudinary
    // uploadOnCloudinary expects { buffer } format
    const uploadResult = await uploadOnCloudinary(
      { buffer: enhancedBuffer, mimeType: 'image/jpeg' },
      'enhanced-properties'
    );

    if (uploadResult && uploadResult.secure_url) {
      console.log(`✅ Enhanced image uploaded to Cloudinary: ${uploadResult.secure_url}`);
      return {
        enhanced: true,
        url: uploadResult.secure_url,
        originalUrl: imageUrl,
        publicId: uploadResult.public_id,
        width: targetWidth,
        height: targetHeight,
      };
    } else {
      console.warn('Failed to upload enhanced image to Cloudinary, returning original');
      return { enhanced: false, url: imageUrl };
    }
  } catch (error) {
    console.error('Error enhancing image:', error.message);
    return { enhanced: false, url: imageUrl, error: error.message };
  }
};

/**
 * Enhance all images in a property's image array
 * Enhances all images to higher resolution and better quality (not just blurry ones)
 */
export const enhancePropertyImages = async (imageUrls, propertyContext = {}) => {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    return imageUrls;
  }

  console.log(`🔍 Enhancing ${imageUrls.length} images to higher resolution and quality...`);

  const enhancedImages = [];
  let enhancedCount = 0;

  // Process images sequentially to avoid rate limits and server overload
  for (let i = 0; i < imageUrls.length; i++) {
    const imageUrl = imageUrls[i];
    
    try {
      console.log(`📸 Enhancing image ${i + 1}/${imageUrls.length}...`);
      
      // Enhance ALL images (not just blurry ones) to improve resolution and quality
      const enhanced = await enhanceBlurryImage(imageUrl);
      
      if (enhanced.enhanced) {
        enhancedImages.push(enhanced.url);
        enhancedCount++;
        console.log(`✅ Enhanced image ${i + 1}: ${enhanced.url.substring(0, 50)}... (${enhanced.width}x${enhanced.height})`);
      } else {
        // If enhancement failed, use original
        enhancedImages.push(imageUrl);
        console.log(`⚠️ Enhancement failed for image ${i + 1}, using original`);
      }

      // Delay between images to avoid rate limits and server overload
      // Wait 1 second between each image to allow processing
      if (i < imageUrls.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      console.error(`Error processing image ${i + 1}:`, error.message);
      // On error, use original image
      enhancedImages.push(imageUrl);
      
      // If it's a rate limit error, wait longer before continuing
      if (error.message && (error.message.includes('429') || error.message.includes('quota') || error.message.includes('rate limit'))) {
        console.warn(`⚠️ Rate limit detected. Waiting 30 seconds before continuing...`);
        await new Promise((resolve) => setTimeout(resolve, 30000));
      } else {
        // Regular delay
        if (i < imageUrls.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }
  }

  console.log(`✅ Enhanced ${enhancedCount} out of ${imageUrls.length} images`);
  return enhancedImages;
};
