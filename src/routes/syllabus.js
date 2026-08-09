const express = require('express');
const router = express.Router();
const multer = require('multer');
const { verifyToken } = require('../middleware/auth');
const { getDb } = require('../db');
const { parseSyllabusToMindMap } = require('../services/llmService');

// Store PDF in memory, max 10MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  },
});

/**
 * POST /api/syllabus/upload
 * Upload a PDF syllabus, parse it, generate mind map, store in Supabase database
 */
router.post('/upload', verifyToken, upload.single('syllabus'), async (req, res, next) => {
  console.log("=== SYLLABUS UPLOAD START ===");
  try {
    if (!req.file) {
      console.error("Syllabus upload error: No file attached to req.file");
      return res.status(400).json({ success: false, error: 'No PDF file uploaded' });
    }

    const uid = req.user.uid;
    console.log(`User UID: ${uid}`);
    console.log(`File attached: ${req.file.originalname}, MIME: ${req.file.mimetype}, Size: ${req.file.size} bytes`);

    // Dynamically require pdf-parse to avoid issues with test environments
    console.log("Loading pdf-parse module...");
    const pdfParse = require('pdf-parse');
    let pdfText;
    try {
      console.log("Attempting to parse PDF buffer...");
      const pdfData = await pdfParse(req.file.buffer);
      pdfText = pdfData.text;
      console.log(`PDF parse successful. Total text length extracted: ${pdfText ? pdfText.length : 0} characters.`);
    } catch (parseErr) {
      console.error("PDF parse failed with error:", parseErr);
      return res.status(400).json({ success: false, error: 'Failed to read PDF. Ensure it contains selectable text.' });
    }

    if (!pdfText || pdfText.trim().length < 50) {
      console.error(`PDF content length check failed. Text length: ${pdfText ? pdfText.trim().length : 0}`);
      return res.status(400).json({ success: false, error: 'PDF appears to be empty or contains only images. Please upload a text-based PDF.' });
    }

    // Generate mind map from syllabus text
    console.log("Calling Gemini LLM service parseSyllabusToMindMap...");
    const mindmap = await parseSyllabusToMindMap(pdfText);
    console.log("Gemini LLM returned mindmap response:", JSON.stringify(mindmap, null, 2));

    if (!mindmap || !mindmap.topics || mindmap.topics.length === 0) {
      console.error("LLM validation error: Mindmap is empty or has zero topics");
      return res.status(500).json({ success: false, error: 'Could not extract topics from the syllabus. Please try a different PDF.' });
    }

    const syllabusDoc = {
      filename: req.file.originalname,
      uploadedAt: new Date().toISOString(),
      mindmap,
    };

    // Store under users/{uid} as a subcollection document
    console.log("Attempting to write syllabus to Supabase database path: users/" + uid + "/syllabus/current");
    await getDb().collection('users').doc(uid).collection('syllabus').doc('current').set(syllabusDoc);
    console.log("Supabase database write successful!");

    console.log("=== SYLLABUS UPLOAD SUCCESS ===");
    res.json({ success: true, syllabus: syllabusDoc });
  } catch (error) {
    console.error("Uncaught exception in syllabus upload route:", error);
    next(error);
  }
});

/**
 * GET /api/syllabus
 * Get current user's syllabus mind map
 */
router.get('/', verifyToken, async (req, res, next) => {
  try {
    const uid = req.user.uid;
    const docRef = getDb().collection('users').doc(uid).collection('syllabus').doc('current');
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.json({ success: true, syllabus: null });
    }

    res.json({ success: true, syllabus: doc.data() });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/syllabus
 * Delete the user's syllabus
 */
router.delete('/', verifyToken, async (req, res, next) => {
  try {
    const uid = req.user.uid;
    await getDb().collection('users').doc(uid).collection('syllabus').doc('current').delete();
    res.json({ success: true, message: 'Syllabus deleted' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
