import { Auth } from '../models/auth.model.js';
import { CustomError } from '../utils/CustomError.js';
import { getEnv } from '../config/config.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { jwtService } from '../utils/jwtService.js';
import { accessTokenOptions, refreshTokenOptions } from '../config/constants.js';

/** Get access token from cookies or Authorization Bearer header (for cross-origin / production) */
function getAccessToken(req) {
  const fromCookie = req?.cookies?.[getEnv('ACCESS_TOKEN_NAME')];
  if (fromCookie) return fromCookie;
  const authHeader = req?.headers?.authorization;
  if (authHeader && typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

const isAuthenticated = asyncHandler(async (req, res, next) => {
  try {
    let accessToken = getAccessToken(req);
    let refreshToken = req?.cookies?.[getEnv('REFRESH_TOKEN_NAME')];
    if (!accessToken && !refreshToken) return next(new CustomError(401, 'Please Login First'));

    let user;
    let decoded = accessToken
      ? await jwtService().tokenVerification(accessToken, getEnv('ACCESS_TOKEN_SECRET'))
      : null;
    if (!decoded) {
      decoded = refreshToken
        ? await jwtService().tokenVerification(refreshToken, getEnv('REFRESH_TOKEN_SECRET'))
        : null;
      if (!decoded) return next(new CustomError(401, 'Please Login First'));

      user = await Auth.findById(decoded._id);
      if (!user) return next(new CustomError(401, 'Please Login First'));
      accessToken = await jwtService().accessToken(String(user?._id));
      refreshToken = await jwtService().refreshToken(String(user?._id));
      res.cookie(getEnv('ACCESS_TOKEN_NAME'), accessToken, accessTokenOptions);
      res.cookie(getEnv('REFRESH_TOKEN_NAME'), refreshToken, refreshTokenOptions);
    } else {
      user = await Auth.findById(decoded._id);
      if (!user) return next(new CustomError(401, 'Please Login First'));
    }

    req.user = user;

    return next();
  } catch (error) {
    console.log('Error is Authenticated', error);
    return next(new CustomError(401, 'Please Login First'));
  }
});
export { isAuthenticated };
