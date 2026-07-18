# LoL Match API Calculator - Vercel 마이그레이션 완료 요약

## 📋 프로젝트 개요

| 구분 | 기존 프로젝트 (`lol-match-calculator`) | 새로운 프로젝트 (`lol-match-api-calculator`) |
|------|----------------------------------------|-----------------------------------------------|
| **아키텍처** | 단일 `index.html` (순수 프론트엔드) | Vercel Serverless Functions + 프론트엔드 |
| **Supabase 연동** | 프론트엔드에서 직접 쓰기 (RLS 비활성화) | 프론트엔드(Anon Key) + 백엔드(Service Role Key) 분리 |
| **Riot API** | 미지원 | 실시간 소환사 검색, 랭크/티어 조회, MMR 계산 |
| **자동화** | 없음 | Vercel Cron Jobs (매시간 Riot API 키 만료 알림) |
| **배포** | 정적 호스팅 | Vercel (Functions + Cron + Static) |

---

## 🗄️ 데이터베이스 및 스키마 (Supabase)

### 접속 정보
| 항목 | 값 |
|------|-----|
| **URL** | `https://xfxsubglqbwqvchpjksc.supabase.co` |
| **ANON_KEY** | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` (기존 index.html에서 추출) |
| **SERVICE_ROLE_KEY** | **Supabase Dashboard → Settings → API** 에서 별도 확인 (Anon Key와 다름!) |

### DB 스키마 (`db.sql` 실행 필요)
```sql
CREATE TABLE players (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    mmr INTEGER NOT NULL,
    is_participating BOOLEAN DEFAULT FALSE,
    lock_team TEXT DEFAULT 'none',    -- 'none', 'A', 'B' (팀 고정 상태)
    assigned_team TEXT DEFAULT NULL   -- 'A', 'B' (최종 배정된 팀)
    -- Riot API 필드 추가 필요:
    , game_name TEXT
    , tag_line TEXT
    , puuid TEXT
    , encrypted_summoner_id TEXT
    , profile_icon_id INTEGER
    , summoner_level INTEGER
    , tier TEXT
    , rank TEXT
    , league_points INTEGER
    , wins INTEGER
    , losses INTEGER
);
```

### 필수 설정 (SQL Editor에서 실행)
```sql
-- 1. RLS 비활성화 (Anon Key로 직접 읽기/쓰기 허용)
ALTER TABLE players DISABLE ROW LEVEL SECURITY;

-- 2. Realtime 활성화
ALTER PUBLICATION supabase_realtime ADD TABLE players;

