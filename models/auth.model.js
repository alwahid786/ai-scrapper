import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
const authSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, select: false },
    passwordToken: { type: String, default: null },
    role: { type: String, default: 'user' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Auth' },
  },
  { timestamps: true }
);
authSchema.pre('save', async function (next) {
  const user = this;
  if (!user.isModified('password')) return next();
  const hashedPassword = await bcrypt.hash(user.password, 10);
  user.password = hashedPassword;
  return next();
});

export const Auth = mongoose.model('Auth', authSchema);
