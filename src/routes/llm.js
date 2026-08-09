const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { verifyToken } = require('../middleware/auth');
const { 
  callLLM, 
  generateMoreSubtopics, 
  generateDetailedReport, 
  validateProjectTopic,
  generateQuizQuestions,
  generateDailyQuestion
} = require('../services/llmService');

/**
 * Middleware to handle validation errors
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }
  next();
};

/**
 * POST /api/llm/generate-study-plan
 */
router.post('/generate-study-plan',
  verifyToken,
  [
    body('role').notEmpty().withMessage('Role is required'),
    body('country').notEmpty().withMessage('Country/topic is required'),
    body('numWords').optional().isInt({ min: 0 }),
    body('temp').optional().isFloat({ min: 0, max: 2 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { role, country, numWords, temp = 1.0 } = req.body;
      const result = await callLLM(role, country, numWords, temp);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/llm/generate-subtopics
 */
router.post('/generate-subtopics',
  verifyToken,
  [
    body('topicName').notEmpty().withMessage('Topic name is required'),
    body('existingSubtopics').isArray().withMessage('Existing subtopics must be an array'),
    body('temp').optional().isFloat({ min: 0, max: 2 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { topicName, existingSubtopics = [], temp = 1.0 } = req.body;
      const result = await generateMoreSubtopics(topicName, existingSubtopics, temp);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/llm/generate-report
 */
router.post('/generate-report',
  verifyToken,
  [
    body('subtopic').notEmpty().withMessage('Subtopic is required'),
    body('keyConcepts').isArray().withMessage('Key concepts must be an array'),
    body('temp').optional().isFloat({ min: 0, max: 2 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { subtopic, keyConcepts, temp = 1.0 } = req.body;
      const result = await generateDetailedReport(subtopic, keyConcepts, temp);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/llm/validate-topic
 */
router.post('/validate-topic',
  verifyToken,
  [
    body('topic').notEmpty().withMessage('Topic is required'),
    body('levelOfLearning').notEmpty().withMessage('Level of learning is required'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { topic, levelOfLearning } = req.body;
      const result = await validateProjectTopic(topic, levelOfLearning);
      res.json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/llm/generate-quiz-questions
 */
router.post('/generate-quiz-questions',
  verifyToken,
  [
    body('topicName').notEmpty().withMessage('Topic name is required'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { topicName, projectTopic } = req.body;
      const questions = await generateQuizQuestions(topicName, projectTopic);
      
      if (Array.isArray(questions) && questions.length > 0) {
        // Basic validation of question structure
        const validQuestions = questions.filter(q => 
          q.question && 
          Array.isArray(q.options) && q.options.length === 4 && 
          q.correctAnswer
        );
        
        if (validQuestions.length > 0) {
          return res.json({
            success: true,
            questions: validQuestions.slice(0, 5)
          });
        }
      }
      throw new Error('Failed to generate valid quiz questions');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/llm/daily-question
 */
router.get('/daily-question',
  verifyToken,
  async (req, res, next) => {
    try {
      const question = await generateDailyQuestion();
      res.json({ success: true, data: question });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
