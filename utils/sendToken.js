import { getEnv } from '../config/config.js';
import { accessTokenOptions, refreshTokenOptions } from '../config/constants.js';
import { jwtService } from '../utils/jwtService.js';
import { CustomError } from '../utils/CustomError.js';

const sendToken = async (res, next, user, statusCode = 200, returnJson = false) => {
  const accessToken = await jwtService().accessToken(String(user?._id));
  const refreshToken = await jwtService().refreshToken(String(user?._id));

  if (!accessToken || !refreshToken)
    return next(new CustomError(400, 'Error while generating tokens'));

  if (returnJson) {
    return { accessToken, refreshToken, user: { ...user._doc, password: null } };
  }

  res.cookie(getEnv('ACCESS_TOKEN_NAME'), accessToken, accessTokenOptions);
  res.cookie(getEnv('REFRESH_TOKEN_NAME'), refreshToken, refreshTokenOptions);

  return res.status(statusCode).json({
    success: true,
    data: { ...user._doc, password: null },
  });
};

export { sendToken };
