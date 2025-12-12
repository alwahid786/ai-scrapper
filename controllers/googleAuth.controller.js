import { sendToken } from '../utils/sendToken.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const googleCallbackController = asyncHandler(async (req, res, next) => {
  if (!req.user) {
    return res.status(400).json({ success: false, message: 'User not found' });
  }

  try {
    const tokenData = await sendToken(res, next, req.user, 200, true);

    return res.json({
      success: true,
      message: 'Google login successful',
      ...tokenData,
    });
  } catch (err) {
    next(err);
  }
});
