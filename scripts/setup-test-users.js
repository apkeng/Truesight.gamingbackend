/**
 * Setup Test Users Script
 * 
 * This script creates a complete user hierarchy for testing the Challenges feature:
 * - 1 Institute Admin
 * - 3 Level-1 users (Teachers)
 * - 5 Level-2 users (Students) - can create challenges
 * 
 * Usage: node scripts/setup-test-users.js
 * 
 * Make sure your .env file is configured with Supabase credentials:
 * - SUPABASE_ANON_KEY = publishable key (sb_publishable_...)
 * - SUPABASE_SERVICE_ROLE_KEY = secret key (sb_secret_... or legacy eyJ JWT)
 */

require('dotenv').config();
const { getDb, FieldValue } = require('../src/db');
const authService = require('../src/services/authService');
const db = getDb();

// Test Institute Configuration
const TEST_INSTITUTE = {
  name: 'Test Academy',
  code: 'TAC001' // Will be generated if not unique
};

// Test Users Configuration
const TEST_USERS = [
  // Institute Admin
  {
    name: 'Institute Admin',
    email: 'admin@testacademy.com',
    password: 'Admin123!',
    role: 'Institute Admin',
    phone: '1234567890'
  },
  // Level-1 Users (Teachers)
  {
    name: 'Teacher One',
    email: 'teacher1@testacademy.com',
    password: 'Teacher123!',
    role: 'Level-1',
    educationLevel: 'Teacher',
    phone: '1234567891'
  },
  {
    name: 'Teacher Two',
    email: 'teacher2@testacademy.com',
    password: 'Teacher123!',
    role: 'Level-1',
    educationLevel: 'Teacher',
    phone: '1234567892'
  },
  {
    name: 'Teacher Three',
    email: 'teacher3@testacademy.com',
    password: 'Teacher123!',
    role: 'Level-1',
    educationLevel: 'Teacher',
    phone: '1234567893'
  },
  // Level-2 Users (Students) - Can create challenges
  {
    name: 'Student Alice',
    email: 'alice@testacademy.com',
    password: 'Student123!',
    role: 'Level-2',
    educationLevel: 'Grade 10',
    phone: '1234567901'
  },
  {
    name: 'Student Bob',
    email: 'bob@testacademy.com',
    password: 'Student123!',
    role: 'Level-2',
    educationLevel: 'Grade 10',
    phone: '1234567902'
  },
  {
    name: 'Student Charlie',
    email: 'charlie@testacademy.com',
    password: 'Student123!',
    role: 'Level-2',
    educationLevel: 'Grade 11',
    phone: '1234567903'
  },
  {
    name: 'Student Diana',
    email: 'diana@testacademy.com',
    password: 'Student123!',
    role: 'Level-2',
    educationLevel: 'Grade 11',
    phone: '1234567904'
  },
  {
    name: 'Student Eve',
    email: 'eve@testacademy.com',
    password: 'Student123!',
    role: 'Level-2',
    educationLevel: 'Grade 12',
    phone: '1234567905'
  }
];

// Generate unique institute code
async function generateInstituteCode(name) {
  let unique = false;
  let newCode = "";
  let attempts = 0;
  const maxAttempts = 10;

  while (!unique && attempts < maxAttempts) {
    const chars = name
      ? name.replace(/\s+/g, "").substring(0, 3).toUpperCase()
      : "TAC";
    const numbers = Math.floor(Math.random() * 900 + 100);
    newCode = `${chars}${numbers}`;
    
    const existingUsers = await db.collection('users')
      .where('instituteCode', '==', newCode)
      .limit(1)
      .get();
    
    unique = existingUsers.empty;
    attempts++;
  }

  if (!unique) {
    // Fallback to timestamp-based code
    newCode = `TAC${Date.now().toString().slice(-6)}`;
  }

  return newCode;
}

// Check if user already exists
async function userExists(email) {
  try {
    await authService.getUserByEmail(email);
    return true;
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      return false;
    }
    throw error;
  }
}

// Delete user if exists (for cleanup)
async function deleteUserIfExists(email) {
  try {
    const userRecord = await authService.getUserByEmail(email);
    await authService.deleteUser(userRecord.uid);
    await db.collection('users').doc(userRecord.uid).delete();
    return true;
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      return false;
    }
    throw error;
  }
}

