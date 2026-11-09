require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const errorHandler = require('./middleware/errorHandler');

// Initialize Supabase
require('./config/supabase');

// Import routes
const authRoutes = require('./routes/auth');
const rewardsRoutes = require('./routes/rewards');
const emailRoutes = require('./routes/email');
const llmRoutes = require('./routes/llm');
const projectsRoutes = require('./routes/projects');
const usersRoutes = require('./routes/users');
const studyPlansRoutes = require('./routes/studyPlans');
const quizResultsRoutes = require('./routes/quizResults');
const instituteDetailsRoutes = require('./routes/instituteDetails');
const redemptionsRoutes = require('./routes/redemptions');
const challengesRoutes = require('./routes/challenges');
const dailyQuestionsRoutes = require('./routes/dailyQuestions');
const syllabusRoutes = require('./routes/syllabus');
const eventsRoutes = require('./routes/events');
const gamingRoutes = require('./routes/gaming');

const app = express();
const PORT = process.env.PORT || 5002;

// Security middleware - configure helmet to allow CORS
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginEmbedderPolicy: false,
}));

// CORS configuration
const getAllowedOrigins = () => {
  const origins = [];
  
  // Add frontend URL
  if (process.env.FRONTEND_URL) {
    origins.push(process.env.FRONTEND_URL);
  }
  
  // Add admin URL
  if (process.env.ADMIN_URL) {
    origins.push(process.env.ADMIN_URL);
  }
  
  // Add CORS_ORIGIN if specified (supports comma-separated values)
  if (process.env.CORS_ORIGIN) {
    const corsOrigins = process.env.CORS_ORIGIN.split(',').map(origin => origin.trim());
    origins.push(...corsOrigins);
  }
  
  // Production URLs (hardcoded for Vercel deployments)
  // Uncomment when deploying to production:
  // origins.push('https://truesight-challenge-release2.vercel.app');
  // origins.push('https://truesight-challenge-hvhpdjlka-lavshashank431-gmailcoms-projects.vercel.app');
  // origins.push('https://truesight-challenge-red.vercel.app');
  // origins.push('https://truesight-backend-release2.vercel.app');
  // Gaming production URLs (add your gaming Vercel URL when deployed):
  // origins.push('https://your-gaming-frontend.vercel.app');

  // Local development
  if (process.env.NODE_ENV !== 'production') {
    origins.push('http://localhost:3000', 'http://localhost:3001');
  }
  
  // Remove duplicates
  return [...new Set(origins)];
};

const corsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = getAllowedOrigins();
    
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) {
      return callback(null, true);
    }
    
    // Normalize origin (remove trailing slash)
    const normalizedOrigin = origin.replace(/\/$/, '');

    // Entries may contain "*" wildcards, e.g. https://truesight-gaming-*.vercel.app
    // for Vercel preview deployments.
    const matches = (allowed) => {
      const a = allowed.replace(/\/$/, '');
      if (!a.includes('*')) return a === normalizedOrigin;
      const re = new RegExp('^' + a.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
      return re.test(normalizedOrigin);
    };

    const isAllowed = allowedOrigins.length === 0 || allowedOrigins.some(matches);

    if (isAllowed) {
      callback(null, true);
    } else {
      // Reject without throwing: throwing turns every blocked preflight into a
      // 500 with no CORS headers, which the browser reports as a network error.
      console.warn(`CORS blocked origin: ${origin}. Allowed origins:`, allowedOrigins);
      callback(null, false);
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Truesight Gaming Backend API is running',
    timestamp: new Date().toISOString()
  });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/rewards', rewardsRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/llm', llmRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/study-plans', studyPlansRoutes);
app.use('/api/quiz-results', quizResultsRoutes);
app.use('/api/institute-details', instituteDetailsRoutes);
app.use('/api/redemptions', redemptionsRoutes);
app.use('/api/challenges', challengesRoutes);
app.use('/api/daily-questions', dailyQuestionsRoutes);
app.use('/api/syllabus', syllabusRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/gaming', gamingRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found'
  });
});

// Error handling middleware (must be last)
app.use(errorHandler);

// Start a listener only when run directly (`npm start` / `npm run dev`).
// On Vercel the app is imported as a serverless handler and must not listen.
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`Backend server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });

  // Handle port conflicts gracefully
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`
❌ Port ${PORT} is already in use!`);
      console.log(`
To fix this, run one of the following:`);
      console.log(`1. Kill the process: lsof -ti:${PORT} | xargs kill -9`);
      console.log(`2. Use the helper script: ./kill-port.sh`);
      console.log(`3. Change the port in .env: PORT=5001
`);
      process.exit(1);
    } else {
      throw err;
    }
  });
}

module.exports = app;

