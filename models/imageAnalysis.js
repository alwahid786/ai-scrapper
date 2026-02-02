import mongoose from 'mongoose';

const imageAnalysisSchema = new mongoose.Schema(
  {
    propertyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Property',
      required: true,
      index: true,
    },
    imageUrl: { type: String, required: true },
    photoType: { type: String, default: null }, // Provided by source if available
    captureOrder: { type: Number, default: 0 },
    imageType: {
      type: String,
      enum: [
        'exterior-front',
        'exterior-back',
        'kitchen',
        'bedroom',
        'bathroom',
        'living-room',
        'basement',
        'garage',
        'backyard',
        'roof',
        'interior',
        'uncertain',
      ],
      default: 'uncertain',
    },
    confidence: { type: Number, min: 0, max: 100, default: 0 },
    
    // Condition assessment
    conditionScore: { type: Number, min: 1, max: 5 },
    conditionDetails: {
      flooringType: String,
      flooringCondition: String,
      wallCondition: String,
      paintQuality: String,
      cabinetryMaterials: String,
      countertopType: String,
      appliances: String,
      bathroomFixtures: String,
      roofWear: String,
      landscapingCondition: String,
      windowsCondition: String,
    },
    
    // Renovation recognition
    renovationIndicators: [String],
    hasNewCabinets: Boolean,
    hasStainlessAppliances: Boolean,
    hasModernLightFixtures: Boolean,
    hasUpdatedBathroom: Boolean,
    hasNewFlooring: Boolean,
    hasFreshPaint: Boolean,
    hasModernWindows: Boolean,
    hasUpgradedSiding: Boolean,
    hasNewRoof: Boolean,
    
    // Damage detection
    damageFlags: [String],
    hasWaterDamage: Boolean,
    hasMold: Boolean,
    hasCracks: Boolean,
    hasBrokenWindows: Boolean,
    hasMissingShingles: Boolean,
    hasFoundationCracks: Boolean,
    hasYardNeglect: Boolean,
    damageNotes: String,
    
    // Analysis metadata
    analyzedAt: { type: Date, default: Date.now },
    geminiModel: String,
    analysisVersion: String,
  },
  { timestamps: true }
);

imageAnalysisSchema.index({ propertyId: 1, imageType: 1 });

export default mongoose.model('ImageAnalysis', imageAnalysisSchema);
