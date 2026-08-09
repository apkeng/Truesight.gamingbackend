const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { getDb, FieldValue, getSupabaseAnon } = require('../db');
const authService = require('../services/authService');

/**
 * GET /api/institute-details/:id
 * Get institute details by user ID
 */
router.get('/:id', verifyToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const uid = req.user.uid;

    // Users can only access their own institute details unless they're admin
    if (id !== uid) {
      // Check if user is admin (you can add custom claims check here)
      // For now, only allow accessing own data
      return res.status(403).json({
        success: false,
        error: 'Unauthorized - You can only access your own institute details'
      });
    }

    const instituteDetailsRef = getDb().collection('instituteDetails').doc(id);
    const instituteDetailsDoc = await instituteDetailsRef.get();

    if (!instituteDetailsDoc.exists) {
      // Return empty object if not found (frontend may create it)
      return res.json({
        success: true,
        instituteDetails: null,
        message: 'Institute details not found'
      });
    }

    res.json({
      success: true,
      instituteDetails: { id: instituteDetailsDoc.id, ...instituteDetailsDoc.data() }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/institute-details/:id
 * Create or update institute details
 */
router.post('/:id', verifyToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const uid = req.user.uid;
    const instituteData = req.body;

    // Users can only update their own institute details
    if (id !== uid) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized - You can only update your own institute details'
      });
    }

    const instituteDetailsRef = getDb().collection('instituteDetails').doc(id);
    const instituteDetailsDoc = await instituteDetailsRef.get();

    // Remove fields that shouldn't be updated
    delete instituteData.id;

    if (instituteDetailsDoc.exists) {
      // Update existing document
      await instituteDetailsRef.update({
        ...instituteData,
        updatedAt: FieldValue.serverTimestamp()
      });

      res.json({
        success: true,
        message: 'Institute details updated successfully'
      });
    } else {
      // Create new document
      const newInstituteDetails = {
        ...instituteData,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };

      await instituteDetailsRef.set(newInstituteDetails);

      res.json({
        success: true,
        instituteDetails: { id, ...newInstituteDetails },
        message: 'Institute details created successfully'
      });
    }
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/institute-details/:id
 * Update institute details (full update)
 */
router.put('/:id', verifyToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const uid = req.user.uid;
    const updateData = req.body;

    // Users can only update their own institute details
    if (id !== uid) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized - You can only update your own institute details'
      });
    }

    const instituteDetailsRef = getDb().collection('instituteDetails').doc(id);
    const instituteDetailsDoc = await instituteDetailsRef.get();

    // Remove fields that shouldn't be updated
    delete updateData.id;
    delete updateData.createdAt;

    if (instituteDetailsDoc.exists) {
      await instituteDetailsRef.update({
        ...updateData,
        updatedAt: FieldValue.serverTimestamp()
      });
    } else {
      // Create if doesn't exist
      await instituteDetailsRef.set({
        ...updateData,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
    }

    res.json({
      success: true,
      message: 'Institute details updated successfully'
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/institute-details/:id
 * Partially update institute details
 */
router.patch('/:id', verifyToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const uid = req.user.uid;
    const updateData = req.body;

    // Users can only update their own institute details
    if (id !== uid) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized - You can only update your own institute details'
      });
    }

    const instituteDetailsRef = getDb().collection('instituteDetails').doc(id);

    // Remove fields that shouldn't be updated
    delete updateData.id;
    delete updateData.createdAt;

    await instituteDetailsRef.set({
      ...updateData,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({
      success: true,
      message: 'Institute details updated successfully'
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
