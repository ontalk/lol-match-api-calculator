-- Supabase Database Schema for LoL 5v5 Custom Game Team Balancer
-- Run this in Supabase SQL Editor

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Players table: stores summoner info + MMR + team assignment
CREATE TABLE IF NOT EXISTS players (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- Riot identifiers
    puuid TEXT UNIQUE NOT NULL,                    -- PUUID (global unique ID)
    game_name TEXT NOT NULL,                       -- Game name (e.g., "Hide on bush")
    tag_line TEXT NOT NULL,                        -- Tag line (e.g., "KR1")
    encrypted_summoner_id TEXT UNIQUE,             -- Encrypted Summoner ID (for League-V4)
    account_id TEXT,                               -- Account ID (legacy)

    -- Rank info (from LEAGUE-V4)
    tier TEXT,                                     -- IRON, BRONZE, SILVER, GOLD, PLATINUM, EMERALD, DIAMOND, MASTER, GRANDMASTER, CHALLENGER
    rank TEXT,                                     -- I, II, III, IV (empty for Master+)
    league_points INTEGER DEFAULT 0,               -- LP
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,

    -- Computed MMR (estimated from tier/rank/LP)
    mmr INTEGER DEFAULT 1200,                      -- Base 1200, adjusted by tier

    -- Game assignment
    assigned_team TEXT CHECK (assigned_team IN ('A', 'B', NULL)),  -- Team A, Team B, or unassigned
    is_host BOOLEAN DEFAULT FALSE,                 -- Room host (can trigger matching)

    -- Metadata
    profile_icon_id INTEGER,
    summoner_level INTEGER,
    last_rank_update TIMESTAMPTZ,

    UNIQUE (game_name, tag_line)
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_players_puuid ON players(puuid);
CREATE INDEX IF NOT EXISTS idx_players_assigned_team ON players(assigned_team);
CREATE INDEX IF NOT EXISTS idx_players_is_host ON players(is_host);

-- 2. Matches table: stores each 5v5 match session
CREATE TABLE IF NOT EXISTS matches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    finished_at TIMESTAMPTZ,

    host_id UUID REFERENCES players(id),           -- Who created the match
    status TEXT DEFAULT 'waiting' CHECK (status IN ('waiting', 'matching', 'in_progress', 'finished', 'cancelled')),

    -- Team balance result
    team_a_total_mmr INTEGER,
    team_b_total_mmr INTEGER,
    mmr_difference INTEGER,

    -- Optional: Riot match ID if they play a real game
    riot_match_id TEXT
);

-- 3. Match participants: links players to matches with team assignment
CREATE TABLE IF NOT EXISTS match_players (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    match_id UUID REFERENCES matches(id) ON DELETE CASCADE,
    player_id UUID REFERENCES players(id) ON DELETE CASCADE,
    team TEXT CHECK (team IN ('A', 'B')),
    position INTEGER,                              -- 1-5 position in team
    mmr_at_match INTEGER,                          -- MMR snapshot at match time
    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE (match_id, player_id)
);

-- 4. Enable Row Level Security (RLS)
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_players ENABLE ROW LEVEL SECURITY;

-- 5. RLS Policies: Allow all operations for authenticated users (adjust for production)
-- Players: anyone can read, authenticated can insert/update their own
CREATE POLICY "Public read players" ON players FOR SELECT USING (true);
CREATE POLICY "Authenticated insert players" ON players FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Authenticated update own player" ON players FOR UPDATE USING (auth.uid() = id OR auth.role() = 'service_role');

-- Matches: public read, authenticated create
CREATE POLICY "Public read matches" ON matches FOR SELECT USING (true);
CREATE POLICY "Authenticated insert matches" ON matches FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Host update match" ON matches FOR UPDATE USING (host_id = auth.uid() OR auth.role() = 'service_role');

-- Match players: public read, authenticated insert
CREATE POLICY "Public read match_players" ON match_players FOR SELECT USING (true);
CREATE POLICY "Authenticated insert match_players" ON match_players FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- 6. Realtime publication (for live updates in index.html)
ALTER PUBLICATION supabase_realtime ADD TABLE players;
ALTER PUBLICATION supabase_realtime ADD TABLE matches;
ALTER PUBLICATION supabase_realtime ADD TABLE match_players;

-- 7. Helper function: Calculate MMR from tier/rank/LP
CREATE OR REPLACE FUNCTION calculate_mmr(tier TEXT, rank TEXT, league_points INTEGER)
RETURNS INTEGER LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    base_mmr INTEGER;
    tier_bonus INTEGER;
    rank_bonus INTEGER;
BEGIN
    -- Base MMR by tier
    CASE UPPER(tier) 
        WHEN 'IRON' THEN base_mmr := 800;
        WHEN 'BRONZE' THEN base_mmr := 900;
        WHEN 'SILVER' THEN base_mmr := 1000;
        WHEN 'GOLD' THEN base_mmr := 1100;
        WHEN 'PLATINUM' THEN base_mmr := 1200;
        WHEN 'EMERALD' THEN base_mmr := 1300;
        WHEN 'DIAMOND' THEN base_mmr := 1400;
        WHEN 'MASTER' THEN base_mmr := 1600;
        WHEN 'GRANDMASTER' THEN base_mmr := 1800;
        WHEN 'CHALLENGER' THEN base_mmr := 2000;
        ELSE base_mmr := 1200; -- Unranked default
    END CASE;

    -- Rank bonus (IV=0, III=25, II=50, I=75)
    CASE rank
        WHEN 'IV' THEN rank_bonus := 0;
        WHEN 'III' THEN rank_bonus := 25;
        WHEN 'II' THEN rank_bonus := 50;
        WHEN 'I' THEN rank_bonus := 75;
        ELSE rank_bonus := 0; -- Master+ has no rank
    END CASE;

    -- LP bonus (0-100 LP -> 0-50 MMR)
    tier_bonus := LEAST(league_points / 2, 50);

    RETURN base_mmr + rank_bonus + tier_bonus;
END;
$$;

-- 8. Trigger: Auto-update MMR when rank changes
CREATE OR REPLACE FUNCTION update_player_mmr()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.mmr := calculate_mmr(NEW.tier, NEW.rank, NEW.league_points);
    NEW.last_rank_update := NOW();
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_update_player_mmr
BEFORE INSERT OR UPDATE ON players
FOR EACH ROW EXECUTE FUNCTION update_player_mmr();

-- 9. Helper: Auto-assign host if first player
CREATE OR REPLACE FUNCTION set_first_player_as_host()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF (SELECT COUNT(*) FROM players) = 1 THEN
        NEW.is_host := TRUE;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_set_first_host
BEFORE INSERT ON players
FOR EACH ROW EXECUTE FUNCTION set_first_player_as_host();

-- 10. View: Player summary with computed fields
CREATE OR REPLACE VIEW player_summary AS
SELECT 
    id,
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
    assigned_team,
    is_host,
    created_at
FROM players
ORDER BY mmr DESC;