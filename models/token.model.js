import mongoose from 'mongoose';
const tokenSchema = new mongoose.Schema(
  {
    type: { type: String, required: true },
  },
  { timestamps: true }
);
tokenSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2592000 });
export const Token = mongoose.model('Token', tokenSchema);