-- 3. MMR 자동 계산 트리거 (rank.js에서 호출 시 자동 계산되므로 선택 사항)
-- CREATE OR REPLACE FUNCTION update_mmr_trigger() ...
```

### 확인 사항
- [ ] Table Editor에서 `players` 테이블 생성 확인
- [ ] Replication → Publications에서 `supabase_realtime`에 `players` 테이블 포함 확인

---

## ⚙️ Vercel 환경 변수 설정 (필수 5개)

Vercel Dashboard → **Settings → Environment Variables** 에 모두 등록 (Production, Preview, Development 모두 체크)

| 변수명 | 설명 | 값 예시 | 비고 |
|--------|------|---------|------|
| `SUPABASE_URL` | Supabase 프로젝트 URL | `https://xfxsubglqbwqvchpjksc.supabase.co` | 기존 index.html에서 추출 |
| `SUPABASE_ANON_KEY` | Supabase 익명 키 (Public) | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` | 기존 index.html에서 추출 |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 서비스 롤 키 (Secret) | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` | **Dashboard → Settings → API에서 "service_role" 키 복사** (Anon Key와 다름!) |
| `RIOT_API_KEY` | 라이엇 개발자 API 키 | `RGAPI-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` | [Riot Developer Portal](https://developer.riotgames.com/)에서 발급 (24시간마다 갱신 필요) |
| `CRON_SECRET` | 크론잡 인증용 시크릿 | `your-random-secret-string-32chars` | `openssl rand -hex 32` 로 생성 |

> ⚠️ **중요**: `SUPABASE_SERVICE_ROLE_KEY`는 `SUPABASE_ANON_KEY`와 **완전히 다른 키**입니다. Supabase Dashboard에서 "service_role" 레이블이 붙은 키를 복사하세요.

---

## 📁 프로젝트 구조

```
lol-match-api-calculator/
├── index.html                 # 메인 프론트엔드 (Riot API 검색 포함, 런타임 config 로드)
├── temp_old.html              # 구버전 백업 (하드코딩된 키 포함)
├── db.sql                     # Supabase 데이터베이스 스키마
├── package.json               # Node.js 의존성 (@supabase/supabase-js, vercel)
├── vercel.json                # Vercel 배포 설정 (Functions, Cron, Headers, Rewrites)
├── .env.example               # 환경 변수 템플릿
├── MIGRATION_GUIDE.md         # 상세 마이그레이션 가이드
├── MIGRATION_SUMMARY.md       # 이 파일 (요약본)
└── api/
    ├── config.js              # 프론트엔드용 런타임 설정 엔드포인트 (Anon Key만 노출)
    ├── riot/
    │   ├── summoner.js        # 소환사 검색 (ACCOUNT-V1 + SUMMONER-V4) + DB Upsert
    │   └── rank.js            # 랭크 조회 (LEAGUE-V4) + MMR 계산 + DB Update
    └── cron/
        └── refresh-riot-key.js # Riot API 키 만료 알림 크론잡 (매시간 실행)
```

---

## 🔧 주요 파일별 역할

### `api/config.js` (신규)
프론트엔드(`index.html`)가 런타임에 Supabase 설정을 가져오는 엔드포인트
- **응답**: `{ supabaseUrl, supabaseAnonKey }` (Secret 키는 절대 노출 안 함)
- **호출**: `fetch('/api/config')` → `supabase.createClient(url, key)`

### `api/riot/summoner.js`
- **입력**: `{ gameName, tagLine }`
- **동작**: Riot ACCOUNT-V1 → SUMMONER-V4 호출 → `players` 테이블 upsert
- **출력**: 소환사 정보 + 기본 MMR (언랭크 1200)
- **키 사용**: `RIOT_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`

### `api/riot/rank.js`
- **입력**: `{ encryptedSummonerId, puuid }`
- **동작**: Riot LEAGUE-V4 호출 → 티어/랭크/LP/전적 파싱 → MMR 계산 → DB 업데이트
- **MMR 계산**: 기본 1200 + (티어별 기본값) + (LP × 2) + (승률 보정)
- **출력**: 업데이트된 랭크 정보 + 계산된 MMR
- **키 사용**: `RIOT_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`

### `api/cron/refresh-riot-key.js`
- **스케줄**: 매일 00:00 KST (`0 0 * * *` in vercel.json)
- **동작**: 마지막 확인 시점부터 20시간 경과 시 콘솔 경고 로그 출력
- **인증**: `Authorization: Bearer ${CRON_SECRET}` 헤더 필요
- **실제 키 갱신**: 수동 필요 (Riot Developer Portal → Regenerate → Vercel Env Var 업데이트 → Redeploy)

### `vercel.json`
```json
{
  "functions": {
    "api/riot/*.js": { "maxDuration": 30 },
    "api/cron/*.js": { "maxDuration": 60 },
    "api/config.js": { "maxDuration": 10 }
  },
  "headers": [CORS 설정],
  "rewrites": [
    { "source": "/api/config", "destination": "/api/config" },
    { "source": "/api/(.*)", "destination": "/api/$1" }
  ],
  "crons": [
    { "path": "/api/cron/refresh-riot-key", "schedule": "0 0 * * *" }
  ]
}
```

---

## 🌐 프론트엔드 (`index.html`) 주요 변경사항

### 제거된 것 (보안 강화)
- ❌ 하드코딩된 `supabaseUrl`, `supabaseKey`
- ❌ CDN에서 직접 `createClient` 호출 시 키 노출

### 추가된 것
- ✅ **런타임 설정 로드**: `loadConfig()` → `fetch('/api/config')` → `supabase.createClient()`
- ✅ **Riot API 검색 UI**: 게임명/태그 입력 → `/api/riot/summoner` 호출 → 결과 표시
- ✅ **티어 새로고침**: `/api/riot/rank` 호출로 실시간 랭크/MMR 갱신
- ✅ **명단 추가 흐름**: 검색 → DB 저장 확인 → "명단에 추가" 또는 "추가하고 매칭 참가"
- ✅ **실시간 동기화**: Supabase Realtime 구독 유지 (`subscribeToChanges()`)

### 데이터 플로우
```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│   Browser   │────▶│ Vercel Edge  │────▶│  api/riot/      │
│ (index.html)│     │  (Rewrites)  │     │  summoner.js    │
└─────────────┘     └──────────────┘     │  rank.js        │
       │                                    └────────┬────────┘
       │                                             │
       ▼                                             ▼
┌─────────────────┐                         ┌──────────────┐
│ Supabase        │◀────────────────────────│ Riot API     │
│ (players table) │   Service Role Key      │ (Account,    │
│ Realtime Sync   │                         │  Summoner,   │
└─────────────────┘                         │  League)     │
       │                                    └──────────────┘
       ▼
┌─────────────────┐
│ All Clients     │
│ (Realtime UI)   │
└─────────────────┘
```

**핵심 포인트**:
- 프론트엔드: **Anon Key**로 Supabase 직접 읽기/쓰기 + Realtime 구독
- 백엔드 API: **Service Role Key**로 Supabase 관리자 작업 (Upsert, Rank Update)
- Riot API: 백엔드에서만 호출 (API 키 노출 방지)

---

## 🚀 배포 단계별 체크리스트

### 1단계: Supabase 데이터베이스 설정
- [ ] Supabase SQL Editor에서 `db.sql` 전체 실행
- [ ] `players` 테이블 생성 확인 (Riot 필드 포함)
- [ ] `ALTER TABLE players DISABLE ROW LEVEL SECURITY` 실행
- [ ] `ALTER PUBLICATION supabase_realtime ADD TABLE players` 실행
- [ ] Replication → Publications에서 `supabase_realtime`에 `players` 포함 확인

### 2단계: Vercel 프로젝트 생성 및 환경 변수 등록
- [ ] Vercel Dashboard → Add New Project → GitHub 연결 (`ontalk/lol-match-api-calculator`)
- [ ] Environment Variables 탭에서 5개 변수 모두 등록 (Production, Preview, Development 체크)
- [ ] Deploy 클릭

### 3단계: Riot API 키 발급 및 등록
- [ ] [Riot Developer Portal](https://developer.riotgames.com/) 로그인
- [ ] "Register Application" → Personal/Development API Key 발급
- [ ] 발급받은 키를 Vercel `RIOT_API_KEY`에 등록
- [ ] ⚠️ **개발자 키는 24시간마다 만료** → 갱신 필요

### 4단계: 크론잡 시크릿 생성 및 등록
```bash
# 로컬에서 실행
openssl rand -hex 32
```
- [ ] 생성된 64자 문자열을 Vercel `CRON_SECRET`에 등록

### 5단계: 배포 후 검증
| 항목 | 확인 방법 |
|------|-----------|
| 프론트엔드 로드 | `https://your-project.vercel.app/` 접속 |
| Supabase 연결 | 브라우저 콘솔에서 `loadPlayers()` 에러 없는지 확인 |
| 실시간 동기화 | 여러 탭 열어서 참가자 추가/제거 시 동기화 확인 |
| Riot 소환사 검색 | 게임명/태그 입력 후 "검색 후 등록" 버튼 테스트 |
| 랭크 조회/MMR 계산 | 검색된 소환사의 티어/LP/MMR 정상 표시 확인 |
| 팀 나누기 | 10명 참가 후 "공평하게 5:5 팀 나누기" 테스트 |
| 크론잡 동작 | Vercel Dashboard → Functions → Cron Jobs에서 실행 로그 확인 |
| CORS 헤더 | Network 탭에서 `Access-Control-Allow-Origin: *` 확인 |

---

## 🔧 로컬 개발 환경 설정

```bash
# 1. 의존성 설치
npm install

# 2. 로컬 환경 변수 파일 생성
cp .env.example .env.local
# .env.local 파일에 로컬용 키값 입력 (Supabase 로컬 또는 원격, Riot 개발 키)

# 3. Vercel CLI로 로컬 개발 서버 실행
npm run dev
# 또는
npx vercel dev
```

### `.env.local` 예시
```env
SUPABASE_URL=https://xfxsubglqbwqvchpjksc.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
RIOT_API_KEY=RGAPI-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
CRON_SECRET=your-random-secret-string-32chars
```

---

## 🚨 자주 발생하는 문제 & 해결

| 문제 | 원인 | 해결 |
|------|------|------|
| "Riot API 키가 유효하지 않음" (403) | 개발자 키 24시간 만료 | Riot Portal → Regenerate → Vercel Env Var 업데이트 → Redeploy |
| "API 호출 한도 초과" (429) | Riot API Rate Limit (20 req/s, 100 req/2min) | 요청 간격 두기, Production 키 신청 |
| 실시간 동기화 안 됨 | Realtime publication 미설정 또는 RLS 정책 | `ALTER PUBLICATION supabase_realtime ADD TABLE players` 실행 |
| 프론트엔드 Supabase 연결 실패 | Anon Key 오타, URL 오타, CORS | Vercel 환경 변수 재확인, `/api/config` 응답 확인 |
| 팀 나누기 후 화면 업데이트 안 됨 | Realtime 구독 미작동 또는 assigned_team 업데이트 실패 | 콘솔에서 `supabase.channel` 에러 확인, Network 탭에서 UPDATE 쿼리 확인 |

---

## 📝 다음 단계 (향후 개선 사항)

1. **프론트엔드 Config 엔드포인트 구현 완료** ✅ (`api/config.js` 완료)
2. **TypeScript 마이그레이션** (타입 안정성)
3. **에러 바운더리 및 로딩 상태 개선**
4. **Production Riot API 키 신청** (Rate limit 해제)
5. **Discord/Slack 웹훅 연동** (크론잡 알림)
6. **관리자 대시보드** (방 관리, 키 상태 모니터링)
7. **테스트 코드 작성** (Jest + Testing Library)

---

## 📞 참고 링크

- [Vercel Serverless Functions 문서](https://vercel.com/docs/functions)
- [Supabase JavaScript Client](https://supabase.com/docs/reference/javascript)
- [Riot Games API 문서](https://developer.riotgames.com/docs/portal)
- [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs)
- [Supabase Realtime](https://supabase.com/docs/guides/realtime)

---

## ✅ 마이그레이션 완료 상태

| 구성 요소 | 상태 | 비고 |
|-----------|------|------|
| Supabase DB 스키마 | ✅ `db.sql` 준비됨 | Supabase에서 1회 실행 필요 |
| Vercel 환경 변수 | ✅ `.env.example` 준비됨 | Dashboard에서 5개 모두 등록 필요 |
| API: `/api/config` | ✅ 구현 완료 | Anon Key만 노출 |
| API: `/api/riot/summoner` | ✅ 구현 완료 | 검색 + DB Upsert |
| API: `/api/riot/rank` | ✅ 구현 완료 | 랭크 조회 + MMR 계산 + DB Update |
| API: `/api/cron/refresh-riot-key` | ✅ 구현 완료 | 매시간 실행, 만료 알림 |
| Vercel 설정 (`vercel.json`) | ✅ 완료 | Functions, Cron, Rewrites, CORS |
| 프론트엔드 (`index.html`) | ✅ 완료 | Riot 검색 UI, 런타임 Config 로드, Realtime |
| 배포 가이드 | ✅ `MIGRATION_GUIDE.md` | 상세 단계별 가이드 |
| 요약 문서 | ✅ `MIGRATION_SUMMARY.md` | 이 파일 |

---

**마지막 업데이트**: 2026-07-18  
**프로젝트**: `ontalk/lol-match-api-calculator`  
**배포 대상**: Vercel (Serverless Functions + Static)