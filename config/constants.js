import path from 'path';
import { fileURLToPath } from 'url';
import { getEnv } from '../config/config.js';

export const __dirName = fileURLToPath(import.meta.url); // used for file location and folder path
export const __fileName = path.dirname(__dirName);

const isDev = getEnv('NODE_ENV') == 'development' || getEnv('NODE_ENV') == 'test';

export const accessTokenOptions = {
  httpOnly: true,
  sameSite: isDev ? 'lax' : 'none',
  secure: isDev ? false : true,
  maxAge: Number(getEnv('ACCESS_TOKEN_MAX_AGE')),
};

export const refreshTokenOptions = {
  httpOnly: true,
  sameSite: isDev ? 'lax' : 'none',
  secure: isDev ? false : true,
  maxAge: Number(getEnv('REFRESH_TOKEN_MAX_AGE')),
};

//constant.js file is to define the reusable functions like cookie settings
