const express = require('express');
const router = express.Router();
const { verifyToken, optionalAuth } = require('../middleware/auth');
const { getDb, FieldValue, getSupabaseAnon } = require('../db');
const authService = require('../services/authService');
const { generateDailyQuestion } = require('../services/llmService');

/**
 * GET /api/daily-questions/current
 * Get today's daily question (public access)
 */
router.get('/current', optionalAuth, async (req, res, next) => {
  try {
    const today = new Date();
    const dateString = today.toISOString().split('T')[0]; // YYYY-MM-DD format

    // Check if question exists for today
    const questionDoc = await getDb().collection('dailyQuestions').doc(dateString).get();

    if (!questionDoc.exists) {
      // Generate a new question for today
      try {
        const questionData = await generateDailyQuestion();
        
        if (!questionData || !questionData.question || !Array.isArray(questionData.options) || 
            questionData.options.length !== 4 || !questionData.correctAnswer) {
          throw new Error('Invalid question format received from AI');
        }

        // Store the question
        const questionToStore = {
          question: questionData.question,
          options: questionData.options,
          correctAnswer: questionData.correctAnswer,
          date: dateString,
          createdAt: FieldValue.serverTimestamp(),
        };

        await getDb().collection('dailyQuestions').doc(dateString).set(questionToStore);

        // Return question without correct answer
        const { correctAnswer, ...questionWithoutAnswer } = questionToStore;
        return res.json({
          success: true,
          question: {
            ...questionWithoutAnswer,
            id: dateString,
          },
        });
      } catch (error) {
        console.error('Error generating daily question:', error);
        return res.status(500).json({
          success: false,
          error: 'Failed to generate daily question. Please try again.'
        });
      }
    }

    // Return existing question without correct answer
    const questionData = questionDoc.data();
    const { correctAnswer, ...questionWithoutAnswer } = questionData;
    
    res.json({
      success: true,
      question: {
        ...questionWithoutAnswer,
        id: questionDoc.id,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/daily-questions/submit
 * Submit answer to today's daily question
 */
router.post('/submit', optionalAuth, async (req, res, next) => {
  try {
    const { answer } = req.body;
    const uid = req.user?.uid || null; // Optional auth - can be null for non-logged in users

    if (!answer) {
      return res.status(400).json({
        success: false,
        error: 'Answer is required'
      });
    }

    const today = new Date();
    const dateString = today.toISOString().split('T')[0];

    // Get today's question
    const questionDoc = await getDb().collection('dailyQuestions').doc(dateString).get();
    
    if (!questionDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Daily question not found for today'
      });
    }

    const questionData = questionDoc.data();
    const isCorrect = answer.trim() === questionData.correctAnswer.trim();

    // Check if user has already attempted today (if logged in)
    let hasAttempted = false;
    let coinsAwarded = false;
    
    if (uid) {
      const attemptQuery = await getDb().collection('dailyQuestionAttempts')
        .where('userId', '==', uid)
        .where('questionDate', '==', dateString)
        .limit(1)
        .get();

      hasAttempted = !attemptQuery.empty;

      if (!hasAttempted && isCorrect) {
        // Award 5 coins to the user
        const userRef = getDb().collection('users').doc(uid);
        const userDoc = await userRef.get();
        
        if (userDoc.exists) {
          const currentPoints = userDoc.data().userPoints || 0;
          const newPoints = currentPoints + 5;
          
          await userRef.update({
            userPoints: newPoints,
            totalScore: (userDoc.data().totalScore || 0) + 5,
            updatedAt: FieldValue.serverTimestamp()
          });
          
          coinsAwarded = true;
        }
      }
    }

    // Record the attempt (only if user is logged in)
    if (uid && !hasAttempted) {
      await getDb().collection('dailyQuestionAttempts').add({
        userId: uid,
        questionDate: dateString,
        answer: answer,
        isCorrect: isCorrect,
        coinsAwarded: coinsAwarded ? 5 : 0,
        attemptedAt: FieldValue.serverTimestamp(),
      });
    }

    res.json({
      success: true,
      isCorrect: isCorrect,
      correctAnswer: questionData.correctAnswer,
      coinsAwarded: coinsAwarded ? 5 : 0,
      hasAttempted: hasAttempted,
      isLoggedIn: !!uid,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/daily-questions/attempt-status
 * Check if user has attempted today's question (requires auth)
 */
router.get('/attempt-status', verifyToken, async (req, res, next) => {
  try {
    const uid = req.user.uid;
    const today = new Date();
    const dateString = today.toISOString().split('T')[0];

    const attemptQuery = await getDb().collection('dailyQuestionAttempts')
      .where('userId', '==', uid)
      .where('questionDate', '==', dateString)
      .limit(1)
      .get();

    const hasAttempted = !attemptQuery.empty;
    let attemptData = null;
    let correctAnswer = null;

    if (hasAttempted) {
      const attemptDoc = attemptQuery.docs[0];
      attemptData = {
        id: attemptDoc.id,
        ...attemptDoc.data(),
      };

      // Get the correct answer from today's question
      const questionDoc = await getDb().collection('dailyQuestions').doc(dateString).get();
      if (questionDoc.exists) {
        correctAnswer = questionDoc.data().correctAnswer;
      }
    }

    res.json({
      success: true,
      hasAttempted: hasAttempted,
      attempt: attemptData,
      correctAnswer: correctAnswer,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
