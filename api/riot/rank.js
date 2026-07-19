export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    
    // 프론트엔드에서 보낸 puuid를 받습니다.
    const { puuid } = req.body;
    if (!puuid) return res.status(400).json({ error: 'puuid가 없습니다.' });

    try {
        const apiKey = process.env.RIOT_API_KEY;

        // 🔥 라이엇 최신 규격 반영: 구형(by-summoner) 대신 신형(by-puuid) 주소로 직접 다이렉트 호출!
        const rankResp = await fetch(`https://kr.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`, {
            headers: { 'X-Riot-Token': apiKey }
        });
        
        if (!rankResp.ok) throw new Error(`Rank API Error: ${rankResp.status}`);
        
        const rankData = await rankResp.json();
        
        // 프론트엔드로 랭크 데이터 쏴주기
        return res.status(200).json({ rank: rankData }); 
    } catch (error) {
        console.error('Rank API Error:', error);
        return res.status(500).json({ error: error.message });
    }
}