const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { verifyToken } = require('../middleware/auth');
const { getDb, FieldValue, getSupabaseAnon } = require('../db');
const authService = require('../services/authService');
const { sendRedemptionEmail } = require('../services/emailService');

/**
 * GET /api/redemptions
 * Get redemptions for the authenticated user
 * Query params:
 *   - rewardId: filter by reward ID
 *   - status: filter by status (pending, completed, etc.)
 */
router.get('/', verifyToken, async (req, res, next) => {
  try {
    const { rewardId, status } = req.query;
    const uid = req.user.uid;

    // Get user role to determine if they can see all redemptions
    const userDoc = await getDb().collection('users').doc(uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const isAdmin = userData.role === 'Admin' || userData.role === 'Institute Admin';

    let query = getDb().collection('redemptions');
    
    // Non-admins only see their own redemptions
    if (!isAdmin) {
      query = query.where('userId', '==', uid);
    }

    // Filter by rewardId if provided
    if (rewardId) {
      query = query.where('rewardId', '==', rewardId);
    }

    // Filter by status if provided
    if (status) {
      query = query.where('status', '==', status);
    }

    const snapshot = await query.get();
    const redemptions = [];
    snapshot.forEach(doc => {
      redemptions.push({ _id: doc.id, id: doc.id, ...doc.data() });
    });

    // Sort by createdAt or redeemedAt descending
    redemptions.sort((a, b) => {
      const dateA = a.createdAt ? (a.createdAt.toDate ? a.createdAt.toDate() : new Date(a.createdAt)) : 
                   (a.redeemedAt ? (a.redeemedAt.toDate ? a.redeemedAt.toDate() : new Date(a.redeemedAt)) : new Date(0));
      const dateB = b.createdAt ? (b.createdAt.toDate ? b.createdAt.toDate() : new Date(b.createdAt)) : 
                   (b.redeemedAt ? (b.redeemedAt.toDate ? b.redeemedAt.toDate() : new Date(b.redeemedAt)) : new Date(0));
      return dateB - dateA;
    });

    res.json({
      success: true,
      redemptions: redemptions,
      count: redemptions.length
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/redemptions/:id
 * Get a specific redemption by ID
 */
router.get('/:id', verifyToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const uid = req.user.uid;

    const redemptionRef = getDb().collection('redemptions').doc(id);
    const redemptionDoc = await redemptionRef.get();

    if (!redemptionDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Redemption not found'
      });
    }

    const redemptionData = redemptionDoc.data();

    // Get user role to determine if they can see all redemptions
    const userDoc = await getDb().collection('users').doc(uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const isAdmin = userData.role === 'Admin' || userData.role === 'Institute Admin';

    // Verify user owns this redemption or is an admin
    if (redemptionData.userId !== uid && !isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized - You do not have permission to access this redemption'
      });
    }

    res.json({
      success: true,
      redemption: { _id: redemptionDoc.id, ...redemptionData }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/redemptions
 * Create new redemption
 */
router.post('/',
  verifyToken,
  [
    body('rewardId').notEmpty().withMessage('Reward ID is required'),
    body('rewardName').notEmpty().withMessage('Reward name is required'),
    body('phoneNumber').optional().isString(),
    body('email').optional().isEmail().withMessage('Valid email is required if provided'),
    body('deliveryAddress').optional().isString(),
    body('studentIdUrl').optional().isString(),
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

      const redemptionData = req.body;
      const uid = req.user.uid;

      // Get user data
      const userDoc = await getDb().collection('users').doc(uid).get();
      if (!userDoc.exists) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      const userData = userDoc.data();

      // Get reward data to check points required
      const rewardDoc = await getDb().collection('rewards').doc(redemptionData.rewardId).get();
      if (!rewardDoc.exists) {
        return res.status(404).json({
          success: false,
          error: 'Reward not found'
        });
      }

      const rewardData = rewardDoc.data();
      const pointsRequired = rewardData.pointsRequired || redemptionData.productInfo?.pointsRequired || 0;

      // Check if user has enough points
      const currentPoints = userData.userPoints || 0;
      if (currentPoints < pointsRequired) {
        return res.status(400).json({
          success: false,
          error: `Insufficient points. Required: ${pointsRequired}, Available: ${currentPoints}`
        });
      }

      // Create redemption record
      const newRedemption = {
        userId: uid,
        rewardId: redemptionData.rewardId,
        rewardName: redemptionData.rewardName || rewardData.name,
        rewardDescription: redemptionData.rewardDescription || rewardData.description,
        studentIdUrl: redemptionData.studentIdUrl || null,
        phoneNumber: redemptionData.phoneNumber || null,
        email: redemptionData.email || userData.email,
        deliveryAddress: redemptionData.deliveryAddress || null,
        productInfo: {
          name: redemptionData.rewardName || rewardData.name,
          description: redemptionData.rewardDescription || rewardData.description,
          category: rewardData.category || null,
          pointsRequired: pointsRequired
        },
        redeemedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
        status: 'Pending',
        emailSent: false
      };

      const docRef = await getDb().collection('redemptions').add(newRedemption);

      // Deduct points from user's account
      try {
        const userRef = getDb().collection('users').doc(uid);
        const newPoints = Math.max(0, currentPoints - pointsRequired);
        const newTotalScore = Math.max(0, (userData.totalScore || 0) - pointsRequired);

        await userRef.update({
          userPoints: newPoints,
          totalScore: newTotalScore,
          updatedAt: FieldValue.serverTimestamp()
        });
      } catch (pointsError) {
        console.error('Error deducting points:', pointsError);
        // Rollback redemption if points deduction fails
        await getDb().collection('redemptions').doc(docRef.id).delete();
        return res.status(500).json({
          success: false,
          error: 'Failed to process redemption. Points deduction failed.'
        });
      }

      // Send email notification (don't fail redemption if email fails)
      let emailResult = null;
      try {
        emailResult = await sendRedemptionEmail({
          to: newRedemption.email,
          subject: `Reward Redemption: ${newRedemption.rewardName}`,
          rewardName: newRedemption.rewardName,
          ...newRedemption
        });

        // Update redemption status
        await getDb().collection('redemptions').doc(docRef.id).update({
          emailSent: true,
          emailMessageId: emailResult?.messageId || null
        });
      } catch (emailError) {
        console.error('Error sending email notification:', emailError);
        // Update redemption with email error (but don't fail the request)
        await getDb().collection('redemptions').doc(docRef.id).update({
          emailSent: false,
          emailError: emailError.message || 'Failed to send email'
        });
      }

      res.json({
        success: true,
        redemption: { _id: docRef.id, ...newRedemption },
        pointsDeducted: pointsRequired,
        remainingPoints: currentPoints - pointsRequired,
        message: 'Reward redeemed successfully'
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PATCH /api/redemptions/:id/email-status
 * Update email status for a redemption
 */
router.patch('/:id/email-status', verifyToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { emailSent, emailMessageId, emailError } = req.body;
    const uid = req.user.uid;

    const redemptionRef = getDb().collection('redemptions').doc(id);
    const redemptionDoc = await redemptionRef.get();

    if (!redemptionDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Redemption not found'
      });
    }

    if (redemptionDoc.data().userId !== uid) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized - You do not have permission to update this redemption'
      });
    }

    const updateData = {};
    if (emailSent !== undefined) updateData.emailSent = emailSent;
    if (emailMessageId !== undefined) updateData.emailMessageId = emailMessageId;
    if (emailError !== undefined) updateData.emailError = emailError;

    await redemptionRef.update(updateData);

    res.json({
      success: true,
      message: 'Email status updated successfully'
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
