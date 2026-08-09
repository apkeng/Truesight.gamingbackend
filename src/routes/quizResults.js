const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { getDb, FieldValue, getSupabaseAnon } = require('../db');
const authService = require('../services/authService');

/**
 * GET /api/quiz-results
 * Get quiz results for the authenticated user
 * Query params:
 *   - subtopic: filter by subtopic
 *   - role: filter by role (Level-1, Level-2)
 */
router.get('/', verifyToken, async (req, res, next) => {
  try {
    const { subtopic, role } = req.query;
    const uid = req.user.uid;

    let query = getDb().collection('quizResults').where('userId', '==', uid);

    // Filter by subtopic if provided
    if (subtopic) {
      query = query.where('subtopic', '==', subtopic);
    }

    // Filter by role if provided
    if (role) {
      query = query.where('role', '==', role);
    }

    const snapshot = await query.get();
    const quizResults = [];
    snapshot.forEach(doc => {
      quizResults.push({ _id: doc.id, ...doc.data() });
    });

    // Sort by createdAt descending (most recent first)
    quizResults.sort((a, b) => {
      const dateA = a.createdAt ? new Date(a.createdAt) : new Date(0);
      const dateB = b.createdAt ? new Date(b.createdAt) : new Date(0);
      return dateB - dateA;
    });

    res.json({
      success: true,
      quizResults: quizResults,
      count: quizResults.length
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/quiz-results/:id
 * Get a specific quiz result by ID
 */
router.get('/:id', verifyToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const uid = req.user.uid;

    const quizResultRef = getDb().collection('quizResults').doc(id);
    const quizResultDoc = await quizResultRef.get();

    if (!quizResultDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Quiz result not found'
      });
    }

    const quizResultData = quizResultDoc.data();

    // Verify user owns this quiz result
    if (quizResultData.userId !== uid) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized - You do not have permission to access this quiz result'
      });
    }

    res.json({
      success: true,
      quizResult: { _id: quizResultDoc.id, ...quizResultData }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/quiz-results
 * Create new quiz result
 */
const DAILY_QUIZ_LIMIT = 20;

router.post('/', verifyToken, async (req, res, next) => {
  try {
    const { answers = [], timeLeft = 0, timeTaken = '0:0', subtopic = '', role = 'Level-1' } = req.body;
    const uid = req.user.uid;

    // Enforce daily quiz cap
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const snapshot = await getDb().collection('quizResults')
      .where('userId', '==', uid)
      .get();

    const startOfTodayMs = startOfDay.getTime();
    let todayCount = 0;
    snapshot.forEach(doc => {
      const data = doc.data();
      const createdAt = data.createdAt?.toDate ? data.createdAt.toDate().getTime() : 0;
      if (createdAt >= startOfTodayMs) {
        todayCount++;
      }
    });

    if (todayCount >= DAILY_QUIZ_LIMIT) {
      return res.status(429).json({
        success: false,
        error: `Daily quiz limit reached. You can play up to ${DAILY_QUIZ_LIMIT} quizzes per day. Come back tomorrow!`
      });
    }

    // Get user data
    const userDoc = await getDb().collection('users').doc(uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const userData = userDoc.data();

    // Calculate score on backend for security
    const score = answers.reduce((sum, answer) => sum + (answer.isCorrect ? 1 : 0), 0);
    const totalQuestions = answers.length;
    const scoreDisplay = `${score}/${totalQuestions}`;

    const newQuizResult = {
      userId: uid,
      userEmail: userData.email || '',
      answers,
      score,
      timeLeft,
      timeTaken,
      subtopic,
      role,
      createdAt: FieldValue.serverTimestamp(),
    };

    const docRef = await getDb().collection('quizResults').add(newQuizResult);

    // Update user stats and points
    const userUpdate = {
      lastQuizScore: scoreDisplay,
      lastQuizDate: new Date().toISOString(),
      updatedAt: FieldValue.serverTimestamp()
    };

    // Level-2 users earn points
    if (role === 'Level-2') {
      const currentPoints = userData.userPoints || 0;
      const currentTotalScore = userData.totalScore || 0;
      userUpdate.userPoints = currentPoints + score;
      userUpdate.totalScore = currentTotalScore + score;
    }

    await getDb().collection('users').doc(uid).update(userUpdate);

    res.json({
      success: true,
      quizResult: { _id: docRef.id, ...newQuizResult },
      message: 'Quiz result saved successfully'
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/quiz-results/user/stats
 * Get quiz statistics for the authenticated user
 */
router.get('/user/stats', verifyToken, async (req, res, next) => {
  try {
    const uid = req.user.uid;

    const snapshot = await getDb().collection('quizResults')
      .where('userId', '==', uid)
      .get();

    const quizResults = [];
    snapshot.forEach(doc => {
      quizResults.push(doc.data());
    });

    // Calculate statistics
    const totalQuizzes = quizResults.length;
    const totalScore = quizResults.reduce((sum, result) => sum + (result.score || 0), 0);
    const averageScore = totalQuizzes > 0 ? (totalScore / totalQuizzes).toFixed(2) : 0;
    const subtopics = [...new Set(quizResults.map(r => r.subtopic).filter(Boolean))];

    res.json({
      success: true,
      stats: {
        totalQuizzes,
        totalScore,
        averageScore: parseFloat(averageScore),
        subtopicsCount: subtopics.length,
        subtopics: subtopics
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
