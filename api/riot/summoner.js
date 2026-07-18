import { createClient } from '@supabase/supabase-js';

const RIOT_API_KEY = process.env.RIOT_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Riot API base URLs (KR region)
const RIOT_ACCOUNT_API = 'https://asia.api.riotgames.com/riot/account/v1';
const RIOT_SUMMONER_API = 'https://kr.api.riotgames.com/lol/summoner/v4';

// Helper: Fetch with Riot API key
async function riotFetch(url) {
  const response = await fetch(url, {
    headers: {
      'X-Riot-Token': RIOT_API_KEY,
    },
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.status?.message || `Riot API error: ${response.status}`);
  }
  
  return response.json();
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { gameName, tagLine } = req.body;
    
    if (!gameName || !tagLine) {
      return res.status(400).json({ error: 'gameName and tagLine are required' });
    }

    console.log(`Searching for ${gameName}#${tagLine}`);

    // 1. Get PUUID from Riot ID (ACCOUNT-V1)
    const accountUrl = `${RIOT_ACCOUNT_API}/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
    const account = await riotFetch(accountUrl);
    
    const { puuid, gameName: riotGameName, tagLine: riotTagLine } = account;
    console.log(`Found PUUID: ${puuid}`);

    // 2. Get Summoner info from PUUID (SUMMONER-V4)
    const summonerUrl = `${RIOT_SUMMONER_API}/summoners/by-puuid/${puuid}`;
    const summoner = await riotFetch(summonerUrl);
    
    const { 
      id: encryptedSummonerId, 
      accountId, 
      profileIconId, 
      summonerLevel 
    } = summoner;
    console.log(`Found Summoner ID: ${encryptedSummonerId}`);

    // 3. Upsert player in Supabase
    const { data: player, error: upsertError } = await supabase
      .from('players')
      .upsert({
        puuid,
        game_name: riotGameName,
        tag_line: riotTagLine,
        encrypted_summoner_id: encryptedSummonerId,
        account_id: accountId,
        profile_icon_id: profileIconId,
        summoner_level: summonerLevel,
        // Keep existing rank/mmr if already exists
      }, {
        onConflict: 'puuid',
        ignoreDuplicates: false
      })
      .select()
      .single();

    if (upsertError) {
      console.error('Supabase upsert error:', upsertError);
      throw new Error('Failed to save player');
    }

    console.log(`Player saved: ${player.id}`);

    return res.status(200).json({
      player: {
        id: player.id,
        gameName: player.game_name,
        tagLine: player.tag_line,
        puuid: player.puuid,
        encryptedSummonerId: player.encrypted_summoner_id,
        profileIconId: player.profile_icon_id,
        summonerLevel: player.summoner_level,
        tier: player.tier,
        rank: player.rank,
        leaguePoints: player.league_points,
        mmr: player.mmr,
        assignedTeam: player.assigned_team,
      },
      summoner: {
        id: encryptedSummonerId,
        accountId,
        profileIconId,
        summonerLevel,
      }
    });

  } catch (error) {
    console.error('Summoner search error:', error);
    
    if (error.message.includes('Not Found') || error.message.includes('404')) {
      return res.status(404).json({ error: '소환사를 찾을 수 없습니다. 게임명과 태그를 확인해주세요.' });
    }
    
    if (error.message.includes('403') || error.message.includes('Forbidden')) {
      return res.status(403).json({ error: 'Riot API 키가 유효하지 않거나 만료되었습니다. (24시간마다 갱신 필요)' });
    }
    
    if (error.message.includes('429') || error.message.includes('Rate limit')) {
      return res.status(429).json({ error: 'API 호출 한도 초과. 잠시 후 다시 시도해주세요.' });
    }

    return res.status(500).json({ error: error.message || '서버 오류가 발생했습니다.' });
  }
}