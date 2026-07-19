export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    
    const { encryptedSummonerId } = req.body;
    if (!encryptedSummonerId) return res.status(400).json({ error: 'ID is missing' });

    try {
        const response = await fetch(`https://kr.api.riotgames.com/lol/league/v4/entries/by-summoner/${encryptedSummonerId}`, {
            headers: { 'X-Riot-Token': process.env.RIOT_API_KEY }
        });
        
        if (!response.ok) throw new Error(`Riot API Error: ${response.status}`);
        
        const data = await response.json();
        // 프론트엔드가 헷갈리지 않게 무조건 'rank'라는 상자에 담아서 보냅니다.
        return res.status(200).json({ rank: data }); 
    } catch (error) {
        console.error('Rank API Error:', error);
        return res.status(500).json({ error: error.message });
    }
}