const { getSupabase } = require('../config/supabase');

const now = () => new Date().toISOString();

const DEFAULT_REWARDS = [
  { id: 17, name: "Yoga Mat", description: "Premium quality yoga mat for fitness and wellness", icon: "heart", color: "text-red-600", bgColor: "bg-red-100", pointsRequired: 10, category: "wellness", type: "physical", accessible: true, stock: null, landingPage: true },
  { id: 18, name: "Fitness Tracker", description: "Track your daily activities and health metrics", icon: "heart", color: "text-red-600", bgColor: "bg-red-100", pointsRequired: 400, category: "wellness", type: "physical", accessible: true, stock: null, landingPage: false },
  { id: 19, name: "Massage Voucher", description: "Relaxation massage voucher for stress relief", icon: "heart", color: "text-red-600", bgColor: "bg-red-100", pointsRequired: 300, category: "wellness", type: "voucher", accessible: true, stock: null, landingPage: false },
  { id: 20, name: "Collectible Action Figure", description: "Limited edition action figure from popular series", icon: "dragon", color: "text-indigo-600", bgColor: "bg-indigo-100", pointsRequired: 350, category: "fantasy", type: "physical", accessible: true, stock: null, landingPage: false },
  { id: 22, name: "Limited Edition Collectible", description: "Rare collectible item from trending franchises", icon: "dragon", color: "text-indigo-600", bgColor: "bg-indigo-100", pointsRequired: 600, category: "fantasy", type: "physical", accessible: true, stock: null, landingPage: false },
  { id: 23, name: "Harry Potter Gift Set", description: "Exclusive Harry Potter gift set with collectibles", icon: "dragon", color: "text-indigo-600", bgColor: "bg-indigo-100", pointsRequired: 500, category: "fantasy", type: "physical", accessible: true, stock: null, landingPage: false },
  { id: 24, name: "Harry Potter Wand Collectible", description: "Authentic Harry Potter wand collectible", icon: "dragon", color: "text-indigo-600", bgColor: "bg-indigo-100", pointsRequired: 400, category: "fantasy", type: "physical", accessible: true, stock: 4, landingPage: true },
  { id: 25, name: "Anime Figurines", description: "Premium anime character figurines collection", icon: "dragon", color: "text-indigo-600", bgColor: "bg-indigo-100", pointsRequired: 450, category: "fantasy", type: "physical", accessible: true, stock: null, landingPage: false },
  { id: 26, name: "Marvel Figurines", description: "Collectible Marvel superhero figurines", icon: "dragon", color: "text-indigo-600", bgColor: "bg-indigo-100", pointsRequired: 450, category: "fantasy", type: "physical", accessible: true, stock: null, landingPage: false },
  { id: 21, name: "Trendy Gadget", description: "Latest trending tech gadget everyone is talking about", icon: "chart-line", color: "text-purple-600", bgColor: "bg-purple-100", pointsRequired: 450, category: "trend", type: "physical", accessible: true, stock: null, landingPage: true },
  { id: 10, name: "Branded T-Shirt", description: "High-quality branded t-shirt in your size", icon: "tshirt", color: "text-green-600", bgColor: "bg-green-100", pointsRequired: 100, category: "apparel", type: "physical", accessible: true, stock: null, landingPage: false },
  { id: 11, name: "Designer Hoodie", description: "Comfortable designer hoodie for casual wear", icon: "tshirt", color: "text-green-600", bgColor: "bg-green-100", pointsRequired: 200, category: "apparel", type: "physical", accessible: true, stock: null, landingPage: false },
  { id: 12, name: "Formal Suit", description: "Professional formal suit for important occasions", icon: "tshirt", color: "text-green-600", bgColor: "bg-green-100", pointsRequired: 700, category: "apparel", type: "physical", accessible: true, stock: null, landingPage: false },
  { id: 13, name: "Sneakers", description: "Latest trendy sneakers for daily wear", icon: "tshirt", color: "text-green-600", bgColor: "bg-green-100", pointsRequired: 350, category: "apparel", type: "physical", accessible: true, stock: null, landingPage: true },
];

const getRewards = async () => {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('rewards')
    .select('id, data')
    .eq('data->>accessible', 'true');

  if (error) throw error;

  return (data || []).map((row) => ({
    ...row.data,
    id: row.data.id || row.id,
    docId: row.id,
  }));
};

const initializeRewards = async () => {
  const supabase = getSupabase();
  let addedCount = 0;
  let updatedCount = 0;

  for (const reward of DEFAULT_REWARDS) {
    const { data: existing } = await supabase
      .from('rewards')
      .select('id')
      .eq('data->>id', String(reward.id))
      .limit(1)
      .maybeSingle();

    const timestamp = now();
    const payload = {
      ...reward,
      updatedAt: timestamp,
      ...(existing ? {} : { createdAt: timestamp }),
    };

    if (existing) {
      const { error } = await supabase
        .from('rewards')
        .update({ data: payload, updated_at: timestamp })
        .eq('id', existing.id);
      if (error) throw error;
      updatedCount++;
    } else {
      const { error } = await supabase
        .from('rewards')
        .insert({ data: payload });
      if (error) throw error;
      addedCount++;
    }
  }

  return { added: addedCount, updated: updatedCount, total: DEFAULT_REWARDS.length };
};

const storeOTP = async (userId, email, otp, expiresAt) => {
  const supabase = getSupabase();
  const { error } = await supabase.from('password_reset_otps').upsert({
    id: userId,
    data: {
      otp,
      email,
      userId,
      expiresAt: expiresAt.toISOString(),
      createdAt: now(),
      used: false,
    },
    updated_at: now(),
  });
  if (error) throw error;
  return userId;
};

const verifyOTP = async (userId, otp) => {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('password_reset_otps')
    .select('data')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    return { valid: false, error: 'OTP not found. Please request a new OTP.' };
  }

  const otpData = data.data;
  if (otpData.used) {
    return { valid: false, error: 'This OTP has already been used. Please request a new OTP.' };
  }
  if (new Date() > new Date(otpData.expiresAt)) {
    return { valid: false, error: 'OTP has expired. Please request a new OTP.' };
  }
  if (otpData.otp !== otp) {
    return { valid: false, error: 'Invalid OTP. Please check and try again.' };
  }

  return { valid: true, data: otpData };
};

const markOTPAsUsed = async (userId) => {
  const supabase = getSupabase();
  const { data: existing } = await supabase
    .from('password_reset_otps')
    .select('data')
    .eq('id', userId)
    .maybeSingle();

  if (!existing) return;

  const { error } = await supabase.from('password_reset_otps').update({
    data: { ...existing.data, used: true, usedAt: now() },
    updated_at: now(),
  }).eq('id', userId);

  if (error) throw error;
};

module.exports = {
  getRewards,
  initializeRewards,
  storeOTP,
  verifyOTP,
  markOTPAsUsed,
};
