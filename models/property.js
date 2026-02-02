import mongoose from 'mongoose';

const propertySchema = new mongoose.Schema(
  {
    formattedAddress: { type: String, required: true, unique: true },
    rawAddress: String,
    address: String, // Street address
    latitude: Number,
    longitude: Number,
    beds: Number,
    baths: Number,
    squareFootage: Number,
    lotSize: Number,
    yearBuilt: Number,
    propertyType: String,
    lastSoldDate: Date,
    lastSoldPrice: Number,
    saleDate: Date,
    salePrice: Number,
    estimatedValue: Number, // Zestimate or estimated value from source
    price: Number,
    listingStatus: String, // 'active', 'sold', 'pending', etc.
    images: [String], // Array of image URLs
    sourceId: String, // ZPID, Redfin ID, etc.
    dataSource: String, // 'zillow', 'redfin', 'realtor', etc.
  },
  { timestamps: true }
);

export default mongoose.model('Property', propertySchema);
