/**
 * Error handling middleware
 */
const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal server error';
  let isCredentialError = false;

  if (err.name === 'ValidationError') {
    statusCode = 400;
    message = err.message;
  }

  if (err.code && err.code.startsWith('auth/')) {
    statusCode = 401;
    message = err.message;
  }

  if (
    err.message &&
    (err.message.includes('Supabase not initialized') ||
      err.message.includes('Supabase credentials not configured') ||
      err.message.includes('Invalid API key'))
  ) {
    statusCode = 503;
    message =
      'Supabase credentials not configured. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your .env file.';
    isCredentialError = true;

    console.error('\n⚠️  Supabase credential error:');
    console.error('   Route:', req.method, req.path);
    console.error('');
  } else {
    console.error('Error:', err);
  }

  if (err.code === 'PGRST301' || err.code === '42501' || err.code === 'PERMISSION_DENIED') {
    statusCode = 403;
    message = 'Permission denied. Check Supabase RLS policies.';
  }

  res.status(statusCode).json({
    success: false,
    error: message,
    ...(process.env.NODE_ENV === 'development' &&
      !isCredentialError && {
        stack: err.stack,
        code: err.code,
        details: err.details,
      }),
  });
};

module.exports = errorHandler;
