import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  // Verify cron secret
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Check when the Riot API key was last validated
    // This is a notification-only cron since dev keys must be manually refreshed
    const { data: settings } = await supabase
      .from('settings')
      .select('*')
      .eq('key', 'riot_api_key_last_checked')
      .single();

    const lastChecked = settings?.value ? new Date(settings.value) : null;
    const now = new Date();
    const hoursSinceCheck = lastChecked ? (now - lastChecked) / (1000 * 60 * 60) : 999;

    // If more than 20 hours since last check, send notification
    if (hoursSinceCheck > 20) {
      // Log warning (in production, send to Discord/Slack/Email webhook)
      console.warn(`⚠️ Riot API 개발 키 만료 임박 (${Math.round(hoursSinceCheck)}시간 전 확인됨)`);
      console.warn('Riot Developer Portal(https://developer.riotgames.com/)에서 "Regenerate" 클릭하여 갱신 필요');
      
      // Update last checked timestamp
      await supabase
        .from('settings')
        .upsert({
          key: 'riot_api_key_last_checked',
          value: now.toISOString(),
          updated_at: now.toISOString(),
        });
    }

    return res.status(200).json({ 
      message: 'Riot API 키 상태 확인 완료',
      hoursSinceLastCheck: Math.round(hoursSinceCheck * 10) / 10,
      needsRenewal: hoursSinceCheck > 20,
    });
  } catch (error) {
    console.error('Cron job error:', error);
    return res.status(500).json({ error: error.message });
  }
}