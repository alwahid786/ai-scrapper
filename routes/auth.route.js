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
} from '../controllers/auth.controller.js';
import { isAuthenticated } from '../middlewares/auth.middleware.js';
import { isAdmin } from '../middlewares/admin.middleware.js';

const router = express.Router();

router.post('/create', isAuthenticated, isAdmin, Create);
router.get('/all', isAuthenticated, isAdmin, getAllUsers);
router
  .route('/single/:userId')
  .get(isAuthenticated, isAdmin, getSingleUser)
  .put(isAuthenticated, isAdmin, updateSingleUser)
  .delete(isAuthenticated, isAdmin, deleteSingleUser);

router.post('/login', login);
router.get('/myProfile', isAuthenticated, getMyProfile);
router.get('/logout', logout);

export default router;
