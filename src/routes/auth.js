const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middleware/auth");
const { getDb, FieldValue, getSupabaseAnon } = require("../db");
const authService = require("../services/authService");
const { body, validationResult } = require("express-validator");

/**
 * POST /api/auth/login
 * Login with email and password
 */
router.post(
  "/login",
  [
    body("email").isEmail().withMessage("Valid email is required"),
    body("password").notEmpty().withMessage("Password is required"),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array(),
        });
      }

      const { email, password, force } = req.body;
      const supabaseAnon = getSupabaseAnon();

      const { data: authData, error: authError } =
        await supabaseAnon.auth.signInWithPassword({
          email,
          password,
        });

      if (authError || !authData.session) {
        return res.status(401).json({
          success: false,
          error: authError?.message || "Invalid email or password",
        });
      }

      const uid = authData.user.id;
      const idToken = authData.session.access_token;
      const userEmail = authData.user.email;

      // Note: We skip authService.getUser() because:
      // 1. We already verified the user via REST API (uid is valid)
      // 2. Service account may not have Identity Toolkit permissions
      // 3. We can use the uid directly from the REST API response

      // Get user data from Supabase database
      const db = getDb();
      const userDoc = await db.collection("users").doc(uid).get();
      if (!userDoc.exists) {
        return res.status(404).json({
          success: false,
          error:
            "User data not found in database. Please contact administrator.",
        });
      }

      const userData = userDoc.data();

      // Check for active sessions
      const sessionsRef = getDb().collection("sessions");
      const sessionsQuery = await sessionsRef.where("uid", "==", uid).get();

      if (!sessionsQuery.empty) {
        // Check if any session is active (not stale)
        const now = Date.now();
        const STALE_SESSION_THRESHOLD = 30 * 60 * 1000; // 30 minutes
        let hasActiveSession = false;

        sessionsQuery.docs.forEach((doc) => {
          const sessionData = doc.data();
          const timestamp = sessionData.timestamp;
          if (timestamp) {
            const timestampMs = timestamp.toDate
              ? timestamp.toDate().getTime()
              : new Date(timestamp).getTime();
            const age = now - timestampMs;
            if (age < STALE_SESSION_THRESHOLD) {
              hasActiveSession = true;
            }
          }
        });

        if (hasActiveSession) {
          if (force) {
            // Force logout from other devices: delete all active sessions for this user
            const activityLogsRef = getDb().collection("userActivityLogs");
            const nowString = new Date().toISOString();

            const deletePromises = sessionsQuery.docs.map(async (doc) => {
              const data = doc.data();
              if (data.sessionId) {
                await activityLogsRef
                  .doc(data.sessionId)
                  .update({
                    logoutTime: nowString,
                    lastActivity: nowString,
                    status: "forced_logout",
                  })
                  .catch((e) => console.error("Error updating log:", e));
              }
              return doc.ref.delete();
            });
            await Promise.all(deletePromises);
            console.log(
              `Forced logout for user ${uid}: ${deletePromises.length} sessions cleared`,
            );
          } else {
            return res.status(403).json({
              success: false,
              code: "SESSION_ALREADY_ACTIVE",
              error:
                "Another session is already active. Please log out from other devices first.",
            });
          }
        }
      }

      // Create new session
      const sessionId = `${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
      const nowString = new Date().toISOString();
      await sessionsRef.add({
        uid: uid,
        sessionId: sessionId,
        timestamp: FieldValue.serverTimestamp(),
        lastActivity: nowString,
        userAgent: req.headers["user-agent"],
        createdAt: nowString,
      });

      // Also create an activity log entry
      const activityLogsRef = getDb().collection("userActivityLogs");
      await activityLogsRef.doc(sessionId).set({
        uid: uid,
        email: userEmail || email,
        sessionId: sessionId,
        loginTime: nowString,
        lastActivity: nowString,
        status: "active",
      });

      res.json({
        success: true,
        token: idToken,
        user: {
          uid: uid,
          email: userEmail || email,
          ...userData,
        },
        sessionId: sessionId,
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /api/auth/register
 * Register a new user
 */
router.post(
  "/register",
  [
    body("email").isEmail().withMessage("Valid email is required"),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
    body("name").notEmpty().withMessage("Name is required"),
    body("instituteName").notEmpty().withMessage("Institute name is required"),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array(),
        });
      }

      const { email, password, name, phone, instituteName } = req.body;

      // Check if institute code already exists
      const generateInstituteCode = async (name) => {
        let unique = false;
        let newCode = "";
        while (!unique) {
          const chars = name
            ? name.replace(/\s+/g, "").substring(0, 3).toUpperCase()
            : "";
          const numbers = Math.floor(Math.random() * 900 + 100);
          newCode = `${chars}${numbers}`;

          const existingUsers = await getDb()
            .collection("users")
            .where("instituteCode", "==", newCode)
            .get();
          unique = existingUsers.empty;
        }
        return newCode;
      };

      const instituteCode = await generateInstituteCode(instituteName);

      let uid;
      let idToken;

      try {
        const userRecord = await authService.createUser({
          email,
          password,
          displayName: name,
        });
        uid = userRecord.uid;

        const supabaseAnon = getSupabaseAnon();
        const { data: signInData, error: signInError } =
          await supabaseAnon.auth.signInWithPassword({
            email,
            password,
          });
        if (signInError) {
          throw signInError;
        }
        idToken = signInData.session.access_token;
      } catch (error) {
        if (error.code === "auth/email-already-exists") {
          return res.status(400).json({
            success: false,
            error: "Email already registered",
          });
        }
        throw error;
      }

      // Create user document in Supabase database
      await getDb()
        .collection("users")
        .doc(uid)
        .set({
          name: name || null,
          email: email,
          phone: phone || null,
          photoURL: null,
          instituteName: instituteName,
          instituteCode: instituteCode,
          role: "Institute Admin",
          createdAt: FieldValue.serverTimestamp(),
          isActive: true,
        });

      res.json({
        success: true,
        message: "Registration successful",
        token: idToken, // Return ID token instead of custom token
        user: {
          uid: uid,
          email: email,
          name: name,
          instituteName: instituteName,
          instituteCode: instituteCode,
          role: "Institute Admin",
        },
      });
    } catch (error) {
      if (error.code === "auth/email-already-exists") {
        return res.status(400).json({
          success: false,
          error: "Email already registered",
        });
      }
      next(error);
    }
  },
);

/**
 * POST /api/auth/logout
 * Logout and delete session
 */
router.post("/logout", verifyToken, async (req, res, next) => {
  try {
    const uid = req.user.uid;

    // Delete all sessions for this user
    const sessionsRef = getDb().collection("sessions");
    const sessionsQuery = await sessionsRef.where("uid", "==", uid).get();

    // Also update activity log
    const activityLogsRef = getDb().collection("userActivityLogs");
    const nowString = new Date().toISOString();

    const deletePromises = sessionsQuery.docs.map(async (doc) => {
      const data = doc.data();
      if (data.sessionId) {
        await activityLogsRef
          .doc(data.sessionId)
          .update({
            logoutTime: nowString,
            lastActivity: nowString,
            status: "completed",
          })
          .catch((e) => console.error("Error updating log:", e));
      }
      return doc.ref.delete();
    });
    await Promise.all(deletePromises);

    res.json({
      success: true,
      message: "Logged out successfully",
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/session/update
 * Update session timestamp
 */
router.post("/session/update", verifyToken, async (req, res, next) => {
  try {
    const uid = req.user.uid;

    // Find and update session
    const sessionsRef = getDb().collection("sessions");
    const sessionsQuery = await sessionsRef.where("uid", "==", uid).get();

    if (!sessionsQuery.empty) {
      const activityLogsRef = getDb().collection("userActivityLogs");
      const nowString = new Date().toISOString();

      const updatePromises = sessionsQuery.docs.map(async (doc) => {
        const data = doc.data();
        if (data.sessionId) {
          await activityLogsRef
            .doc(data.sessionId)
            .update({
              lastActivity: nowString,
            })
            .catch((e) => console.error("Error updating log:", e));
        }
        return doc.ref.update({
          timestamp: FieldValue.serverTimestamp(),
          lastActivity: nowString,
        });
      });
      await Promise.all(updatePromises);
    }

    res.json({
      success: true,
      message: "Session updated",
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/forgot-password
 * Send password reset email
 */
router.post(
  "/forgot-password",
  [body("email").isEmail().withMessage("Valid email is required")],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array(),
        });
      }

      const { email } = req.body;

      // Get user by email
      let userRecord;
      try {
        userRecord = await authService.getUserByEmail(email);
      } catch (error) {
        if (error.code === "auth/user-not-found") {
          // Don't reveal if user exists or not for security
          return res.json({
            success: true,
            message:
              "If an account exists with this email, a password reset link has been sent.",
          });
        }
        throw error;
      }

      // Generate password reset link
      const frontendUrl = (
        process.env.FRONTEND_URL || "http://localhost:3000"
      ).trim();

      // Ensure the URL is valid and has a protocol
      let resetUrl;
      try {
        resetUrl = new URL("/resetpassword", frontendUrl).toString();
      } catch (err) {
        console.error("Invalid FRONTEND_URL:", frontendUrl);
        resetUrl = "http://localhost:3000/resetpassword";
      }

      const actionCodeSettings = {
        url: resetUrl,
        handleCodeInApp: true,
      };

      console.log(
        `Generating password reset link for ${email} with continue URL: ${resetUrl}`,
      );
      const link = await authService.generatePasswordResetLink(
        email,
        actionCodeSettings,
      );

      // In a real implementation, you would send this link via email
      // For now, we'll return it (you should use emailService here)
      res.json({
        success: true,
        message: "Password reset link generated",
        resetLink: link, // Remove this in production, send via email instead
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /api/auth/verify-reset-code
 * Verify password reset code
 */
router.post(
  "/verify-reset-code",
  [body("oobCode").notEmpty().withMessage("Reset code is required")],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array(),
        });
      }

      const { oobCode } = req.body;
      const supabase = require("../config/supabase").getSupabase();

      const { data, error } = await supabase.auth.verifyOtp({
        token_hash: oobCode,
        type: "recovery",
      });

      if (error) {
        return res.status(400).json({
          success: false,
          error: error.message || "Invalid or expired reset code",
        });
      }

      res.json({
        success: true,
        email: data.user?.email,
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /api/auth/confirm-reset-password
 * Confirm password reset with new password
 */
router.post(
  "/confirm-reset-password",
  [
    body("oobCode").notEmpty().withMessage("Reset code is required"),
    body("newPassword")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array(),
        });
      }

      const { oobCode, newPassword } = req.body;
      const supabase = require("../config/supabase").getSupabase();

      const { data, error } = await supabase.auth.verifyOtp({
        token_hash: oobCode,
        type: "recovery",
      });

      if (error || !data.user) {
        return res.status(400).json({
          success: false,
          error: error?.message || "Invalid or expired reset code",
        });
      }

      const { error: updateError } = await supabase.auth.admin.updateUserById(
        data.user.id,
        {
          password: newPassword,
        },
      );

      if (updateError) {
        return res.status(400).json({
          success: false,
          error: updateError.message || "Failed to reset password",
        });
      }

      res.json({
        success: true,
        message: "Password reset successfully",
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /api/auth/verify
 * Verify Firebase ID token
 */
router.post("/verify", verifyToken, async (req, res, next) => {
  try {
    res.json({
      success: true,
      user: req.user,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/user
 * Get user info from token
 */
router.post("/user", verifyToken, async (req, res, next) => {
  try {
    const userRecord = await authService.getUser(req.user.uid);
    const userDoc = await getDb().collection("users").doc(req.user.uid).get();

    const userData = userDoc.exists ? userDoc.data() : {};

    res.json({
      success: true,
      user: {
        uid: userRecord.uid,
        email: userRecord.email,
        displayName: userRecord.displayName,
        photoURL: userRecord.photoURL,
        ...userData,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/verify-password
 * Verify current password of the logged-in user
 */
/**
 * POST /api/auth/change-password
 * Change password for the logged-in user
 */
router.post(
  "/change-password",
  verifyToken,
  [
    body("currentPassword")
      .notEmpty()
      .withMessage("Current password is required"),
    body("newPassword")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { currentPassword, newPassword } = req.body;
      const email = req.user.email;
      const supabaseAnon = getSupabaseAnon();

      const { error: verifyError } = await supabaseAnon.auth.signInWithPassword(
        {
          email,
          password: currentPassword,
        },
      );

      if (verifyError) {
        return res.status(400).json({
          success: false,
          error: "Incorrect current password",
        });
      }

      await authService.updateUser(req.user.uid, { password: newPassword });

      res.json({ success: true, message: "Password updated successfully" });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/verify-password",
  verifyToken,
  [body("password").notEmpty().withMessage("Password is required")],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array(),
        });
      }

      const { password } = req.body;
      const email = req.user.email;
      const supabaseAnon = getSupabaseAnon();

      const { error } = await supabaseAnon.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        return res.status(400).json({
          success: false,
          error: "Incorrect password",
        });
      }

      res.json({
        success: true,
        message: "Password verified successfully",
      });
    } catch (error) {
      next(error);
    }
  },
);

module.exports = router;
