const { getSupabase, getSupabaseAnon } = require('../config/supabase');

/**
 * Middleware to verify Supabase JWT access token
 */
const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized - Missing or invalid authorization token',
      });
    }

    const token = authHeader.split('Bearer ')[1];
    const supabase = getSupabase();
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized - Invalid or expired token',
      });
    }

    req.user = {
      uid: data.user.id,
      email: data.user.email,
      ...data.user,
    };

    next();
  } catch (error) {
    console.error('Error verifying token:', error);
    return res.status(401).json({
      success: false,
      error: 'Unauthorized - Invalid or expired token',
    });
  }
};

/**
 * Optional authentication middleware
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split('Bearer ')[1];
      const supabase = getSupabase();

      try {
        const { data, error } = await supabase.auth.getUser(token);
        if (!error && data.user) {
          req.user = {
            uid: data.user.id,
            email: data.user.email,
            ...data.user,
          };
        } else {
          req.user = null;
        }
      } catch (error) {
        console.warn('Optional auth token invalid:', error.message);
        req.user = null;
      }
    } else {
      req.user = null;
    }

    next();
  } catch (error) {
    req.user = null;
    next();
  }
};

module.exports = {
  verifyToken,
  optionalAuth,
};
