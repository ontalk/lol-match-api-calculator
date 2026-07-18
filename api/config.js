export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Return only public configuration (no secret keys)
  // IMPORTANT: SUPABASE_ANON_KEY (role=anon) is REQUIRED for client-side connections
  // SUPABASE_SERVICE_ROLE_KEY (role=service_role) will NOT work for browser/Realtime connections
  const anonKey = process.env.SUPABASE_ANON_KEY;
  
  if (!anonKey) {
    console.error('❌ SUPABASE_ANON_KEY is not set in Vercel Environment Variables!');
    console.error('   Please add SUPABASE_ANON_KEY (the key with "role=anon" in JWT) to Vercel dashboard.');
    console.error('   Current fallback SUPABASE_SERVICE_ROLE_KEY will NOT work for Realtime/WebSocket.');
  }
  
  return res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: anonKey || process.env.SUPABASE_SERVICE_ROLE_KEY, // fallback but will fail for Realtime
  });
}
