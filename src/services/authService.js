const { getSupabase } = require('../config/supabase');

const findUserByEmail = async (email) => {
  const supabase = getSupabase();
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;

  const user = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (!user) {
    const err = new Error('User not found');
    err.code = 'auth/user-not-found';
    throw err;
  }
  return user;
};

const getUserByEmail = async (email) => {
  const user = await findUserByEmail(email);
  return {
    uid: user.id,
    email: user.email,
    displayName: user.user_metadata?.display_name || user.user_metadata?.name || null,
    photoURL: user.user_metadata?.avatar_url || null,
  };
};

const getUser = async (uid) => {
  const supabase = getSupabase();
  const { data, error } = await supabase.auth.admin.getUserById(uid);
  if (error) throw error;

  return {
    uid: data.user.id,
    email: data.user.email,
    displayName: data.user.user_metadata?.display_name || null,
    photoURL: data.user.user_metadata?.avatar_url || null,
  };
};

const createUser = async ({ email, password, displayName }) => {
  const supabase = getSupabase();
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: displayName, name: displayName },
  });

  if (error) {
    if (error.message?.includes('already')) {
      const err = new Error(error.message);
      err.code = 'auth/email-already-exists';
      throw err;
    }
    throw error;
  }

  return { uid: data.user.id, email: data.user.email };
};

const updateUser = async (uid, { password, displayName }) => {
  const supabase = getSupabase();
  const updates = {};
  if (password) updates.password = password;
  if (displayName) updates.user_metadata = { display_name: displayName };

  const { error } = await supabase.auth.admin.updateUserById(uid, updates);
  if (error) throw error;
};

const deleteUser = async (uid) => {
  const supabase = getSupabase();
  const { error } = await supabase.auth.admin.deleteUser(uid);
  if (error) throw error;
};

const generatePasswordResetLink = async (email, actionCodeSettings = {}) => {
  const supabase = getSupabase();
  const { data, error } = await supabase.auth.admin.generateLink({
    type: 'recovery',
    email,
    options: {
      redirectTo: actionCodeSettings.url || process.env.FRONTEND_URL || 'http://localhost:3000/resetpassword',
    },
  });
  if (error) throw error;
  return data.properties.action_link;
};

module.exports = {
  getUserByEmail,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  generatePasswordResetLink,
};
