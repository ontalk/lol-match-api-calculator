export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    
    // 프론트엔드에서 안전한 puuid를 무조건 받아옵니다.
    const { puuid } = req.body;
    if (!puuid) return res.status(400).json({ error: 'puuid가 없습니다.' });

    try {
        const apiKey = process.env.RIOT_API_KEY;

        // 1. puuid를 이용해 라이엇 서버에서 진짜 encryptedSummonerId를 훔쳐옵니다.
        const summonerResp = await fetch(`https://kr.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}`, {
            headers: { 'X-Riot-Token': apiKey }
        });
        
        if (!summonerResp.ok) throw new Error(`Summoner API Error: ${summonerResp.status}`);
        
        const summonerData = await summonerResp.json();
        const realSummonerId = summonerData.id; // 이것이 라이엇이 발급한 진짜 ID입니다!

        // 2. 알아낸 진짜 ID로 랭크 정보를 검색합니다.
        const rankResp = await fetch(`https://kr.api.riotgames.com/lol/league/v4/entries/by-summoner/${realSummonerId}`, {
            headers: { 'X-Riot-Token': apiKey }
        });
        
        if (!rankResp.ok) throw new Error(`Rank API Error: ${rankResp.status}`);
        
        const rankData = await rankResp.json();
        
        // 프론트엔드가 헷갈리지 않게 'rank' 상자에 담아 보냅니다.
        return res.status(200).json({ rank: rankData }); 
    } catch (error) {
        console.error('Rank API Error:', error);
        return res.status(500).json({ error: error.message });
    }
}