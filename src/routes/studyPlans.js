const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { getDb, FieldValue, getSupabaseAnon } = require('../db');
const authService = require('../services/authService');
const { validateProjectTopic, callLLM } = require('../services/llmService');

/**
 * GET /api/study-plans
 * Get user's study plans (collaborations)
 * Query params: 
 *   - published: filter by published status (true/false)
 *   - instituteCode: filter by institute code (for published study plans)
 */
router.get('/', verifyToken, async (req, res, next) => {
  try {
    const { published, instituteCode: queryInstituteCode } = req.query;
    const uid = req.user.uid;

    const db = getDb();
    
    // Fetch user info to check role and institute
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    const userData = userDoc.data();
    const { role, instituteCode: userInstituteCode } = userData;

    let query = db.collection('studyPlans').where('isTrashed', '==', false);

    // If user is Level 1, they can see all study plans in their institute
    // Otherwise, they only see their own
    if (role === 'Level-1') {
      const finalInstituteCode = queryInstituteCode || userInstituteCode;
      if (finalInstituteCode) {
        query = query.where('instituteCode', '==', finalInstituteCode);
      } else {
        // If no institute code, fallback to only their own for safety
        query = query.where('uid', '==', uid);
      }
    } else {
      query = query.where('uid', '==', uid);
    }

    // Filter by published status if provided
    if (published !== undefined) {
      query = query.where('isPublished', '==', published === 'true');
    }

    const snapshot = await query.get();
    const studyPlans = [];
    snapshot.forEach(doc => {
      studyPlans.push({ _id: doc.id, ...doc.data() });
    });

    res.json({
      success: true,
      studyPlans: studyPlans,
      count: studyPlans.length
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/study-plans/published
 * Get all published study plans from all universities (for All Projects view)
 * Query params:
 *   - instituteCode: filter by institute code (optional - if not provided, returns all)
 */
router.get('/published', verifyToken, async (req, res, next) => {
  try {
    const { instituteCode } = req.query;

    const db = getDb();
    let query = db.collection('studyPlans')
      .where('isTrashed', '==', false)
      .where('isPublished', '==', true);

    // If instituteCode is provided, filter by it; otherwise return all
    if (instituteCode) {
      query = query.where('instituteCode', '==', instituteCode);
    }

    const snapshot = await query.get();
    const studyPlans = [];
    snapshot.forEach(doc => {
      studyPlans.push({ _id: doc.id, ...doc.data() });
    });

    res.json({
      success: true,
      studyPlans: studyPlans,
      count: studyPlans.length
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/study-plans/:id
 * Get a specific study plan by ID
 */
router.get('/:id', verifyToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const uid = req.user.uid;
    const db = getDb();

    const studyPlanRef = db.collection('studyPlans').doc(id);
    const studyPlanDoc = await studyPlanRef.get();

    if (!studyPlanDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Study plan not found'
      });
    }

    const studyPlanData = studyPlanDoc.data();

    // Check if user has access (owner or published and same institute)
    if (studyPlanData.uid !== uid && (!studyPlanData.isPublished || studyPlanData.isTrashed)) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized - You do not have permission to access this study plan'
      });
    }

    res.json({
      success: true,
      studyPlan: { _id: studyPlanDoc.id, ...studyPlanData }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/study-plans
 * Create new study plan (collaboration)
 */
router.post('/', verifyToken, async (req, res, next) => {
  try {
    const { topic, levelOfLearning, autoGenerate = true, ...studyPlanData } = req.body;
    const uid = req.user.uid;
    const db = getDb();

    // 1. Fetch user profile
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    const userData = userDoc.data();
    const { instituteCode, instituteName, role, name } = userData;

    let finalStudyPlanData = { ...studyPlanData };

    if (autoGenerate && topic && levelOfLearning) {
      // 2. Validate topic
      const validation = await validateProjectTopic(topic, levelOfLearning);
      if (!validation.isValid) {
        return res.status(400).json({ 
          success: false, 
          error: validation.reason || 'Invalid topic for the selected level.' 
        });
      }

      // 3. Generate study plan content
      const generatedData = await callLLM(levelOfLearning, topic);
      
      if (!generatedData || !generatedData.topics || generatedData.topics.length === 0) {
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to generate study plan content. Please try again.' 
        });
      }

      finalStudyPlanData = {
        ...finalStudyPlanData,
        ...generatedData,
        topic,
        levelOfLearning
      };
    }

    const newStudyPlan = {
      ...finalStudyPlanData,
      uid,
      name: name || finalStudyPlanData.name,
      instituteCode: instituteCode || finalStudyPlanData.instituteCode,
      instituteName: instituteName || finalStudyPlanData.instituteName,
      role: role || finalStudyPlanData.role,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      isTrashed: false,
      isPublished: finalStudyPlanData.isPublished || false,
    };

    const docRef = await db.collection('studyPlans').add(newStudyPlan);

    res.json({
      success: true,
      studyPlan: { _id: docRef.id, ...newStudyPlan },
      message: 'Study plan created successfully'
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/study-plans/:id
 * Update study plan
 */
router.put('/:id', verifyToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const updateData = req.body;
    const uid = req.user.uid;
    const db = getDb();

    const studyPlanRef = db.collection('studyPlans').doc(id);
    const studyPlanDoc = await studyPlanRef.get();

    if (!studyPlanDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Study plan not found'
      });
    }

    if (studyPlanDoc.data().uid !== uid) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized - You do not have permission to update this study plan'
      });
    }

    // Remove fields that shouldn't be updated
    delete updateData.uid;
    delete updateData.createdAt;

    await studyPlanRef.update({
      ...updateData,
      updatedAt: FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      message: 'Study plan updated successfully'
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/study-plans/:id/publish
 * Toggle publish status of a study plan
 */
router.patch('/:id/publish', verifyToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { isPublished } = req.body;
    const uid = req.user.uid;
    const db = getDb();

    const studyPlanRef = db.collection('studyPlans').doc(id);
    const studyPlanDoc = await studyPlanRef.get();

    if (!studyPlanDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Study plan not found'
      });
    }

    if (studyPlanDoc.data().uid !== uid) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized - You do not have permission to update this study plan'
      });
    }

    await studyPlanRef.update({
      isPublished: isPublished !== undefined ? isPublished : !studyPlanDoc.data().isPublished,
      updatedAt: FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      message: `Study plan ${isPublished ? 'published' : 'unpublished'} successfully`
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/study-plans/:id
 * Delete study plan (soft delete by setting isTrashed to true)
 */
router.delete('/:id', verifyToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { hardDelete = false } = req.query;
    const uid = req.user.uid;
    const db = getDb();

    const studyPlanRef = db.collection('studyPlans').doc(id);
    const studyPlanDoc = await studyPlanRef.get();

    if (!studyPlanDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Study plan not found'
      });
    }

    if (studyPlanDoc.data().uid !== uid) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized - You do not have permission to delete this study plan'
      });
    }

    if (hardDelete === 'true') {
      await studyPlanRef.delete();
    } else {
      await studyPlanRef.update({
        isTrashed: true,
        updatedAt: FieldValue.serverTimestamp()
      });
    }

    res.json({
      success: true,
      message: hardDelete === 'true' ? 'Study plan deleted permanently' : 'Study plan moved to trash'
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
