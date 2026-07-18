# LoL Match API Calculator - Vercel 마이그레이션 가이드

## 📋 프로젝트 개요

기존 `lol-match-calculator` (단일 index.html, Supabase 직접 연동) → 새로운 `lol-match-api-calculator` (Vercel Serverless Functions + Riot API 연동) 구조로 마이그레이션하는 문서입니다.

---

## 🏗️ 현재 프로젝트 구조

```
lol-match-api-calculator/
├── index.html          # 기존 프론트엔드 (하드코딩된 Supabase 키 포함)
├── new.html            # 새로운 프론트엔드 (하드코딩된 Supabase 키 포함, Riot API 검색 박스 없음)
├── old.html            # 백업용
├── db.sql              # Supabase 데이터베이스 스키마
├── package.json        # Node.js 의존성 (@supabase/supabase-js, vercel)
├── vercel.json         # Vercel 배포 설정 (Functions, Cron, Headers)
└── api/
    ├── riot/
    │   ├── summoner.js     # 소환사 검색 (ACCOUNT-V1 + SUMMONER-V4)
    │   └── rank.js         # 랭크 조회 + MMR 계산 (LEAGUE-V4)
    └── cron/
        └── refresh-riot-key.js  # 라이엇 키 만료 알림 크론잡 (매시간 실행)
```

---

## 🔐 필수 환경 변수 (Vercel Dashboard에 등록 필요)

Vercel 대시보드 → **Settings → Environment Variables** 에 다음 4가지를 **반드시** 등록하세요:

| 변수명 | 설명 | 예시 값 | 비고 |
|---------|------|---------|------|
| `SUPABASE_URL` | Supabase 프로젝트 URL | `https://xfxsubglqbwqvchpjksc.supabase.co` | 기존 index.html에서 추출 |
| `SUPABASE_ANON_KEY` | Supabase 익명 키 (Public) | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` | 기존 index.html에서 추출 |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 서비스 롤 키 (Secret) | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` | **Supabase Dashboard → Settings → API에서 확인** (anon key와 다름!) |
| `RIOT_API_KEY` | 라이엇 개발자 API 키 | `RGAPI-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` | **Riot Developer Portal**에서 발급 (24시간마다 갱신 필요) |
| `CRON_SECRET` | 크론잡 인증용 시크릿 | `your-random-secret-string-32chars` | 임의의 긴 문자열 생성 (`openssl rand -hex 32`) |

> ⚠️ **중요**: `SUPABASE_SERVICE_ROLE_KEY`는 `SUPABASE_ANON_KEY`와 **완전히 다른 키**입니다. Supabase Dashboard에서 "service_role" 키를 복사하세요.

---

## 📝 단계별 마이그레이션 절차

### 1단계: Supabase 데이터베이스 설정

Supabase SQL Editor에서 `db.sql` 실행:

```sql
-- db.sql 전체 복사 후 실행
-- 주요 체크사항:
-- ✅ players 테이블 생성 (UUID PK, Riot 필드 포함)
-- ✅ RLS 활성화 + Public 정책 (anon key로 읽기/쓰기 가능)
-- ✅ Realtime publication 추가 (실시간 동기화)
-- ✅ MMR 자동 계산 트리거 함수
-- ✅ 뷰 생성 (player_summary)
```

**확인 사항**:
- Table Editor에서 `players` 테이블 생성 확인
- Replication → Publications에서 `supabase_realtime`에 `players` 테이블 포함 확인

---

### 2단계: Vercel 프로젝트 생성 및 환경 변수 등록

1. **Vercel Dashboard** → **Add New Project** → GitHub 저장소 연결 (`ontalk/lol-match-api-calculator`)
2. **Environment Variables** 탭에서 위 5개 변수 등록
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `RIOT_API_KEY`, `CRON_SECRET`
   - **Environment**: Production, Preview, Development 모두 체크
3. **Deploy** 클릭

---

### 3단계: 프론트엔드 환경 변수 처리 (중요!)