// Create a single user
async function createUser(userData, instituteCode, instituteName) {
  try {
    // Check if user already exists
    const exists = await userExists(userData.email);
    
    if (exists) {
      console.log(`⚠️  User ${userData.email} already exists in Auth. Syncing profile...`);
      const userRecord = await authService.getUserByEmail(userData.email);
      const userRef = db.collection('users').doc(userRecord.uid);
      const existingDoc = await userRef.get();

      const profileUpdates = {
        uid: userRecord.uid,
        name: userData.name,
        email: userData.email,
        role: userData.role,
        educationLevel: userData.educationLevel || (userData.role === 'Level-1' ? 'Teacher' : null),
        instituteCode: instituteCode,
        instituteName: instituteName,
        phone: userData.phone,
        isActive: true,
        updatedAt: FieldValue.serverTimestamp(),
      };

      if (existingDoc.exists) {
        await userRef.update(profileUpdates);
      } else {
        await userRef.set({
          ...profileUpdates,
          photoURL: null,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      
      return {
        uid: userRecord.uid,
        email: userData.email,
        name: userData.name,
        role: userData.role,
        status: 'updated'
      };
    }

    // Create user in Firebase Auth
    const userRecord = await authService.createUser({
      email: userData.email,
      password: userData.password,
      displayName: userData.name,
      emailVerified: false
    });

    // Create user document in Supabase database
    const userProfile = {
      uid: userRecord.uid,
      name: userData.name,
      email: userData.email,
      phone: userData.phone || null,
      photoURL: null,
      role: userData.role,
      educationLevel: userData.educationLevel || (userData.role === 'Level-1' ? 'Teacher' : null),
      instituteCode: instituteCode,
      instituteName: instituteName,
      isActive: true,
      createdAt: FieldValue.serverTimestamp()
    };

    await db.collection('users').doc(userRecord.uid).set(userProfile);

    return {
      uid: userRecord.uid,
      email: userData.email,
      name: userData.name,
      role: userData.role,
      status: 'created'
    };
  } catch (error) {
    console.error(`❌ Error creating user ${userData.email}:`, error.message);
    throw error;
  }
}

// Main setup function
async function setupTestUsers() {
  console.log('\n🚀 Starting Test Users Setup...\n');
  console.log('=' .repeat(60));

  try {
    // Generate institute code
    console.log('\n📝 Generating Institute Code...');
    const instituteCode = await generateInstituteCode(TEST_INSTITUTE.name);
    console.log(`✓ Institute Code: ${instituteCode}\n`);

    const results = {
      institute: {
        name: TEST_INSTITUTE.name,
        code: instituteCode
      },
      users: {
        created: [],
        updated: [],
        failed: []
      }
    };

    // Create users
    console.log('👥 Creating Users...\n');
    
    for (const userData of TEST_USERS) {
      try {
        const result = await createUser(userData, instituteCode, TEST_INSTITUTE.name);
        
        if (result.status === 'created') {
          results.users.created.push(result);
          console.log(`✓ Created: ${result.name} (${result.role}) - ${result.email}`);
        } else {
          results.users.updated.push(result);
          console.log(`↻ Updated: ${result.name} (${result.role}) - ${result.email}`);
        }
      } catch (error) {
        results.users.failed.push({
          email: userData.email,
          error: error.message
        });
        console.log(`❌ Failed: ${userData.email} - ${error.message}`);
      }
    }

    // Print summary
    console.log('\n' + '='.repeat(60));
    console.log('\n📊 Setup Summary:\n');
    console.log(`Institute: ${results.institute.name} (${results.institute.code})`);
    console.log(`\nUsers Created: ${results.users.created.length}`);
    console.log(`Users Updated: ${results.users.updated.length}`);
    console.log(`Users Failed: ${results.users.failed.length}`);

    // Print credentials table
    console.log('\n' + '='.repeat(60));
    console.log('\n🔐 Test User Credentials:\n');
    console.log('┌─────────────────────────────────────────────────────────────────┐');
    console.log('│ Role              │ Email                      │ Password       │');
    console.log('├─────────────────────────────────────────────────────────────────┤');
    
    TEST_USERS.forEach(user => {
      const roleDisplay = user.role === 'Institute Admin' ? 'Institute Admin' :
                         user.role === 'Level-1' ? 'Teacher' :
                         user.role === 'Level-2' ? 'Student' : user.role;
      const email = user.email.padEnd(26);
      const password = user.password.padEnd(14);
      console.log(`│ ${roleDisplay.padEnd(17)} │ ${email} │ ${password} │`);
    });
    
    console.log('└─────────────────────────────────────────────────────────────────┘');

    // Print Level-2 users (can create challenges)
    console.log('\n🎯 Students (Level-2) - Can Create Challenges:');
    TEST_USERS
      .filter(u => u.role === 'Level-2')
      .forEach((user, index) => {
        console.log(`   ${index + 1}. ${user.name} - ${user.email}`);
      });

    console.log('\n✅ Setup Complete!\n');
    console.log('💡 Tips:');
    console.log('   - Use Student accounts (Level-2) to test Challenges feature');
    console.log('   - All users belong to the same institute');
    console.log('   - Students can challenge each other');
    console.log('   - Teachers (Level-1) cannot create challenges\n');

    return results;
  } catch (error) {
    console.error('\n❌ Setup failed:', error);
    throw error;
  }
}

// Run the script
if (require.main === module) {
  setupTestUsers()
    .then(() => {
      console.log('✨ Script completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Script failed:', error);
      process.exit(1);
    });
}

module.exports = { setupTestUsers, createUser, generateInstituteCode };

