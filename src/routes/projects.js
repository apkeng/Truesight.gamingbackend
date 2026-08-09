const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { getDb, FieldValue, getSupabaseAnon } = require('../db');
const authService = require('../services/authService');
const { validateProjectTopic, callLLM } = require('../services/llmService');

/**
 * Helper to normalize project data for JSON serialization
 * Converts Supabase database Timestamps to ISO strings
 */
const normalizeProject = (data) => {
  const normalized = { ...data };
  
  // Handle common date fields
  ['createdAt', 'updatedAt', 'completedAt', 'deadline'].forEach(field => {
    if (normalized[field] && typeof normalized[field].toDate === 'function') {
      normalized[field] = normalized[field].toDate().toISOString();
    } else if (normalized[field] && normalized[field]._seconds) {
      // Handle serialized timestamp objects
      normalized[field] = new Date(normalized[field]._seconds * 1000).toISOString();
    }
  });

  return normalized;
};


/**
 * GET /api/projects
 * Get user projects
 */
router.get('/', verifyToken, async (req, res, next) => {
  try {
    const { type = 'all' } = req.query; // 'all', 'private', 'collaborations'
    const uid = req.user.uid;

    let query = null;
    
    if (type === 'private') {
      query = getDb().collection('privateProjects').where('uid', '==', uid);
    } else if (type === 'collaborations') {
      query = getDb().collection('collaborations').where('uid', '==', uid);
    } else {
      // Get both private and collaborations
      const [privateProjects, collaborations] = await Promise.all([
        getDb().collection('privateProjects').where('uid', '==', uid).get(),
        getDb().collection('collaborations').where('uid', '==', uid).get()
      ]);

      const projects = [];
      privateProjects.forEach(doc => {
        projects.push(normalizeProject({ id: doc.id, ...doc.data(), type: 'private' }));
      });
      collaborations.forEach(doc => {
        projects.push(normalizeProject({ id: doc.id, ...doc.data(), type: 'collaboration' }));
      });

      return res.json({
        success: true,
        projects: projects,
        count: projects.length
      });
    }

    const snapshot = await query.get();
    const projects = [];
    snapshot.forEach(doc => {
      projects.push(normalizeProject({ id: doc.id, ...doc.data() }));
    });

    res.json({
      success: true,
      projects: projects,
      count: projects.length
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/projects/:id
 * Get a specific project by ID
 */
router.get('/:id', verifyToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { type = 'private' } = req.query;
    const uid = req.user.uid;

    const collectionName = type === 'collaboration' ? 'collaborations' : 'privateProjects';
    const projectRef = getDb().collection(collectionName).doc(id);
    const projectDoc = await projectRef.get();

    if (!projectDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    const projectData = projectDoc.data();

    // Verify user has access (owner or if it's a collaboration and published)
    if (projectData.uid !== uid) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized - You do not have permission to access this project'
      });
    }

    res.json({
      success: true,
      project: { id: projectDoc.id, ...projectData }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/projects
 * Create new project
 */
router.post('/', verifyToken, async (req, res, next) => {
  try {
    const { type = 'private', topic, levelOfLearning, autoGenerate = true, ...projectData } = req.body;
    const uid = req.user.uid;

    const collectionName = type === 'collaboration' ? 'collaborations' : 'privateProjects';
    
    let finalProjectData = { ...projectData };

    if (autoGenerate && topic && levelOfLearning) {
      // 1. Fetch user profile
      const userDoc = await getDb().collection('users').doc(uid).get();
      if (!userDoc.exists) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }
      const userData = userDoc.data();

      // 2. Validate topic
      const validation = await validateProjectTopic(topic, levelOfLearning);
      if (!validation.isValid) {
        return res.status(400).json({ 
          success: false, 
          error: validation.reason || 'Invalid topic for the selected level.' 
        });
      }

      // 3. Generate study plan content
      const { wordCount = "1000" } = req.body;
      const generatedData = await callLLM(levelOfLearning, topic, wordCount);
      
      if (!generatedData || !generatedData.topics || generatedData.topics.length === 0) {
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to generate study plan content. Please try again.' 
        });
      }

      finalProjectData = {
        ...finalProjectData,
        ...generatedData,
        name: userData.name || 'Unknown User',
        instituteCode: userData.instituteCode || '',
        role: userData.role || 'Student',
        levelOfLearning,
        topic,
        type: type === 'collaboration' ? 'collaboration' : 'private'
      };
    }

    const now = new Date().toISOString();
    const newProject = {
      ...finalProjectData,
      uid,
      createdAt: now,
      updatedAt: now,
      isTrashed: false,
    };

    const docRef = await getDb().collection(collectionName).add(newProject);
    
    res.json({
      success: true,
      message: 'Project created successfully',
      project: normalizeProject({ id: docRef.id, ...newProject })
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/projects/:id
 * Update project
 */
router.put('/:id', verifyToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { type = 'private', ...updateData } = req.body;
    const uid = req.user.uid;

    const collectionName = type === 'collaboration' ? 'collaborations' : 'privateProjects';
    const projectRef = getDb().collection(collectionName).doc(id);

    // Verify project belongs to user
    const projectDoc = await projectRef.get();
    if (!projectDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    if (projectDoc.data().uid !== uid) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized - You do not have permission to update this project'
      });
    }

    await projectRef.update({
      ...updateData,
      updatedAt: FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      message: 'Project updated successfully'
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/projects/:id
 * Delete project (soft delete by setting isTrashed to true)
 */
router.delete('/:id', verifyToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { type = 'private', hardDelete = false } = req.query;
    const uid = req.user.uid;

    const collectionName = type === 'collaboration' ? 'collaborations' : 'privateProjects';
    const projectRef = getDb().collection(collectionName).doc(id);

    // Verify project belongs to user
    const projectDoc = await projectRef.get();
    if (!projectDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    if (projectDoc.data().uid !== uid) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized - You do not have permission to delete this project'
      });
    }

    if (hardDelete === 'true') {
      await projectRef.delete();
    } else {
      await projectRef.update({
        isTrashed: true,
        updatedAt: FieldValue.serverTimestamp()
      });
    }

    res.json({
      success: true,
      message: hardDelete === 'true' ? 'Project deleted permanently' : 'Project moved to trash'
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