**문제**: 정적 HTML(`index.html`, `new.html`)은 빌드 타임에 환경 변수를 주입할 수 없습니다.

**해결 방안 3가지 중 선택**:

#### 옵션 A: 런타임 Config 엔드포인트 생성 (추천)
`api/config.js` 생성 → 프론트엔드에서 fetch로 설정값 로드

```javascript
// api/config.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  
  return res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
}
```

`vercel.json`에 rewrite 추가:
```json
"rewrites": [
  { "source": "/api/config", "destination": "/api/config" },
  { "source": "/api/(.*)", "destination": "/api/$1" }
]
```

프론트엔드 수정 (`index.html`, `new.html`):
```javascript
// 기존 하드코딩 제거
// const supabaseUrl = 'https://...';
// const supabaseKey = 'eyJ...';

// 런타임에 설정 로드
let supabaseUrl, supabaseKey;
async function loadConfig() {
  const resp = await fetch('/api/config');
  const config = await resp.json();
  supabaseUrl = config.supabaseUrl;
  supabaseKey = config.supabaseAnonKey;
  initSupabase();
}
function initSupabase() {
  const supabase = createClient(supabaseUrl, supabaseKey);
  // ... 기존 로직
}
loadConfig();
```

#### 옵션 B: 빌드 스크립트로 주입 (간단하지만 빌드 필요)
`package.json`에 빌드 스크립트 추가:
```json
"scripts": {
  "build": "node build.js",
  "dev": "vercel dev"
}
```
`build.js`에서 `index.html`의 플레이스홀더를 환경 변수로 치환.

#### 옵션 C: Vercel Edge Config 사용 (Enterprise)
Vercel Edge Config에 키 저장 후 프론트엔드에서 조회.

---

### 4단계: Riot API 키 발급 및 갱신 자동화

