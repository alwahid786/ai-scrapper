import mongoose from 'mongoose';

const propertyAnalysisSchema = new mongoose.Schema(
  {
    propertyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Property',
      required: true,
      unique: true,
      index: true,
    },
    
    // Property categorization
    propertyCategory: {
      type: String,
      enum: ['single-family', 'condo', 'duplex', 'multi-unit', 'vacant-lot', 'manufactured'],
    },
    
    // Comp search parameters used
    searchRadius: Number, // in miles
    timeWindowMonths: Number,
    compsFound: Number,
    
    // ARV Calculation
    arv: Number,
    arvCalculationMethod: { type: String, enum: ['average', 'weighted'], default: 'weighted' },
    topCompsUsed: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Comparable' }],
    
    // MAO Calculation
    mao: Number,
    estimatedRepairs: Number,
    holdingCost: Number,
    closingCost: Number,
    wholesaleFee: Number,
    maoRule: { type: String, enum: ['65%', '70%', '75%', 'custom'], default: '70%' },
    suggestedOffer: Number,
    
    // Deal Score
    dealScore: { type: Number, min: 0, max: 100 },
    spreadScore: Number,
    repairScore: Number,
    marketScore: Number,
    areaScore: Number,
    compStrengthScore: Number,
    
    // Recommendation
    recommendation: {
      type: String, 
      enum: ['strong-deal', 'good-negotiate', 'weak-lowball', 'pass'],
    },
    recommendationReason: String,
    
    // Condition assessment
    conditionCategory: {
      type: String,
      enum: ['light-repairs', 'medium-repairs', 'heavy-repairs'],
    },
    interiorScore: { type: Number, min: 1, max: 5 },
    exteriorScore: { type: Number, min: 1, max: 5 },
    overallConditionScore: { type: Number, min: 1, max: 10 },
    renovationScore: Number,
    damageRiskScore: Number,
    
    // Market data
    daysOnMarket: Number,
    neighborhoodRating: Number,
    areaType: { type: String, enum: ['urban', 'suburban', 'rural'] },
    
    // Analysis metadata
    analysisDate: { type: Date, default: Date.now },
    analysisVersion: { type: String, default: '1.0' },
    confidence: { type: Number, min: 0, max: 100 },
  },
  { timestamps: true }
);

export default mongoose.model('PropertyAnalysis', propertyAnalysisSchema);
