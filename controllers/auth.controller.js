import bcrypt from "bcrypt";
import { isValidObjectId } from "mongoose";
import { CustomError } from "../utils/CustomError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { Auth } from "../models/auth.model.js";
import { jwtService } from "../utils/jwtService.js";
import { sendToken } from "../utils/sendToken.js";
import { sendMail } from "../utils/sendMail.js";
import { getEnv } from "../config/config.js";
import { returnMailPage } from "../utils/htmlPages.js";
import {
  accessTokenOptions,
  refreshTokenOptions,
} from "../config/constants.js";

export const Create = asyncHandler(async (req, res, next) => {
  const owner = req.user;
  if (!owner?._id) return next(new CustomError(401, "You are not logged in"));
  if (!req.body) return next(new CustomError(400, "Please provide all fields"));
  const { name, email } = req.body;
  if (!name || !email)
    return next(new CustomError(400, "Please provide all fields"));
  const user = await Auth.findOne({ email });
  if (user?._id) return next(new CustomError(403, "Email already exists"));
  const newUser = await Auth.create({
    name,
    email,
    password: "1234567890",
    createdBy: owner?._id,
  });
  if (!newUser)
    return next(new CustomError(400, "Error while registering user"));

  const token = await jwtService().tokenForPassword(String(newUser._id));
  const setupPasswordUrl = `${getEnv("RESET_PASSWORD_URL")}/${token}`;
  const mailHtml = returnMailPage(newUser.name, setupPasswordUrl);
  const isMailSent = await sendMail(email, "Set Your Password", mailHtml, true);
  if (!isMailSent) {
    await Auth.findByIdAndDelete(newUser?._id);
    return next(
      new CustomError(
        400,
        "Email delivery failed. Please ensure the email address is valid and try again"
      )
    );
  }

  newUser.resetPasswordToken = token;
  await newUser.save();

  return res.status(201).json({
    success: true,
    message: "user created successfully. Email sent to set passowrd",
    user: newUser,
  });
});

export const setupPassword = asyncHandler(async (req, res, next) => {
  const { token, password, confirmPassword } = req.body;

  if (!token || !password || !confirmPassword) {
    return next(new CustomError(400, "Please provide token and password"));
  }

  if (password !== confirmPassword) {
    return next(new CustomError(400, "Passwords do not match"));
  }

  const decoded = await jwtService().tokenVerification(
    token,
    process.env.VERIFICATION_TOKEN_SECRET
  );
  if (!decoded?._id) {
    return next(new CustomError(400, "ed or invalid"));
  }

  const user = await Auth.findById(decoded._id).select("+password");
  if (!user) return next(new CustomError(404, "User not found"));

  user.password = password;
  await user.save();

  return res.status(200).json({
    success: true,
    message: "Password set successfully. You can now login.",
  });
});
export const login = asyncHandler(async (req, res, next) => {
  if (!req.body)
    return next(new CustomError(404, "Please Provide Email and Password"));
  const { email, password } = req.body;
  if (!email || !password)
    return next(new CustomError(400, "Please Provide Email and Password"));
  const user = await Auth.findOne({ email }).select("+password");
  if (!user || !user?._id)
    return next(new CustomError(400, "Wrong email or password"));
  const matchPass = await bcrypt.compare(password, user.password);
  if (!matchPass) return next(new CustomError(400, "Wrong password"));

  await sendToken(res, next, user, 200, "Logged in Successfully");
});
export const getMyProfile = asyncHandler(async (req, res, next) => {
  const userId = req?.user?._id;

  if (!isValidObjectId(userId)) {
    return next(new CustomError(400, "Invalid User Id"));
  }
  const user = await Auth.findById(userId);
  if (!user) return next(new CustomError(400, "No User Found"));
  return res.status(200).json({ success: true, data: user });
});
export const getAllUsers = asyncHandler(async (req, res, next) => {
  const users = await Auth.find({ createdBy: req.user._id });

  return res.status(200).json({
    success: true,
    count: users.length,
    data: users,
  });
});
export const getSingleUser = asyncHandler(async (req, res, next) => {
  const { userId } = req.params;

  if (!isValidObjectId(userId)) {
    return next(new CustomError(400, "Invalid User Id"));
  }

  const user = await Auth.findOne({ _id: userId, createdBy: req.user._id });
  if (!user)
    return next(new CustomError(404, "User not found or access denied"));

  return res.status(200).json({
    success: true,
    data: user,
  });
});
export const updateSingleUser = asyncHandler(async (req, res, next) => {
  const { userId } = req.params;

  if (!isValidObjectId(userId)) {
    return next(new CustomError(400, "Invalid User Id"));
  }

  const { name, role, password } = req.body;
  if (!name && !role && !password) {
    return next(new CustomError(400, "Enter something for update"));
  }

  const updatedUser = await Auth.findByIdAndUpdate(
    { _id: userId, createdBy: req.user._id },
    { name, role, password },
    { new: true }
  );

  if (!updatedUser)
    return next(new CustomError(404, "User not found or access denied"));

  return res.status(200).json({
    success: true,
    message: "User updated successfully",
    data: updatedUser,
  });
});
export const deleteSingleUser = asyncHandler(async (req, res, next) => {
  const onwer = req.user;
  const { userId } = req.params;

  if (!isValidObjectId(userId)) {
    return next(new CustomError(400, "Invalid User Id"));
  }

  const user = await Auth.findOne({ _id: userId, createdBy: onwer._id });
  if (!user)
    return next(new CustomError(404, "User not found or access denied"));
  await user.deleteOne();
  return res.status(200).json({
    success: true,
    message: "User deleted successfully",
  });
});
export const updateMyProfile = asyncHandler(async (req, res, next) => {
  const userId = req.user.id;
  if (!isValidObjectId(userId)) {
    return next(new CustomError(400, "Invalid User Id"));
  }
  const { name } = req.body;
  if (!name) {
    return next(new CustomError(404, "Please Enter Something"));
  }
  const updatedUser = await Auth.findById(userId);

  if (!updatedUser) {
    return next(new CustomError(404, "User not found"));
  }

  if (name) updatedUser.name = name;

  await updatedUser.save();
  return res.status(200).json({
    success: true,
    message: "Profile updated successfully",
    data: updatedUser,
  });
});

