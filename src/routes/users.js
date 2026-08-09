const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middleware/auth");
const { getDb, FieldValue } = require("../db");
const authService = require("../services/authService");

const ADMIN_ROLES = ["Admin", "Institute Admin"];

const getCurrentUserData = async (uid) => {
  const userDoc = await getDb().collection("users").doc(uid).get();
  if (!userDoc.exists) return null;
  return userDoc.data();
};

const canAccessUser = (currentUser, targetUserId, targetUserData) => {
  if (currentUser.uid === targetUserId) return true;
  if (!ADMIN_ROLES.includes(currentUser.role)) return false;
  if (currentUser.role === "Admin") return true;
  return (
    currentUser.instituteCode &&
    targetUserData?.instituteCode === currentUser.instituteCode
  );
};

/**
 * GET /api/users?instituteCode=XXX
 * List users for an institute (Institute Admin / Admin only)
 */
router.get("/", verifyToken, async (req, res, next) => {
  try {
    const { instituteCode } = req.query;
    const uid = req.user.uid;
    const currentUserData = await getCurrentUserData(uid);

    if (!currentUserData) {
      return res
        .status(404)
        .json({ success: false, error: "Current user not found" });
    }

    if (!instituteCode) {
      return res.status(400).json({
        success: false,
        error: "instituteCode query parameter is required",
      });
    }

    if (
      currentUserData.role !== "Admin" &&
      currentUserData.instituteCode !== instituteCode
    ) {
      return res.status(403).json({
        success: false,
        error: "Unauthorized - You can only list users in your institute",
      });
    }

    const snapshot = await getDb()
      .collection("users")
      .where("instituteCode", "==", instituteCode)
      .get();

    const users = [];
    snapshot.forEach((doc) => {
      users.push({ id: doc.id, _id: doc.id, ...doc.data() });
    });

    res.json({ success: true, users, count: users.length });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/users/:id
 * Get user data
 */
router.get("/:id", verifyToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const uid = req.user.uid;
    const currentUserData = await getCurrentUserData(uid);

    const userDoc = await getDb().collection("users").doc(id).get();

    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    const targetUserData = userDoc.data();
    if (
      id !== uid &&
      !canAccessUser(
        {
          uid,
          role: currentUserData?.role,
          instituteCode: currentUserData?.instituteCode,
        },
        id,
        targetUserData,
      )
    ) {
      return res.status(403).json({
        success: false,
        error: "Unauthorized - You can only access your own user data",
      });
    }

    res.json({
      success: true,
      user: { id: userDoc.id, ...targetUserData },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/users
 * Create a new user (for admin/institute admin to add users)
 */
router.post("/", verifyToken, async (req, res, next) => {
  try {
    const {
      email,
      password,
      name,
      role,
      educationLevel,
      instituteCode,
      instituteName,
    } = req.body;
    const currentUserUid = req.user.uid;

    // Get current user to check permissions and get institute info
    const currentUserDoc = await getDb()
      .collection("users")
      .doc(currentUserUid)
      .get();
    if (!currentUserDoc.exists) {
      return res.status(404).json({
        success: false,
        error: "Current user not found",
      });
    }

    const currentUserData = currentUserDoc.data();
    const userInstituteCode = instituteCode || currentUserData.instituteCode;
    const userInstituteName = instituteName || currentUserData.instituteName;

    const userRecord = await authService.createUser({
      email: email,
      password: password,
      displayName: name,
    });

    // Create user document in Supabase database
    const newUser = {
      uid: userRecord.uid,
      name: name,
      email: email,
      role: role,
      educationLevel: educationLevel || (role === "Level-1" ? "Teacher" : null),
      instituteCode: userInstituteCode,
      instituteName: userInstituteName,
      isActive: true,
      createdAt: FieldValue.serverTimestamp(),
    };

    await getDb().collection("users").doc(userRecord.uid).set(newUser);

    res.json({
      success: true,
      message: "User created successfully",
      user: { id: userRecord.uid, ...newUser },
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
});

/**
 * PUT /api/users/:id
 * Update user data
 */
router.put("/:id", verifyToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const uid = req.user.uid;
    const updateData = req.body;

    // Users can only update their own data (or admin can update any)
    // For now, allow updating if it's own data or if current user is institute admin
    if (id !== uid) {
      const currentUserDoc = await getDb().collection("users").doc(uid).get();
      if (!currentUserDoc.exists) {
        return res.status(403).json({
          success: false,
          error: "Unauthorized",
        });
      }
      const currentUserData = currentUserDoc.data();
      // Allow institute admin to update users in their institute
      if (
        currentUserData.role !== "Institute Admin" &&
        currentUserData.role !== "Admin"
      ) {
        return res.status(403).json({
          success: false,
          error: "Unauthorized - You can only update your own user data",
        });
      }
    }

    // Remove sensitive fields that shouldn't be updated via this endpoint
    delete updateData.uid;
    delete updateData.email;

    const userRef = getDb().collection("users").doc(id);
    await userRef.update({
      ...updateData,
      updatedAt: FieldValue.serverTimestamp(),
    });

    res.json({
      success: true,
      message: "User data updated successfully",
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/users/:id
 * Delete a user (Institute Admin / Admin only)
 */
router.delete("/:id", verifyToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const uid = req.user.uid;
    const currentUserData = await getCurrentUserData(uid);

    if (!currentUserData || !ADMIN_ROLES.includes(currentUserData.role)) {
      return res.status(403).json({
        success: false,
        error: "Unauthorized",
      });
    }

    const targetDoc = await getDb().collection("users").doc(id).get();
    if (!targetDoc.exists) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    const targetData = targetDoc.data();
    if (
      currentUserData.role === "Institute Admin" &&
      targetData.instituteCode !== currentUserData.instituteCode
    ) {
      return res.status(403).json({
        success: false,
        error: "Unauthorized - User is not in your institute",
      });
    }

    await authService.deleteUser(id);
    await getDb().collection("users").doc(id).delete();

    res.json({ success: true, message: "User deleted successfully" });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
