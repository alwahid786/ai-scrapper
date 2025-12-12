import express from 'express';
import passport from 'passport';
import { googleCallbackController } from '../controllers/googleAuth.controller.js';

const router = express.Router();

router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

router.get(
  '/google/callback',
  passport.authenticate('google', {
    session: false,
    failureRedirect: '/api/auth/login',
  }),
  googleCallbackController
);

export default router;
