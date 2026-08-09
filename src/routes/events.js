const express = require('express');
const router = express.Router();
const { verifyToken, optionalAuth } = require('../middleware/auth');
const { getDb, FieldValue, getSupabaseAnon } = require('../db');
const authService = require('../services/authService');
const { body, validationResult } = require('express-validator');

/**
 * GET /api/events
 * Get all published events accessible to the authenticated user
 */
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const uid = req.user ? req.user.uid : null;

    let userData = null;
    let userRole = 'Level-2'; // Default to Level-2 Student
    let userInstituteCode = null;

    if (uid) {
      // Get user details to filter events
      const userDoc = await getDb().collection('users').doc(uid).get();
      if (userDoc.exists) {
        userData = userDoc.data();
        userRole = userData.role || 'Level-2';
        userInstituteCode = userData.instituteCode || null;
      }
    }

    // Query published events
    const eventsRef = getDb().collection('events');
    const snapshot = await eventsRef
      .where('status', '==', 'published')
      .orderBy('dateTimeStart', 'asc')
      .get();

    const events = [];
    
    // Check user registrations in parallel
    const registeredEventIds = new Set();
    if (uid) {
      const rsvpSnapshot = await getDb().collection('eventRegistrations')
        .where('userId', '==', uid)
        .get();
      
      rsvpSnapshot.forEach(doc => {
        registeredEventIds.add(doc.data().eventId);
      });
    }

    snapshot.forEach(doc => {
      const data = doc.data();
      const eventId = doc.id;

      // Access control checks:
      // 1. Target Audience filter
      const matchesAudience = 
        data.targetAudience === 'all' || 
        (uid && (
          data.targetAudience === userRole ||
          userRole === 'Admin' || 
          userRole === 'Institute Admin'
        ));

      // 2. Institution restriction filter
      const matchesInstitute = 
        !data.targetInstituteCodes || 
        data.targetInstituteCodes.length === 0 || 
        (uid && (
          data.targetInstituteCodes.includes(userInstituteCode) ||
          userRole === 'Admin' || 
          userRole === 'Institute Admin'
        ));

      if (matchesAudience && matchesInstitute) {
        events.push({
          id: eventId,
          ...data,
          isRegistered: registeredEventIds.has(eventId),
          dateTimeStart: data.dateTimeStart?.toDate ? data.dateTimeStart.toDate().toISOString() : data.dateTimeStart,
          dateTimeEnd: data.dateTimeEnd?.toDate ? data.dateTimeEnd.toDate().toISOString() : data.dateTimeEnd,
          registrationDeadline: data.registrationDeadline?.toDate ? data.registrationDeadline.toDate().toISOString() : data.registrationDeadline,
        });
      }
    });

    res.json({
      success: true,
      events,
      count: events.length
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/events/:id
 * Get details for a specific event
 */
router.get('/:id', verifyToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const uid = req.user.uid;

    const eventDoc = await getDb().collection('events').doc(id).get();
    if (!eventDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Event not found'
      });
    }

    const eventData = eventDoc.data();

    // Check if user is registered
    const registrationId = `${id}_${uid}`;
    const registrationDoc = await getDb().collection('eventRegistrations').doc(registrationId).get();
    const isRegistered = registrationDoc.exists;

    // Check user profile for role checks
    const userDoc = await getDb().collection('users').doc(uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const userRole = userData.role || 'Level-2';

    // Restrict access if draft, except for admin
    if (eventData.status === 'draft' && userRole !== 'Admin' && userRole !== 'Institute Admin') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Event is not published.'
      });
    }

    // Prepare response, format dates
    const event = {
      id: eventDoc.id,
      ...eventData,
      isRegistered,
      dateTimeStart: eventData.dateTimeStart?.toDate ? eventData.dateTimeStart.toDate().toISOString() : eventData.dateTimeStart,
      dateTimeEnd: eventData.dateTimeEnd?.toDate ? eventData.dateTimeEnd.toDate().toISOString() : eventData.dateTimeEnd,
      registrationDeadline: eventData.registrationDeadline?.toDate ? eventData.registrationDeadline.toDate().toISOString() : eventData.registrationDeadline,
    };

    // Hide online link if the user is not registered and it's online/hybrid, except for admins
    if (!isRegistered && userRole !== 'Admin' && userRole !== 'Institute Admin') {
      delete event.onlineLink;
    }

    res.json({
      success: true,
      event
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/events/:id/rsvp
 * RSVP / Register for an event (Deduct points if applicable, handled via transaction)
 */
router.post('/:id/rsvp', verifyToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const uid = req.user.uid;

    const db = getDb();
    const eventRef = db.collection('events').doc(id);
    const userRef = db.collection('users').doc(uid);
    const registrationId = `${id}_${uid}`;
    const registrationRef = db.collection('eventRegistrations').doc(registrationId);

    // Run transaction
    await db.runTransaction(async (transaction) => {
      // 1. Get Event Document
      const eventDoc = await transaction.get(eventRef);
      if (!eventDoc.exists) {
        throw new Error('Event not found');
      }
      const eventData = eventDoc.data();

      if (eventData.status !== 'published') {
        throw new Error('This event is not accepting registrations.');
      }

      // 2. Validate Deadline
      if (eventData.registrationDeadline) {
        const deadline = eventData.registrationDeadline.toDate();
        if (new Date() > deadline) {
          throw new Error('Registration deadline has passed.');
        }
      }
      const startDateTime = eventData.dateTimeStart.toDate();
      if (new Date() > startDateTime) {
        throw new Error('Event has already started.');
      }

      // 3. Check Capacity
      const registeredCount = eventData.registeredCount || 0;
      if (eventData.capacity && registeredCount >= eventData.capacity) {
        throw new Error('Event is at maximum capacity.');
      }

      // 4. Get User Document
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) {
        throw new Error('User account not found.');
      }
      const userData = userDoc.data();

      // 5. Check if already registered
      const regDoc = await transaction.get(registrationRef);
      if (regDoc.exists) {
        throw new Error('You have already registered for this event.');
      }

      // 6. Check points deduction
      const costInPoints = eventData.costInPoints || 0;
      const userPoints = userData.userPoints || 0;
      const totalScore = userData.totalScore || 0;

      if (costInPoints > 0) {
        if (userPoints < costInPoints) {
          throw new Error(`Insufficient points. Required: ${costInPoints}, Available: ${userPoints}`);
        }
        
        // Deduct points
        const newUserPoints = userPoints - costInPoints;
        const newTotalScore = Math.max(0, totalScore - costInPoints);

        transaction.update(userRef, {
          userPoints: newUserPoints,
          totalScore: newTotalScore,
          updatedAt: FieldValue.serverTimestamp()
        });
      }

      // 7. Write Registration Document
      transaction.set(registrationRef, {
        eventId: id,
        userId: uid,
        userName: userData.name || 'Student',
        userEmail: userData.email,
        userRole: userData.role || 'Level-2',
        pointsDeducted: costInPoints,
        registeredAt: FieldValue.serverTimestamp(),
        attendanceStatus: 'registered'
      });

      // 8. Increment Event Registration Counter
      transaction.update(eventRef, {
        registeredCount: registeredCount + 1,
        updatedAt: FieldValue.serverTimestamp()
      });
    });

    res.json({
      success: true,
      message: 'RSVP confirmed successfully!'
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to complete RSVP.'
    });
  }
});

