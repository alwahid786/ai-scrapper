import jwt from 'jsonwebtoken';
import { getEnv } from '../config/config.js';
import { Token } from '../models/token.model.js';

export const jwtService = () => {
  return {
    async accessToken(_id) {
      return jwt.sign({ _id }, getEnv('ACCESS_TOKEN_SECRET'), {
        expiresIn: getEnv('ACCESS_TOKEN_EXPIRY'),
      });
    },
    async refreshToken(_id) {
      return jwt.sign({ _id }, getEnv('REFRESH_TOKEN_SECRET'), {
        expiresIn: getEnv('REFRESH_TOKEN_EXPIRY'),
      });
    },
    async verificationToken(_id) {
      return jwt.sign({ _id }, getEnv('VERIFICATION_TOKEN_SECRET'), {
        expiresIn: getEnv('VERIFICATION_TOKEN_EXPIRY'),
      });
    },
    async tokenForPassword(_id) {
      return jwt.sign({ _id, for: 'reset' }, getEnv('VERIFICATION_TOKEN_SECRET'), {});
    },
    async tokenVerification(token, tokenSecret) {
      try {
        return await jwt.verify(token, tokenSecret);
      } catch (error) {
        return null;
      }
    },

    async removeRefreshToken(token) {
      try {
        await Token.deleteOne({ token });
      } catch (error) {
        throw new Error(error?.message || 'Failedto remove refresh token');
      }
    },
  };
};
