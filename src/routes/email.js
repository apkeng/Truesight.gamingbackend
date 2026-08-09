const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { verifyToken } = require('../middleware/auth');
const authService = require('../services/authService');
const { sendRedemptionEmail, sendPasswordResetOTP } = require('../services/emailService');
const { storeOTP, verifyOTP, markOTPAsUsed } = require('../services/databaseService');

/**
 * POST /api/email/redemption
 * Send redemption email
 */
router.post('/redemption', 
  verifyToken,
  [
    body('to').isEmail().withMessage('Valid email is required'),
    body('subject').notEmpty().withMessage('Subject is required'),
    body('rewardName').notEmpty().withMessage('Reward name is required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array()
        });
      }

      const result = await sendRedemptionEmail(req.body);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/email/password-reset-otp
 * Send password reset OTP
 */
router.post('/password-reset-otp',
  verifyToken,
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('userId').notEmpty().withMessage('User ID is required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array()
        });
      }

      const { email, userId } = req.body;

      // Generate 6-digit OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date();
      expiresAt.setMinutes(expiresAt.getMinutes() + 10); // OTP expires in 10 minutes

      // Store OTP in Supabase database
      await storeOTP(userId, email, otp, expiresAt);

      // Send email
      const result = await sendPasswordResetOTP({
        email,
        userId,
        otp,
        expiresAt
      });

      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/email/verify-otp
 * Verify OTP and reset password
 */
router.post('/verify-otp',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('otp').isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits'),
    body('newPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array()
        });
      }

      const { email, otp, newPassword } = req.body;

      // Get user by email
      const userRecord = await authService.getUserByEmail(email);
      const userId = userRecord.uid;

      // Verify OTP
      const otpVerification = await verifyOTP(userId, otp);
      if (!otpVerification.valid) {
        return res.status(400).json({
          success: false,
          error: otpVerification.error
        });
      }

      // Update password
      await authService.updateUser(userId, { password: newPassword });

      // Mark OTP as used
      await markOTPAsUsed(userId);

      res.json({
        success: true,
        message: 'Password reset successfully'
      });
    } catch (error) {
      if (error.code === 'auth/user-not-found') {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }
      next(error);
    }
  }
);

module.exports = router;

