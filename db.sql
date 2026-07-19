-- Supabase Database Schema for LoL 5v5 Custom Game Team Balancer
-- Run this in Supabase SQL Editor

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Players table: stores summoner info + MMR + team assignment
--    Handles BOTH Riot API registered (with puuid) AND manual players (name only)
CREATE TABLE IF NOT EXISTS players (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- Display name (used for BOTH manual and Riot players)
    name TEXT NOT NULL DEFAULT '',

    -- Riot identifiers (nullable for manual players)
    puuid TEXT UNIQUE,                             -- PUUID (global unique ID, null for manual)
    game_name TEXT,                                -- Game name (e.g., "Hide on bush")
    tag_line TEXT,                                 -- Tag line (e.g., "KR1")
    encrypted_summoner_id TEXT UNIQUE,             -- Encrypted Summoner ID (for League-V4)
    account_id TEXT,                               -- Account ID (legacy)

    -- Rank info (from LEAGUE-V4)
    tier TEXT,                                     -- IRON, BRONZE, SILVER, GOLD, PLATINUM, EMERALD, DIAMOND, MASTER, GRANDMASTER, CHALLENGER
    rank TEXT,                                     -- I, II, III, IV (empty for Master+)
    league_points INTEGER DEFAULT 0,               -- LP
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,

    -- Computed MMR (estimated from tier/rank/LP, or manual value)
    mmr INTEGER DEFAULT 1200,                      -- Base 1200, adjusted by tier OR manual value

    -- Game assignment (used by index.html)
    is_participating BOOLEAN DEFAULT FALSE,        -- Is player in current 10-person pool?
    assigned_team TEXT CHECK (assigned_team IN ('A', 'B', NULL)),  -- Team A, Team B, or unassigned
    lock_team TEXT DEFAULT 'none',                 -- 'none', 'A', 'B' - force player to specific team
    is_host BOOLEAN DEFAULT FALSE,                 -- Room host (can trigger matching)

    -- Metadata
    profile_icon_id INTEGER,
    summoner_level INTEGER,
    last_rank_update TIMESTAMPTZ,

    UNIQUE (game_name, tag_line)
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_players_puuid ON players(puuid) WHERE puuid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_players_assigned_team ON players(assigned_team);
CREATE INDEX IF NOT EXISTS idx_players_is_host ON players(is_host);
CREATE INDEX IF NOT EXISTS idx_players_is_participating ON players(is_participating);

-- 2. Enable Row Level Security (RLS)
ALTER TABLE players ENABLE ROW LEVEL SECURITY;

-- 3. RLS Policies: Allow anonymous access (since frontend uses anon key)
--    Frontend uses anon key, so we allow public read/write for simplicity
--    In production, consider restricting write access
CREATE POLICY "Public read players" ON players FOR SELECT USING (true);
CREATE POLICY "Public insert players" ON players FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update players" ON players FOR UPDATE USING (true);
CREATE POLICY "Public delete players" ON players FOR DELETE USING (true);

-- 4. Realtime publication (for live updates in index.html)
ALTER PUBLICATION supabase_realtime ADD TABLE players;

-- 5. Helper function: Calculate MMR from tier/rank/LP
--    Matches frontend calculateMMRFromTier logic:
--    Iron=0, Bronze=10, Silver=20, Gold=30, Platinum=40, Emerald=50, Diamond=60, Master+=70
--    Division bonus: IV=0, III=2.5, II=5, I=7.5
--    Master+: base 70 + LP/50 * 2.5
CREATE OR REPLACE FUNCTION calculate_mmr(tier TEXT, rank TEXT, league_points INTEGER)
RETURNS NUMERIC LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    base_score NUMERIC;
    div_bonus NUMERIC;
    lp_bonus NUMERIC;
    final_mmr NUMERIC;
BEGIN
    -- Tier base scores (Iron=0, Bronze=10, Silver=20, Gold=30, Platinum=40, Emerald=50, Diamond=60, Master+=70)
    CASE UPPER(COALESCE(tier, ''))
        WHEN 'IRON' THEN base_score := 0;
        WHEN 'BRONZE' THEN base_score := 10;
        WHEN 'SILVER' THEN base_score := 20;
        WHEN 'GOLD' THEN base_score := 30;
        WHEN 'PLATINUM' THEN base_score := 40;
        WHEN 'EMERALD' THEN base_score := 50;
        WHEN 'DIAMOND' THEN base_score := 60;
        WHEN 'MASTER' THEN base_score := 70;
        WHEN 'GRANDMASTER' THEN base_score := 70;
        WHEN 'CHALLENGER' THEN base_score := 70;
        ELSE base_score := 1200; -- UNRANKED default
    END CASE;

    -- Unranked returns 1200
    IF base_score = 1200 THEN
        RETURN 1200;
    END IF;

    -- Division bonus for Iron ~ Diamond (IV=0, III=2.5, II=5, I=7.5)
    CASE COALESCE(UPPER(rank), '')
        WHEN 'IV' THEN div_bonus := 0;
        WHEN 'III' THEN div_bonus := 2.5;
        WHEN 'II' THEN div_bonus := 5;
        WHEN 'I' THEN div_bonus := 7.5;
        ELSE div_bonus := 0; -- Master+ has no division
    END CASE;

    -- Master, Grandmaster, Challenger: base 70 + LP/50 * 2.5
    IF UPPER(COALESCE(tier, '')) IN ('MASTER', 'GRANDMASTER', 'CHALLENGER') THEN
        lp_bonus := (COALESCE(league_points, 0)::NUMERIC / 50) * 2.5;
        final_mmr := base_score + lp_bonus;
    ELSE
        -- Iron ~ Diamond: base + division bonus
        final_mmr := base_score + div_bonus;
    END IF;

    -- Round to 1 decimal place
    RETURN ROUND(final_mmr * 10) / 10;
END;
$$;

-- 6. Trigger: Auto-update MMR when rank changes, BUT preserve manual MMR
--    If tier is null/empty (manual player), keep existing mmr value
CREATE OR REPLACE FUNCTION update_player_mmr()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    -- Only auto-calculate MMR if tier is set (Riot API player)
    IF NEW.tier IS NOT NULL AND NEW.tier != '' AND NEW.tier != 'UNRANKED' THEN
        NEW.mmr := calculate_mmr(NEW.tier, NEW.rank, NEW.league_points);
    END IF;
    -- For manual players (no tier), mmr keeps whatever was inserted/updated
    NEW.last_rank_update := NOW();
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_update_player_mmr ON players;
CREATE TRIGGER trigger_update_player_mmr
BEFORE INSERT OR UPDATE ON players
FOR EACH ROW EXECUTE FUNCTION update_player_mmr();

-- 7. Helper: Auto-assign host if first player
CREATE OR REPLACE FUNCTION set_first_player_as_host()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF (SELECT COUNT(*) FROM players) = 0 THEN
        NEW.is_host := TRUE;
    ELSE
        NEW.is_host := FALSE;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_set_first_host ON players;
CREATE TRIGGER trigger_set_first_host
BEFORE INSERT ON players
FOR EACH ROW EXECUTE FUNCTION set_first_player_as_host();

-- 8. View: Player summary with computed fields
CREATE OR REPLACE VIEW player_summary AS
SELECT
    id,
    name,
    game_name,
    tag_line,
    tier,
    rank,
    league_points,
    mmr,
    wins,
    losses,
    CASE WHEN wins + losses > 0
         THEN ROUND(wins::numeric / (wins + losses) * 100, 1)
         ELSE 0 END AS winrate,
    is_participating,
    assigned_team,
    lock_team,
    is_host,
    created_at
FROM players
ORDER BY mmr DESC;