/**
 * POST /api/events/:id/cancel-rsvp
 * Cancel RSVP (Refund points if applicable)
 */
router.post('/:id/cancel-rsvp', verifyToken, async (req, res, next) => {
  try {
    const { id } = req.params;
    const uid = req.user.uid;

    const db = getDb();
    const eventRef = db.collection('events').doc(id);
    const userRef = db.collection('users').doc(uid);
    const registrationId = `${id}_${uid}`;
    const registrationRef = db.collection('eventRegistrations').doc(registrationId);

    await db.runTransaction(async (transaction) => {
      // 1. Get Registration Document
      const regDoc = await transaction.get(registrationRef);
      if (!regDoc.exists) {
        throw new Error('Registration details not found.');
      }
      const regData = regDoc.data();

      // 2. Get Event Document
      const eventDoc = await transaction.get(eventRef);
      if (!eventDoc.exists) {
        throw new Error('Event not found.');
      }
      const eventData = eventDoc.data();

      // Validate cancellation time (cannot cancel after event starts)
      const startDateTime = eventData.dateTimeStart.toDate();
      if (new Date() > startDateTime) {
        throw new Error('Cannot cancel RSVP after the event has started.');
      }

      // 3. Refund points if points were deducted
      const refundPoints = regData.pointsDeducted || 0;
      if (refundPoints > 0) {
        const userDoc = await transaction.get(userRef);
        if (userDoc.exists) {
          const userData = userDoc.data();
          const currentUserPoints = userData.userPoints || 0;
          const currentTotalScore = userData.totalScore || 0;

          transaction.update(userRef, {
            userPoints: currentUserPoints + refundPoints,
            totalScore: currentTotalScore + refundPoints,
            updatedAt: FieldValue.serverTimestamp()
          });
        }
      }

      // 4. Delete registration doc
      transaction.delete(registrationRef);

      // 5. Decrement registered count
      const registeredCount = eventData.registeredCount || 1;
      transaction.update(eventRef, {
        registeredCount: Math.max(0, registeredCount - 1),
        updatedAt: FieldValue.serverTimestamp()
      });
    });

    res.json({
      success: true,
      message: 'RSVP cancelled successfully. Points refunded if applicable.'
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to cancel RSVP.'
    });
  }
});

module.exports = router;
