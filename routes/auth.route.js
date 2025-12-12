import express from 'express';
import {
  logout,
  getMyProfile,
  login,
  Create,
  getAllUsers,
  updateSingleUser,
  deleteSingleUser,
  getSingleUser,
  updateMyProfile,
} from '../controllers/auth.controller.js';
import { isAuthenticated } from '../middlewares/auth.middleware.js';
import { isAdmin } from '../middlewares/admin.middleware.js';
import passport from 'passport';
import { sendToken } from '../utils/sendToken.js';

const router = express.Router();

router.post('/create', isAuthenticated, isAdmin, Create);
router.get('/all', isAuthenticated, isAdmin, getAllUsers);
router
  .route('/single/:userId')
  .get(isAuthenticated, isAdmin, getSingleUser)
  .put(isAuthenticated, isAdmin, updateSingleUser)
  .delete(isAuthenticated, isAdmin, deleteSingleUser);

router.put('/updatemyprofile', isAuthenticated, updateMyProfile);
router.post('/login', login);
router.get('/myProfile', isAuthenticated, getMyProfile);
router.get('/logout', logout);

router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

router.get(
  '/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: '/api/auth/login' }),
  async (req, res, next) => {
    if (!req.user) return res.status(400).json({ success: false, message: 'User not found' });
    // try {
    //   const tokenData = await sendToken(res, next, req.user, 200);
    //   res.json({ success: true, ...tokenData });
    // } catch (err) {
    //   next(err);
    // }
    try {
      const tokenData = await sendToken(res, next, req.user, 200, true);
      res.json({ success: true, ...tokenData });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
