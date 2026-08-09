const supabase = require('../supabase');

// Free-tier daily message limit for the student AI Coach.
const FREE_DAILY_LIMIT = 9999; // unlimited during testing

async function getIsPro(email) {
  if (!email) return false;
  try {
    const { data } = await supabase
      .from('user_preferences')
      .select('data')
      .eq('user_email', email.toLowerCase().trim())
      .maybeSingle();
    return data?.data?.isPro === true;
  } catch { return false; }
}

async function getDailyUsage(email) {
  if (!email) return { count: 0 };
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const key = email.toLowerCase().trim();
  try {
    const { data } = await supabase
      .from('user_preferences')
      .select('data')
      .eq('user_email', key)
      .maybeSingle();
    const usage = data?.data?.aiUsage || {};
    if (usage.date === today) return { count: usage.count || 0 };
    return { count: 0 }; // new day, reset
  } catch { return { count: 0 }; }
}

async function incrementDailyUsage(email) {
  if (!email) return;
  const today = new Date().toISOString().slice(0, 10);
  const key = email.toLowerCase().trim();
  try {
    const { data: existing } = await supabase
      .from('user_preferences')
      .select('data')
      .eq('user_email', key)
      .maybeSingle();
    const currentData = existing?.data || {};
    const usage = currentData.aiUsage || {};
    const newCount = (usage.date === today) ? (usage.count || 0) + 1 : 1;
    await supabase.from('user_preferences').upsert({
      user_email: key,
      data: { ...currentData, aiUsage: { date: today, count: newCount } },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_email' });
  } catch (err) { console.error('[incrementDailyUsage]', err?.message); }
}

module.exports = { FREE_DAILY_LIMIT, getIsPro, getDailyUsage, incrementDailyUsage };
