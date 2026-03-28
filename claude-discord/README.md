# claude-discord

Discord 봇 + Claude CLI 통합 시스템.
채널별 대화 컨텍스트를 SQLite로 유지하고, MCP 스킬을 프롬프트에 주입해 Claude CLI가 활용하도록 구성.

**실행 환경:** Odroid-XU4 (linux/arm/v7), Docker

---

## 파일 구조

```
claude-discord/
├── bot.mjs               # 메인 봇 코드
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
  │     ├── sessions        — channel_id, topic, context (TEXT), updated_at
  │     └── channel_skills  — channel_id, skill_name
  │
  ├── mcp-skills.json       — 스킬 레지스트리 (name, description)
  │
  └── callClaude() — Claude CLI spawn
        │
        ├── spawn('claude', ['-p', prompt, '--dangerously-skip-permissions', '--no-session-persistence'])
        ├── stdout → 응답 텍스트 (ANSI 제거 후 반환)
        └── 타임아웃 3분 (SIGTERM)
```

---

## 슬래시 명령어

| 명령어 | 설명 |
|--------|------|
| `/ask question:<text>` | Claude에게 질문 (컨텍스트 + 활성 스킬 포함) |
| `/topic set:<text>` | 채널 대화 주제 설정 |
| `/history show` | 채널 대화 히스토리 조회 |
| `/history clear` | 채널 대화 히스토리 초기화 |
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
    "description": "Obsidian 메모 자동 저장. 사용자가 메모/기록을 요청하면 save_memo 툴 사용."
  }
]
```

- 파일은 볼륨 마운트로 관리 → **재빌드 없이 수정 후 `docker compose restart`로 반영**

### 스킬 동작 흐름

1. `/skill on agent-auto-memo` → `channel_skills` 테이블에 저장
2. 사용자 질문 시 → 활성 스킬의 description을 프롬프트 앞에 주입
3. Claude CLI가 스킬 지침을 참고해 응답 생성

---

## 환경변수 (.env)

```env
DISCORD_TOKEN=       # Discord Developer Portal > Bot > Token
CLIENT_ID=           # Discord Developer Portal > General Information > Application ID
GUILD_ID=            # (선택) 길드 ID — 설정 시 해당 서버에만 즉시 명령어 등록
```

> **API Key 불필요** — Claude CLI의 OAuth 인증 사용 (`claude auth login`)

---

## SQLite 스키마

```sql
CREATE TABLE sessions (
  channel_id   TEXT PRIMARY KEY,
  topic        TEXT,
  context      TEXT DEFAULT '',   -- 누적 대화 텍스트
  updated_at   INTEGER
);

CREATE TABLE channel_skills (
  channel_id   TEXT NOT NULL,
  skill_name   TEXT NOT NULL,
  PRIMARY KEY (channel_id, skill_name)
);
```

- context가 60줄 초과 시 Claude CLI로 요약 압축 (12줄 목표)

---

## 배포 절차

### 사전 조건 (서버 최초 1회)

```bash
# 1. Claude CLI 인증 (로컬 PC에서)
claude auth login

# 2. 인증 파일 서버로 복사
scp -r ~/.claude/ root@<서버IP>:/root/.claude/

# 3. 컨테이너 node 유저(uid 1000)가 읽고 쓸 수 있도록 권한 설정
chown -R 1000:1000 /root/.claude/
```

### 실행

```bash
# 1. 환경변수 설정
cp .env.example .env
# .env 편집 (DISCORD_TOKEN, CLIENT_ID, GUILD_ID)

# 2. 빌드 및 실행
docker compose up -d --build

# 3. 로그 확인
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
| `(응답 없음)` 반복 | Claude CLI stdout 0바이트 | `chown -R 1000:1000 /root/.claude/` 후 재시작 |
| Claude CLI hang | OAuth 토큰 만료 또는 인증 파일 누락 | 로컬에서 재인증 후 `.claude/` 재복사 |
| `SQLITE_CANTOPEN` | `data/` 디렉토리 권한 문제 | `chown 1000:1000 ./data` |
| 슬래시 명령어 미반영 | 전역 등록은 최대 1시간 소요 | GUILD_ID 설정 시 즉시 반영 |

---

## 연관 프로젝트

| 프로젝트 | 위치 | 역할 |
|----------|------|------|
| agent-auto-memo | `../agent-auto-memo` | Obsidian 메모 저장 MCP 서버 (SSE, port 8000) |
| gemini-discord | `../gemini-discord` | 동일 기능의 Gemini CLI 버전 |
| codex-discord | `../codex-discord` | 동일 기능의 Codex CLI 버전 |
