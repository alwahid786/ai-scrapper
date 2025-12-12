import bcrypt from 'bcrypt';
import { isValidObjectId } from 'mongoose';
import { CustomError } from '../utils/CustomError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { Auth } from '../models/auth.model.js';
import { jwtService } from '../utils/jwtService.js';
import { sendToken } from '../utils/sendToken.js';
import { getEnv } from '../config/config.js';

export const Create = asyncHandler(async (req, res, next) => {
  if (!req.body) return next(new CustomError(400, 'Please provide all fields'));
  const { name, email, password } = req.body;
  if (!name || !email || !password) return next(new CustomError(400, 'Please provide all fields'));
  const user = await Auth.findOne({ email });
  if (user?._id) return next(new CustomError(403, 'Email already exists'));
  const newUser = await Auth.create({
    name,
    email,
    password,
  });
  if (!newUser) return next(new CustomError(400, 'Error while registering user'));
  return res.status(201).json({
    success: true,
    message: 'user created successfully',
  });
});

export const login = asyncHandler(async (req, res, next) => {
  if (!req.body) return next(new CustomError(404, 'Please Provide Email and Password'));
  const { email, password } = req.body;
  if (!email || !password) return next(new CustomError(400, 'Please Provide Email and Password'));
  const user = await Auth.findOne({ email }).select('+password');
  if (!user || !user?._id) return next(new CustomError(400, 'Wrong email or password'));
  const matchPass = await bcrypt.compare(password, user.password);
  if (!matchPass) return next(new CustomError(400, 'Wrong password'));
  console.log('eroiks;odfjilas;ldkjfa;osidj;foasdfji');
  await sendToken(res, next, user, 200, 'Logged in Successfully');
});

export const getMyProfile = asyncHandler(async (req, res, next) => {
  const userId = req?.user?._id;

  if (!isValidObjectId(userId)) {
    return next(new CustomError(400, 'Invalid User Id'));
  }
  const user = await Auth.findById(userId);
  if (!user) return next(new CustomError(400, 'No User Found'));
  return res.status(200).json({ success: true, data: user });
});

export const getAllUsers = asyncHandler(async (req, res, next) => {
  const users = await Auth.find();

  return res.status(200).json({
    success: true,
    count: users.length,
    data: users,
  });
});

export const getSingleUser = asyncHandler(async (req, res, next) => {
  const { userId } = req.params;

  if (!isValidObjectId(userId)) {
    return next(new CustomError(400, 'Invalid User Id'));
  }

  const user = await Auth.findById(userId);
  if (!user) return next(new CustomError(404, 'User not found'));

  return res.status(200).json({
    success: true,
    data: user,
  });
});

export const updateSingleUser = asyncHandler(async (req, res, next) => {
  const { userId } = req.params;

  if (!isValidObjectId(userId)) {
    return next(new CustomError(400, 'Invalid User Id'));
  }

  const updatedUser = await Auth.findByIdAndUpdate(userId, req.body, {
    new: true,
    runValidators: true,
  });

  if (!updatedUser) return next(new CustomError(404, 'User not found'));

  return res.status(200).json({
    success: true,
    message: 'User updated successfully',
    data: updatedUser,
  });
});

export const deleteSingleUser = asyncHandler(async (req, res, next) => {
  const { userId } = req.params;

  if (!isValidObjectId(userId)) {
    return next(new CustomError(400, 'Invalid User Id'));
  }

  const user = await Auth.findById(userId);
  if (!user) return next(new CustomError(404, 'User not found'));

  await user.deleteOne();

  return res.status(200).json({
    success: true,
    message: 'User deleted successfully',
  });
});

export const logout = asyncHandler(async (req, res, next) => {
  const refreshToken = req?.cookies?.[getEnv('REFRESH_TOKEN_NAME')];
  if (refreshToken) await jwtService().removeRefreshToken(refreshToken);
  res.cookie(getEnv('ACCESS_TOKEN_NAME'), { maxAge: 0 });
  res.cookie(getEnv('REFRESH_TOKEN_NAME'), { maxAge: 0 });
  return res.status(200).json({ success: true, message: 'Logged Out Successfully' });
});