1. **Riot Developer Portal** (https://developer.riotgames.com/) 로그인
2. "Register Application" → Personal/Development API Key 발급
3. 발급받은 키를 Vercel `RIOT_API_KEY`에 등록
4. **⚠️ 개발자 키는 24시간마다 만료** → 갱신 필요

**자동 갱신 옵션**:
- `api/cron/refresh-riot-key.js`는 **만료 알림만** 수행 (로그 출력)
- 실제 키 갱신은 수동으로 Developer Portal에서 "Regenerate" 클릭 후 Vercel 환경 변수 업데이트
- 프로덕션용 Production API Key 신청 권장 (별도 심사 필요)

---

### 5단계: 프론트엔드 파일 정리 및 배포

**현재 상태**:
- `index.html`: Riot API 검색 박스 포함, 하드코딩된 키
- `new.html`: Riot API 검색 박스 없음, 하드코딩된 키

**권장 사항**: `index.html`을 메인으로 사용하고 Riot API 검색 기능 유지

**수정 필요 사항** (`index.html`):
1. 하드코딩된 Supabase URL/Key 제거 → 옵션 A/B/C 적용
2. `const API_BASE = '/api/riot';` 유지 (Vercel Functions 프록시)

---

### 6단계: 로컬 개발 환경 설정

```bash
# 1. 의존성 설치
npm install

# 2. .env.local 파일 생성 (로컬용)
cp .env.example .env.local
# .env.local에 로컬 Supabase 키, Riot 키 입력

# 3. Vercel CLI로 로컬 개발 서버 실행
npm run dev
# 또는
npx vercel dev
```

`.env.example` 생성:
```env
SUPABASE_URL=https://xfxsubglqbwqvchpjksc.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
RIOT_API_KEY=RGAPI-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
CRON_SECRET=your-random-secret-string
```

---

## 🔄 데이터 플로우 정리

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
- 백엔드 API: **Service Role Key**로 Supabase 관리자 권한 작업 (Upsert, Rank Update)
- Riot API: 백엔드에서만 호출 (API 키 노출 방지)

---

## ✅ 배포 후 체크리스트

| 항목 | 확인 방법 |
|------|-----------|
| 프론트엔드 로드 | `https://your-project.vercel.app/` 접속 |
| Supabase 연결 | 브라우저 콘솔에서 `loadPlayers()` 에러 없는지 확인 |
| 실시간 동기화 | 여러 탭 열어서 참가자 추가/제거 시 동기화 확인 |
| Riot 소환사 검색 | 게임명/태그 입력 후 "검색 후 추가" 버튼 테스트 |
| 랭크 조회/MMR 계산 | 검색된 소환사의 티어/LP/MMR 정상 표시 확인 |
| 팀 나누기 | 10명 참가 후 "공평하게 5:5 팀 나누기" 테스트 |
| 크론잡 동작 | Vercel Dashboard → Functions → Cron Jobs에서 실행 로그 확인 |
| CORS 헤더 | Network 탭에서 `Access-Control-Allow-Origin: *` 확인 |

---

## 🚨 자주 발생하는 문제 & 해결

### 1. "Riot API 키가 유효하지 않거나 만료되었습니다" (403)
- **원인**: 개발자 키 24시간 만료
- **해결**: Riot Developer Portal → Regenerate → Vercel `RIOT_API_KEY` 업데이트 → Redeploy

### 2. "API 호출 한도 초과" (429)
- **원인**: Riot API Rate Limit (개발자 키: 20 req/sec, 100 req/2min)
- **해결**: 사용자 요청 간격 두기, Production 키 신청

### 3. Supabase 실시간 동기화 안 됨
- **원인**: Realtime publication 미설정 또는 RLS 정책 문제
- **해결**: 
  ```sql
  -- SQL Editor에서 실행
  ALTER PUBLICATION supabase_realtime ADD TABLE players;
  -- RLS 정책 확인
  ```

### 4. 프론트엔드에서 Supabase 연결 실패
- **원인**: Anon Key 오타, URL 오타, CORS 문제
- **해결**: Vercel 환경 변수 재확인, Config 엔드포인트 응답 확인

### 5. 팀 나누기 후 화면 업데이트 안 됨
- **원인**: Realtime 구독 미작동 또는 assigned_team 업데이트 실패
- **해결**: 콘솔에서 `supabase.channel` 에러 확인, Network 탭에서 UPDATE 쿼리 확인

---

## 📁 파일별 역할 요약

| 파일 | 역할 | 수정 필요 여부 |
|------|------|----------------|
| `index.html` | 메인 프론트엔드 (Riot 검색 포함) | **예** (환경 변수 주입) |
| `new.html` | 구버전 프론트엔드 (검색 없음) | 참고용 / 삭제 권장 |
| `api/riot/summoner.js` | 소환사 검색 + DB 저장 | 완료 (환경 변수 사용) |
| `api/riot/rank.js` | 랭크 조회 + MMR 계산 + DB 업데이트 | 완료 (환경 변수 사용) |
| `api/cron/refresh-riot-key.js` | 키 만료 알림 크론잡 | 완료 |
| `vercel.json` | Vercel 배포 설정 | 완료 |
| `db.sql` | 데이터베이스 스키마 | Supabase에서 1회 실행 |
| `package.json` | 의존성 관리 | 완료 |

---

## 🎯 다음 단계 (향후 개선 사항)

1. **프론트엔드 Config 엔드포인트 구현** (`api/config.js`)
2. **TypeScript 마이그레이션** (타입 안정성)
3. **에러 바운더리 및 로딩 상태 개선**
4. **Production Riot API 키 신청** (Rate limit 해제)
5. **Discord/Slack 웹훅 연동** (크론잡 알림)
6. **관리자 대시보드** (방 관리, 키 상태 모니터링)

---

## 📞 참고 링크

- [Vercel Serverless Functions 문서](https://vercel.com/docs/functions)
- [Supabase JavaScript Client](https://supabase.com/docs/reference/javascript)
- [Riot Games API 문서](https://developer.riotgames.com/docs/portal)
- [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs)
- [Supabase Realtime](https://supabase.com/docs/guides/realtime)