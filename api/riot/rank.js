export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    
    const { encryptedSummonerId } = req.body;
    if (!encryptedSummonerId) return res.status(400).json({ error: 'encryptedSummonerId가 없습니다.' });

    try {
        const response = await fetch(`https://kr.api.riotgames.com/lol/league/v4/entries/by-summoner/${encryptedSummonerId}`, {
            headers: {
                'X-Riot-Token': process.env.RIOT_API_KEY
            }
        });
        
        if (!response.ok) {
            throw new Error(`Riot API Error: ${response.status}`);
        }
        
        const data = await response.json();
        // data는 배열 형태로 옴. 프론트엔드로 그대로 전달.
        return res.status(200).json({ rank: data });
    } catch (error) {
        console.error('Rank fetch error:', error);
        return res.status(500).json({ error: error.message });
    }
}