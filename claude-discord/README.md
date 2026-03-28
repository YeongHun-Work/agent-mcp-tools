# claude-discord

Discord 봇 + Claude API + MCP 툴 통합 시스템.
채널별 대화 컨텍스트를 SQLite로 유지하고, MCP 서버를 스킬로 등록해 Claude가 툴로 활용할 수 있도록 구성.

**실행 환경:** Odroid-XU4 (linux/arm/v7), Docker

---

## 파일 구조

```
claude-discord/
├── bot.mjs               # 메인 봇 코드
├── deploy-commands.mjs   # 슬래시 명령어 수동 등록 스크립트
├── mcp-skills.json       # 사용 가능한 MCP 스킬 목록 정의
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .env                  # 환경변수 (Git 제외)
├── .env.example          # 환경변수 템플릿
└── data/
    └── sessions.db       # SQLite DB (볼륨 마운트)
```

---

## 아키텍처

```
Discord
  │
  ▼
bot.mjs (discord.js v14)
  │
  ├── SQLite (better-sqlite3)
  │     ├── sessions        — channel_id, topic, messages (JSON), updated_at
  │     └── channel_skills  — channel_id, skill_name
  │
  ├── mcp-skills.json       — 스킬 레지스트리 (name, url, transport, description)
  │
  └── callClaude() — Anthropic SDK
        │
        ├── [1] 활성 스킬 → MCP Client 연결 (SSE / StreamableHTTP)
        ├── [2] anthropic.messages.create(tools: MCP 툴 목록)
        ├── [3] stop_reason == "tool_use" → MCP callTool() → tool_result 추가
        └── [4] stop_reason == "end_turn" → 최종 응답 반환
              (agentic loop, 최대 10회)
```

---

## 슬래시 명령어

| 명령어 | 설명 |
|--------|------|
| `/ask question:<text>` | Claude에게 질문 (컨텍스트 + 활성 스킬 포함) |
| `/topic set:<text>` | 채널 대화 주제 설정 |
| `/history` | 채널 대화 히스토리 조회 |
| `/skill list` | 스킬 목록 및 이 채널의 활성화 상태 조회 |
| `/skill on <name>` | 채널에 MCP 스킬 활성화 |
| `/skill off <name>` | 채널에서 MCP 스킬 비활성화 |

멘션(`@봇 질문`) 및 DM도 `/ask`와 동일하게 처리됨.

---

## MCP 스킬 시스템

### mcp-skills.json 구조

```json
[
  {
    "name": "agent-auto-memo",
    "url": "http://192.168.0.100:8000/sse",
    "transport": "sse",
    "description": "Obsidian 메모 자동 저장. 사용자가 메모/기록을 요청하면 save_memo 툴 사용."
  }
]
```

- `transport`: `"sse"` 또는 생략(StreamableHTTP 기본값)
- 파일은 볼륨 마운트로 관리 → **재빌드 없이 수정 후 `docker compose restart`로 반영**

### 스킬 동작 흐름

1. `/skill on agent-auto-memo` → `channel_skills` 테이블에 저장
2. 사용자 질문 시 → 활성 스킬의 MCP 서버에 연결 → 툴 목록 조회
3. Claude API 호출 시 툴 목록을 `tools` 파라미터로 전달
4. Claude가 `tool_use` 반환 시 → MCP 서버에 직접 호출 → `tool_result` 포함 재호출 (agentic loop)

---

## 환경변수 (.env)

```env
DISCORD_TOKEN=       # Discord Developer Portal > Bot > Token
CLIENT_ID=           # Discord Developer Portal > General Information > Application ID
GUILD_ID=            # (선택) 길드 ID — 설정 시 해당 서버에만 즉시 명령어 등록
ANTHROPIC_API_KEY=   # https://console.anthropic.com > API Keys
```

---

## SQLite 스키마

```sql
CREATE TABLE sessions (
  channel_id   TEXT PRIMARY KEY,
  topic        TEXT,
  messages     TEXT DEFAULT '[]',  -- JSON 배열: [{role, content}, ...]
  updated_at   INTEGER
);

CREATE TABLE channel_skills (
  channel_id   TEXT NOT NULL,
  skill_name   TEXT NOT NULL,
  PRIMARY KEY (channel_id, skill_name)
);
```

- messages 쌍이 20개 초과 시 Claude로 요약 압축 (최근 5쌍 유지)
- 기존 gemini-discord DB에서 마이그레이션 시 `context` 컬럼 자동 변환

---

## 배포 절차

```bash
# 1. 환경변수 설정
cp .env.example .env
# .env 편집 (DISCORD_TOKEN, CLIENT_ID, GUILD_ID, ANTHROPIC_API_KEY)

# 2. 빌드 및 실행
docker compose up -d --build

# 3. 슬래시 명령어 등록 (최초 1회)
docker exec claude-discord node deploy-commands.mjs

# 4. 로그 확인
docker compose logs -f
```

### 코드 업데이트 후

```bash
docker compose up -d --build
```

### MCP 스킬 추가/수정 후 (재빌드 불필요)

```bash
# mcp-skills.json 편집 후
docker compose restart
```

---

## 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| `AuthenticationError: invalid x-api-key` | ANTHROPIC_API_KEY 미설정 또는 잘못된 키 | `.env`의 ANTHROPIC_API_KEY 확인 |
| `MCP 연결 실패: agent-auto-memo` | MCP 서버 미동작 또는 URL 변경 | `mcp-skills.json`의 url 확인, MCP 서버 상태 확인 |
| tool_use 최대 반복 초과 | MCP 서버 응답 이상 | MCP 서버 로그 확인 |
| `SQLITE_CANTOPEN` | `data/` 디렉토리 권한 문제 | `mkdir -p data` 확인 |
| 슬래시 명령어 미반영 | CLIENT_ID 미설정 또는 등록 미실행 | `docker exec claude-discord node deploy-commands.mjs` |

---

## 연관 프로젝트

| 프로젝트 | 위치 | 역할 |
|----------|------|------|
| agent-auto-memo | `../agent-auto-memo` | Obsidian 메모 저장 MCP 서버 (SSE, port 8000) |
| gemini-discord | `../gemini-discord` | 동일 기능의 Gemini CLI 버전 |
