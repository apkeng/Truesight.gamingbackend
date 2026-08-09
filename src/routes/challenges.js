const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { getDb, FieldValue, getSupabaseAnon } = require('../db');
const authService = require('../services/authService');
const { body, validationResult } = require('express-validator');

/**
 * POST /api/challenges
 * Create a new challenge
 */
router.post('/', 
  verifyToken,
  [
    body('topic').notEmpty().withMessage('Topic is required'),
    body('challengeType').optional().isIn(['async']).withMessage('Challenge type must be async'),
    body('matchingType').isIn(['invite']).withMessage('Matching type must be invite'),
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

      const { topic, challengeType = 'async', matchingType = 'invite', opponentId } = req.body;
      const challengerId = req.user.uid;

      // Get challenger data
      const challengerDoc = await getDb().collection('users').doc(challengerId).get();
      if (!challengerDoc.exists) {
        return res.status(404).json({
          success: false,
          error: 'Challenger not found'
        });
      }
      const challengerData = challengerDoc.data();

      // Validate challenger is Level-1 or Level-2 (normalize role for comparison - handle variations)
      const userRole = challengerData.role ? challengerData.role.trim() : null;
      const normalizedRole = userRole ? userRole.toLowerCase().replace(/\s+/g, '-') : null;
      // Accept: 'level-1', 'level1', 'teacher', 'level-2', 'level2', 'student' (case-insensitive)
      const isLevel1 = normalizedRole === 'level-1' || 
                       normalizedRole === 'level1' || 
                       normalizedRole === 'teacher';
      const isLevel2 = normalizedRole === 'level-2' || 
                       normalizedRole === 'level2' || 
                       normalizedRole === 'student';
      const canCreateChallenge = isLevel1 || isLevel2;
      
      if (!canCreateChallenge) {
        console.error(`Challenge creation denied. User ID: ${challengerId}, Role: "${userRole}", Normalized: "${normalizedRole}"`);
        console.error('Full user data:', JSON.stringify(challengerData, null, 2));
        return res.status(403).json({
          success: false,
          error: `Only Level-1 (Teacher) and Level-2 (Student) users can create challenges. Your current role is: ${userRole || 'not set'}.`
        });
      }

      let opponentIdFinal = opponentId;
      let opponentData = null;

      // Only invite matching type is allowed
      if (matchingType === 'invite') {
        // Validate opponent
        if (!opponentId) {
          return res.status(400).json({
            success: false,
            error: 'Opponent ID is required for invite challenges'
          });
        }

        if (opponentId === challengerId) {
          return res.status(400).json({
            success: false,
            error: 'Cannot challenge yourself'
          });
        }

        const opponentDoc = await getDb().collection('users').doc(opponentId).get();
        if (!opponentDoc.exists) {
          return res.status(404).json({
            success: false,
            error: 'Opponent not found'
          });
        }

        opponentData = opponentDoc.data();

        // Validate opponent is Level-1 or Level-2 (normalize role for comparison - handle variations)
        const opponentRole = opponentData.role ? opponentData.role.trim() : null;
        const normalizedOpponentRole = opponentRole ? opponentRole.toLowerCase().replace(/\s+/g, '-') : null;
        // Accept: 'level-1', 'level1', 'teacher', 'level-2', 'level2', 'student' (case-insensitive)
        const isOpponentLevel1 = normalizedOpponentRole === 'level-1' || 
                                 normalizedOpponentRole === 'level1' || 
                                 normalizedOpponentRole === 'teacher';
        const isOpponentLevel2 = normalizedOpponentRole === 'level-2' || 
                                 normalizedOpponentRole === 'level2' || 
                                 normalizedOpponentRole === 'student';
        const canBeChallenged = isOpponentLevel1 || isOpponentLevel2;
        
        if (!canBeChallenged) {
          return res.status(403).json({
            success: false,
            error: `Can only challenge Level-1 (Teacher) and Level-2 (Student) users. Opponent's role is: ${opponentRole || 'not set'}`
          });
        }
      }

      // Generate quiz questions for the topic
      const llmService = require('../services/llmService');
      let questions = [];
      try {
        const result = await llmService.generateQuizQuestions(topic);
        
        if (Array.isArray(result) && result.length > 0) {
          questions = result;
        } else if (result && result.candidates && result.candidates[0] && result.candidates[0].content) {
          let rawText = result.candidates[0].content.parts[0].text;
          
          // Clean the response - remove markdown code blocks and any leading/trailing text
          rawText = rawText
            .replace(/```json\n?/g, "")
            .replace(/```\n?/g, "")
            .replace(/^[^[]*/, "") // Remove anything before the first [
            .replace(/[^\]]*$/, "") // Remove anything after the last ]
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\")
            .trim();

          // Try to parse JSON
          try {
            questions = JSON.parse(rawText);
          } catch (parseError) {
            // Try to find JSON array in the text if parsing failed
            const jsonMatch = rawText.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              questions = JSON.parse(jsonMatch[0]);
            } else {
              throw new Error(`Failed to parse JSON: ${parseError.message}`);
            }
          }
        }
        
        // Validate question structure
        if (Array.isArray(questions) && questions.length > 0) {
          questions = questions.filter(q => 
            q.question && 
            Array.isArray(q.options) && q.options.length === 4 && 
            q.correctAnswer
          ).slice(0, 5); // Return max 5 questions
        }
        
        if (!Array.isArray(questions) || questions.length === 0) {
          throw new Error('Failed to generate questions');
        }
      } catch (error) {
        console.error('Error generating quiz questions:', error);
        return res.status(500).json({
          success: false,
          error: 'Failed to generate quiz questions. Please try again.'
        });
      }

      // Calculate expiration time (always 24 hours for async)
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24); // 24 hours for async

      // Create challenge document
      const challengeData = {
        challengerId,
        challengerName: challengerData.name || challengerData.email,
        opponentId: opponentIdFinal,
        opponentName: opponentData.name || opponentData.email,
        topic,
        status: 'pending',
        challengeType,
        matchingType,
        questions,
        challengerResult: null,
        opponentResult: null,
        winner: null,
        bonusPointsAwarded: false,
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: expiresAt.toISOString(),
      };

      const challengeRef = await getDb().collection('challenges').add(challengeData);
      const challengeId = challengeRef.id;

      // Send email invitation to opponent (async - don't block response)
      const emailService = require('../services/emailService');
      if (opponentData.email) {
        emailService.sendChallengeInvitation({
          to: opponentData.email,
          challengerName: challengerData.name || challengerData.email,
          topic: topic,
          challengeId: challengeId,
          expiresAt: expiresAt.toISOString(),
          appUrl: process.env.APP_URL || 'http://localhost:3000'
        }).catch(error => {
          // Log error but don't fail challenge creation
          if (error.message.includes('not configured')) {
            console.warn('⚠️  Email service not configured. Challenge created but email not sent.');
            console.warn('   To enable emails, set GMAIL_EMAIL/GMAIL_PASSWORD or SMTP_USER/SMTP_PASS in .env');
          } else {
            console.error('Error sending challenge invitation email:', error.message);
          }
        });
      }

      res.json({
        success: true,
        challenge: {
          id: challengeId,
          ...challengeData
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/challenges
 * Get challenges for the authenticated user
 * Query params:
 *   - status: filter by status (pending, accepted, in_progress, completed, cancelled, expired)
 *   - type: filter by challengeType (real_time, async)
 *   - role: filter by user's role in challenge (challenger, opponent, both)
 */
router.get('/', verifyToken, async (req, res, next) => {
  try {
    const { status, type, role } = req.query;
    const uid = req.user.uid;

    let query = getDb().collection('challenges');

    // Filter by user's involvement
    if (role === 'challenger') {
      query = query.where('challengerId', '==', uid);
    } else if (role === 'opponent') {
      query = query.where('opponentId', '==', uid);
    } else {
      // Both - need to query separately and combine
      const challengerQuery = getDb().collection('challenges').where('challengerId', '==', uid);
      const opponentQuery = getDb().collection('challenges').where('opponentId', '==', uid);

      const [challengerSnapshot, opponentSnapshot] = await Promise.all([
        challengerQuery.get(),
        opponentQuery.get()
      ]);

      const challengeIds = new Set();
      challengerSnapshot.forEach(doc => challengeIds.add(doc.id));
      opponentSnapshot.forEach(doc => challengeIds.add(doc.id));

      // Fetch all challenges by IDs
      const challenges = [];
      for (const id of challengeIds) {
        const doc = await getDb().collection('challenges').doc(id).get();
        if (doc.exists) {
          challenges.push({ _id: doc.id, ...doc.data() });
        }
      }

      // Apply additional filters
      let filtered = challenges;
      if (status) {
        filtered = filtered.filter(c => c.status === status);
      }
      if (type) {
        filtered = filtered.filter(c => c.challengeType === type);
      }

      // Sort by createdAt descending
      filtered.sort((a, b) => {
        const dateA = a.createdAt ? (a.createdAt.toDate ? a.createdAt.toDate() : new Date(a.createdAt)) : new Date(0);
        const dateB = b.createdAt ? (b.createdAt.toDate ? b.createdAt.toDate() : new Date(b.createdAt)) : new Date(0);
        return dateB - dateA;
      });

      return res.json({
        success: true,
        challenges: filtered,
        count: filtered.length
      });
    }

    // Apply status filter
    if (status) {
      query = query.where('status', '==', status);
    }

    // Apply type filter
    if (type) {
      query = query.where('challengeType', '==', type);
    }

    const snapshot = await query.get();
    const challenges = [];
    snapshot.forEach(doc => {
      challenges.push({ _id: doc.id, ...doc.data() });
    });

    // Sort by createdAt descending
    challenges.sort((a, b) => {
      const dateA = a.createdAt ? (a.createdAt.toDate ? a.createdAt.toDate() : new Date(a.createdAt)) : new Date(0);
      const dateB = b.createdAt ? (b.createdAt.toDate ? b.createdAt.toDate() : new Date(b.createdAt)) : new Date(0);
      return dateB - dateA;
    });

    res.json({
      success: true,
      challenges: challenges,
      count: challenges.length
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/challenges/available/opponents
 * Get available opponents for matchmaking
 * NOTE: This must come before /:id route to avoid route conflicts
 */
router.get('/available/opponents', verifyToken, async (req, res, next) => {
  try {
    const uid = req.user.uid;

    // Get all Level-1 and Level-2 users except the current user
    // Query for Level-1, Level-2, Teacher, and Student roles
    const level1Query = await getDb().collection('users')
      .where('role', '==', 'Level-1')
      .limit(50)
      .get();
    
    const level2Query = await getDb().collection('users')
      .where('role', '==', 'Level-2')
      .limit(50)
      .get();
    
    const teacherQuery = await getDb().collection('users')
      .where('role', '==', 'Teacher')
      .limit(50)
      .get();
    
    const studentQuery = await getDb().collection('users')
      .where('role', '==', 'Student')
      .limit(50)
      .get();
    
    // Combine results, remove duplicates, and filter out current user
    const allDocs = [...level1Query.docs, ...level2Query.docs, ...teacherQuery.docs, ...studentQuery.docs];
    const uniqueDocs = Array.from(
      new Map(allDocs.map(doc => [doc.id, doc])).values()
    ).filter(doc => doc.id !== uid);
    
    const usersQuery = {
      forEach: (callback) => uniqueDocs.forEach(callback)
    };

    const opponents = [];
    usersQuery.forEach(doc => {
      if (doc.id !== uid) {
        const userData = doc.data();
        opponents.push({
          uid: doc.id,
          name: userData.name || userData.email,
          email: userData.email
        });
      }
    });

    res.json({
      success: true,
      opponents: opponents
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/challenges/:id
 * Get a specific challenge by ID
 */
router.get('/:id', verifyToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const uid = req.user.uid;

    const challengeRef = getDb().collection('challenges').doc(id);
    const challengeDoc = await challengeRef.get();

    if (!challengeDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Challenge not found'
      });
    }

    const challengeData = challengeDoc.data();

    // Verify user is involved in this challenge
    if (challengeData.challengerId !== uid && challengeData.opponentId !== uid) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized - You are not involved in this challenge'
      });
    }

    res.json({
      success: true,
      challenge: { _id: challengeDoc.id, ...challengeData }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/challenges/:id/accept
 * Accept a pending challenge
 */
router.post('/:id/accept', verifyToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const uid = req.user.uid;

    const challengeRef = getDb().collection('challenges').doc(id);
    const challengeDoc = await challengeRef.get();

    if (!challengeDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Challenge not found'
      });
    }

    const challengeData = challengeDoc.data();

    // Verify user is the opponent
    if (challengeData.opponentId !== uid) {
      return res.status(403).json({
        success: false,
        error: 'Only the opponent can accept this challenge'
      });
    }

    // Verify challenge is pending
    if (challengeData.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: `Challenge is already ${challengeData.status}`
      });
    }

    // Check if challenge has expired
    const expiresAt = new Date(challengeData.expiresAt);
    if (expiresAt < new Date()) {
      await challengeRef.update({ status: 'expired' });
      return res.status(400).json({
        success: false,
        error: 'Challenge has expired'
      });
    }

    // Update challenge status (always async now, so always 'accepted')
    const newStatus = 'accepted';
    await challengeRef.update({
      status: newStatus,
      acceptedAt: FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      message: 'Challenge accepted',
      challenge: {
        _id: challengeDoc.id,
        ...challengeData,
        status: newStatus
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/challenges/:id/decline
 * Decline a pending challenge
 */
router.post('/:id/decline', verifyToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const uid = req.user.uid;

    const challengeRef = getDb().collection('challenges').doc(id);
    const challengeDoc = await challengeRef.get();

    if (!challengeDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Challenge not found'
      });
    }

    const challengeData = challengeDoc.data();

    // Verify user is the opponent
    if (challengeData.opponentId !== uid) {
      return res.status(403).json({
        success: false,
        error: 'Only the opponent can decline this challenge'
      });
    }

    // Verify challenge is pending
    if (challengeData.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: `Challenge is already ${challengeData.status}`
      });
    }

    // Update challenge status
    await challengeRef.update({
      status: 'cancelled',
      cancelledAt: FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      message: 'Challenge declined'
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/challenges/:id/submit
 * Submit quiz results for a challenge
 */
router.post('/:id/submit', 
  verifyToken,
  [
    body('answers').isArray().withMessage('Answers array is required'),
    body('timeTaken').notEmpty().withMessage('Time taken is required'),
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

      const { id } = req.params;
      const { answers, timeTaken } = req.body;
      const uid = req.user.uid;

      const challengeRef = getDb().collection('challenges').doc(id);
      const challengeDoc = await challengeRef.get();

      if (!challengeDoc.exists) {
        return res.status(404).json({
          success: false,
          error: 'Challenge not found'
        });
      }

      const challengeData = challengeDoc.data();

      // Verify user is involved in this challenge
      if (challengeData.challengerId !== uid && challengeData.opponentId !== uid) {
        return res.status(403).json({
          success: false,
          error: 'Unauthorized - You are not involved in this challenge'
        });
      }

      // Verify challenge is in a valid state
      if (!['accepted', 'in_progress'].includes(challengeData.status)) {
        return res.status(400).json({
          success: false,
          error: `Cannot submit results for challenge with status: ${challengeData.status}`
        });
      }

      // Calculate score
      const score = answers.reduce((sum, answer) => sum + (answer.isCorrect ? 1 : 0), 0);

      // Determine which result to update
      const isChallenger = challengeData.challengerId === uid;
      const resultField = isChallenger ? 'challengerResult' : 'opponentResult';

      // Update challenge with result
      const newResult = {
        score,
        timeTaken,
        answers,
        submittedAt: FieldValue.serverTimestamp()
      };

      const updateData = {
        [resultField]: newResult
      };

      // Check if both players have submitted (after this update)
      const challengerResult = isChallenger ? newResult : challengeData.challengerResult;
      const opponentResult = !isChallenger ? newResult : challengeData.opponentResult;

      if (challengerResult && opponentResult) {
        // Both have submitted - determine winner
        let winner = null;
        let bonusPointsAwarded = false;

        if (challengerResult.score > opponentResult.score) {
          winner = 'challenger';
        } else if (opponentResult.score > challengerResult.score) {
          winner = 'opponent';
        } else {
          // Tie - check time
          const challengerTime = parseTime(challengerResult.timeTaken);
          const opponentTime = parseTime(opponentResult.timeTaken);
          
          if (challengerTime < opponentTime) {
            winner = 'challenger';
          } else if (opponentTime < challengerTime) {
            winner = 'opponent';
          } else {
            winner = 'tie';
          }
        }

        updateData.status = 'completed';
        updateData.winner = winner;
        updateData.completedAt = FieldValue.serverTimestamp();

        // Award points to both players
        const challengerRef = getDb().collection('users').doc(challengeData.challengerId);
        const opponentRef = getDb().collection('users').doc(challengeData.opponentId);

        const [challengerDoc, opponentDoc] = await Promise.all([
          challengerRef.get(),
          opponentRef.get()
        ]);

        // Award bonus points to winner (2x normal points) and normal points to loser
        if (winner && winner !== 'tie') {
          const winnerId = winner === 'challenger' ? challengeData.challengerId : challengeData.opponentId;
          const loserId = winner === 'challenger' ? challengeData.opponentId : challengeData.challengerId;
          const winnerScore = winner === 'challenger' ? challengerResult.score : opponentResult.score;
          const loserScore = winner === 'challenger' ? opponentResult.score : challengerResult.score;
          const bonusPoints = winnerScore * 2; // Winner gets 2x points

          // Update winner's points (bonus)
          const winnerRef = getDb().collection('users').doc(winnerId);
          const winnerDoc = await winnerRef.get();
          if (winnerDoc.exists) {
            const currentPoints = winnerDoc.data().userPoints || 0;
            await winnerRef.update({
              userPoints: currentPoints + bonusPoints,
              totalScore: (winnerDoc.data().totalScore || 0) + bonusPoints
            });
          }

          // Update loser's points (normal)
          const loserRef = getDb().collection('users').doc(loserId);
          const loserDoc = await loserRef.get();
          if (loserDoc.exists) {
            const currentPoints = loserDoc.data().userPoints || 0;
            await loserRef.update({
              userPoints: currentPoints + loserScore,
              totalScore: (loserDoc.data().totalScore || 0) + loserScore
            });
          }

          updateData.bonusPointsAwarded = true;
        } else {
          // Tie - both get normal points
          if (challengerDoc.exists) {
            const currentPoints = challengerDoc.data().userPoints || 0;
            await challengerRef.update({
              userPoints: currentPoints + challengerResult.score,
              totalScore: (challengerDoc.data().totalScore || 0) + challengerResult.score
            });
          }

          if (opponentDoc.exists) {
            const currentPoints = opponentDoc.data().userPoints || 0;
            await opponentRef.update({
              userPoints: currentPoints + opponentResult.score,
              totalScore: (opponentDoc.data().totalScore || 0) + opponentResult.score
            });
          }
        }
      } else {
        // Only one has submitted - update status to in_progress if it was accepted
        if (challengeData.status === 'accepted') {
          updateData.status = 'in_progress';
        }
      }

      await challengeRef.update(updateData);

      // Get updated challenge
      const updatedDoc = await challengeRef.get();

      res.json({
        success: true,
        message: 'Results submitted successfully',
        challenge: {
          _id: updatedDoc.id,
          ...updatedDoc.data()
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PATCH /api/challenges/:id/cancel
 * Cancel a challenge (only challenger can cancel)
 */
router.patch('/:id/cancel', verifyToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const uid = req.user.uid;

    const challengeRef = getDb().collection('challenges').doc(id);
    const challengeDoc = await challengeRef.get();

    if (!challengeDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Challenge not found'
      });
    }

    const challengeData = challengeDoc.data();

    // Verify user is the challenger
    if (challengeData.challengerId !== uid) {
      return res.status(403).json({
        success: false,
        error: 'Only the challenger can cancel this challenge'
      });
    }

    // Verify challenge can be cancelled
    if (!['pending', 'accepted'].includes(challengeData.status)) {
      return res.status(400).json({
        success: false,
        error: `Cannot cancel challenge with status: ${challengeData.status}`
      });
    }

    // Update challenge status
    await challengeRef.update({
      status: 'cancelled',
      cancelledAt: FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      message: 'Challenge cancelled'
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Helper function to parse time string (MM:SS or HH:MM:SS)
 */
function parseTime(timeString) {
  if (!timeString) return Infinity;
  
  const parts = timeString.split(':').map(Number);
  if (parts.length === 2) {
    // MM:SS format
    return parts[0] * 60 + parts[1];
  } else if (parts.length === 3) {
    // HH:MM:SS format
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return Infinity;
}

module.exports = router;
