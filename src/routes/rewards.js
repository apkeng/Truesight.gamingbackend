const express = require('express');
const router = express.Router();
const { verifyToken, optionalAuth } = require('../middleware/auth');
const { getRewards, initializeRewards } = require('../services/databaseService');

/**
 * GET /api/rewards
 * Get all available rewards
 */
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const rewards = await getRewards();
    res.json({
      success: true,
      rewards: rewards,
      count: rewards.length
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/rewards/initialize
 * Initialize rewards in the database
 */
router.post('/initialize', verifyToken, async (req, res, next) => {
  try {
    const result = await initializeRewards();
    res.json({
      success: true,
      message: 'Rewards initialized successfully',
      ...result
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