export const logout = asyncHandler(async (req, res, next) => {
  const refreshToken = req?.cookies?.[getEnv("REFRESH_TOKEN_NAME")];
  if (refreshToken) await jwtService().removeRefreshToken(refreshToken);
  res.cookie(getEnv("ACCESS_TOKEN_NAME"), "", {
    ...accessTokenOptions,
    maxAge: 0,
  });
  res.cookie(getEnv("REFRESH_TOKEN_NAME"), "", {
    ...refreshTokenOptions,
    maxAge: 0,
  });
  return res
    .status(200)
    .json({ success: true, message: "Logged Out Successfully" });
});

export const forgetPassword = asyncHandler(async (req, res, next) => {
  if (!req?.body) {
    return next(new CustomError(400, "Please Provide Email"));
  }

  const { email } = req.body;
  if (!email) {
    return next(new CustomError(400, "Please Provide Email"));
  }

  const user = await Auth.findOne({ email });
  if (!user?._id) {
    return next(new CustomError(404, "User Not Found"));
  }

  // generate verification token
  const token = await jwtService().verificationToken(String(user._id));
  console.log("Generated token:", token);
  if (!token) {
    return next(new CustomError(400, "Error While Generating Token"));
  }

  // const resetPasswordUrl = `${getEnv('RESET_PASSWORD_URL')}/${token}`;
  const baseResetUrl = getEnv("RESET_PASSWORD_URL");

  if (!baseResetUrl) {
    return next(new CustomError(500, "Reset password URL is not configured"));
  }

  const resetPasswordUrl = `${baseResetUrl.replace(
    /\/$/,
    ""
  )}/${encodeURIComponent(token)}`;

  const mailHtml = returnMailPage(user.name, resetPasswordUrl);

  // sendMail(to, subject, text/html, html = false)
  const isMailSent = await sendMail(
    email,
    "Reset Password",
    mailHtml,
    true // html email
  );

  if (!isMailSent) {
    return next(new CustomError(500, "Some Error Occurred While Sending Mail"));
  }

  user.resetPasswordToken = token;
  await user.save();

  return res.status(200).json({
    success: true,
    message: "Reset Password Link Sent Successfully Check Your MailBox",
  });
});

export const resetPassword = asyncHandler(async (req, res, next) => {
  if (!req?.body)
    return next(
      new CustomError(400, "Please Provide Reset Token and New Password")
    );
  const { password, confirmPassword, token } = req.body;
  if (!token || !password || !confirmPassword)
    return next(
      new CustomError(400, "Please Provide Reset Token and New Password")
    );
  if (password !== confirmPassword) {
    return next(new CustomError(400, "Passwords do not match"));
  }
  const decoded = await jwtService().tokenVerification(
    token,
    getEnv("VERIFICATION_TOKEN_SECRET")
  );
  if (!decoded?._id)
    return next(new CustomError(400, "Token Expired Try Again"));

  const user = await Auth.findById(decoded._id).select("+password");
  if (!user) return next(new CustomError(400, "User Not Found"));

  if (user.resetPasswordToken !== String(token)) {
    return next(new CustomError(400, "Invalid token"));
  }
  user.resetPasswordToken = null;
  // hashing handled by pre('save') hook
  user.password = password;
  await user.save();
  return res.status(200).json({
    success: true,
    message: "Password Reset Successfully Now You Can Login",
  });
});
