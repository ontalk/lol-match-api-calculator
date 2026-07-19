import { createClient } from '@supabase/supabase-js';

const RIOT_API_KEY = process.env.RIOT_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const RIOT_LEAGUE_API = 'https://kr.api.riotgames.com/lol/league/v4';

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

// Calculate MMR from tier/rank/LP (matches frontend calculateMMRFromTier logic)
// Iron ~ Diamond: tier base + division bonus (IV=0, III=2.5, II=5, I=7.5) - NO LP bonus
// Master/Grandmaster/Challenger: base 70 + LP/50 * 2.5
function calculateMMR(tier, rank, leaguePoints) {
  const tierUpper = (tier || 'UNRANKED').toUpperCase();
  const rankUpper = (rank || 'IV').toUpperCase();
  const lp = parseInt(leaguePoints) || 0;
  
  // 1. 에메랄드 티어 반영 (마스터는 70점부터 시작해야 점수 역전이 없음)
  const tierBaseScores = {
    'IRON': 0,
    'BRONZE': 10,
    'SILVER': 20,
    'GOLD': 30,
    'PLATINUM': 40,
    'EMERALD': 50,
    'DIAMOND': 60,
    'MASTER': 70,       
    'GRANDMASTER': 70,  // 마스터 이상은 모두 70점을 베이스로 LP로만 계산
    'CHALLENGER': 70,
    'UNRANKED': 0
  };
  
  // 2. 디비전 보너스 (아이언~다이아 전용)
  const divisionBonus = {
    'IV': 0,
    'III': 2.5,
    'II': 5,
    'I': 7.5,
    '': 0
  };
  
  const baseScore = tierBaseScores[tierUpper] || 0;
  
  // 3. 마스터, 그마, 챌린저 (오직 누적 LP로만 계산)
  if (['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(tierUpper)) {
    // 예: 그마 350LP -> (350 / 50) * 2.5 = 17.5점 추가
    const lpBonus = (lp / 50) * 2.5;
    return Math.round((baseScore + lpBonus) * 10) / 10;
  }
  
  // 4. 아이언 ~ 다이아 (LP 계산 없이 4~1티어 점수만 깔끔하게 합산)
  const divBonus = divisionBonus[rankUpper] || 0;
  return baseScore + divBonus; 
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
    const { encryptedSummonerId, puuid } = req.body;
    
    if (!encryptedSummonerId && !puuid) {
      return res.status(400).json({ error: 'encryptedSummonerId or puuid is required' });
    }

    let targetSummonerId = encryptedSummonerId;

    // If only puuid provided, look up encryptedSummonerId from Supabase
    if (!targetSummonerId && puuid) {
      const { data: player } = await supabase
        .from('players')
        .select('encrypted_summoner_id')
        .eq('puuid', puuid)
        .single();
      
      if (player?.encrypted_summoner_id) {
        targetSummonerId = player.encrypted_summoner_id;
      }
    }

    if (!targetSummonerId) {
      return res.status(400).json({ error: 'Could not find summoner ID' });
    }

    console.log(`Fetching rank for ${targetSummonerId}`);

    // 1. Get league entries (LEAGUE-V4)
    const leagueUrl = `${RIOT_LEAGUE_API}/entries/by-summoner/${targetSummonerId}`;
    const leagues = await riotFetch(leagueUrl);

    if (!leagues || leagues.length === 0) {
      // Unranked player - update with default values (MMR = 0 for unranked)
      const mmr = calculateMMR('UNRANKED', '', 0);
      
      await supabase
        .from('players')
        .update({
          tier: 'UNRANKED',
          rank: null,
          league_points: 0,
          wins: 0,
          losses: 0,
          mmr: mmr,
          last_rank_update: new Date().toISOString(),
        })
        .eq('encrypted_summoner_id', targetSummonerId);

      return res.status(200).json({
        rank: { tier: 'UNRANKED', rank: '', leaguePoints: 0, wins: 0, losses: 0 },
        mmr: mmr,
        isUnranked: true,
      });
    }

    // 2. Prioritize RANKED_SOLO_5x5, then RANKED_FLEX_SR
    const soloQueue = leagues.find(l => l.queueType === 'RANKED_SOLO_5x5');
    const flexQueue = leagues.find(l => l.queueType === 'RANKED_FLEX_SR');
    const targetLeague = soloQueue || flexQueue || leagues[0];

    const { tier, rank, leaguePoints, wins, losses, queueType } = targetLeague;
    const mmr = calculateMMR(tier, rank, leaguePoints);

    console.log(`Rank: ${tier} ${rank} ${leaguePoints}LP (${queueType}) -> MMR: ${mmr}`);

    // 3. Update player in Supabase
    const { data: player, error: updateError } = await supabase
      .from('players')
      .update({
        tier,
        rank,
        league_points: leaguePoints,
        wins,
        losses,
        mmr,
        last_rank_update: new Date().toISOString(),
      })
      .eq('encrypted_summoner_id', targetSummonerId)
      .select()
      .single();

    if (updateError) {
      console.error('Supabase update error:', updateError);
      throw new Error('Failed to update player rank');
    }

    return res.status(200).json({
      rank: {
        tier,
        rank,
        leaguePoints,
        wins,
        losses,
        queueType,
      },
      mmr,
      player: {
        id: player.id,
        gameName: player.game_name,
        tagLine: player.tag_line,
        mmr: player.mmr,
      }
    });

  } catch (error) {
    console.error('Rank fetch error:', error);
    
    if (error.message.includes('403') || error.message.includes('Forbidden')) {
      return res.status(403).json({ error: 'Riot API 키가 유효하지 않거나 만료되었습니다. (24시간마다 갱신 필요)' });
    }
    
    if (error.message.includes('429') || error.message.includes('Rate limit')) {
      return res.status(429).json({ error: 'API 호출 한도 초과. 잠시 후 다시 시도해주세요.' });
    }

    return res.status(500).json({ error: error.message || '서버 오류가 발생했습니다.' });
  }
}