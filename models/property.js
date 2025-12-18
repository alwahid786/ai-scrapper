import mongoose from 'mongoose';

const propertySchema = new mongoose.Schema(
  {
    formattedAddress: { type: String, required: true, unique: true },
    rawAddress: String,
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
    // estimatedValue: Number,
    price: Number,
  },
  { timestamps: true }
);

export default mongoose.model('Property', propertySchema);
