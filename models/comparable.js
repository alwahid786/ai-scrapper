import mongoose from 'mongoose';

const comparableSchema = new mongoose.Schema(
  {
    subjectPropertyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Property',
      required: true,
      index: true,
    },
    address: { type: String, required: true },
    formattedAddress: { type: String, required: true },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    
    // Property attributes
    beds: Number,
    baths: Number,
    squareFootage: Number,
    lotSize: Number,
    yearBuilt: Number,
    propertyType: String,
    
    // Sale information
    saleDate: Date,
    salePrice: Number,
    daysOnMarket: Number,
    listingStatus: { type: String, enum: ['sold', 'active', 'pending'], default: 'sold' },
    
    // Data source
    dataSource: {
      type: String,
      enum: ['mls', 'zillow', 'redfin', 'realtor', 'county'],
      required: true,
    },
    sourceId: String, // External ID from source
    
    // Scoring
    compScore: { type: Number, default: 0 },
    distanceScore: { type: Number, default: 0 },
    recencyScore: { type: Number, default: 0 },
    sqftScore: { type: Number, default: 0 },
    bedBathScore: { type: Number, default: 0 },
    yearBuiltScore: { type: Number, default: 0 },
    conditionScore: { type: Number, default: 0 },
    
    // Distance from subject
    distanceMiles: { type: Number, required: true },
    
    // Adjusted price for ARV calculation
    adjustedPrice: Number,
    
    // Condition assessment
    conditionRating: { type: Number, min: 1, max: 5 },
    renovationIndicators: [String],
    damageFlags: [String],
    
    // Metadata
    rawData: mongoose.Schema.Types.Mixed, // Store original data
    images: [String], // URLs to property images
  },
  { timestamps: true }
);

comparableSchema.index({ subjectPropertyId: 1, compScore: -1 });
comparableSchema.index({ latitude: 1, longitude: 1 });

export default mongoose.model('Comparable', comparableSchema);
