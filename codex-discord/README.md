# codex-discord

Discord 봇 + OpenAI Codex CLI + MCP 스킬 통합 시스템.
채널별 대화 컨텍스트를 SQLite로 유지하고, MCP 서버를 스킬로 등록해 Codex가 툴로 활용할 수 있도록 구성.

**실행 환경:** Odroid-XU4 (linux/arm/v7), Docker

---

## 파일 구조

```
codex-discord/
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
  │     ├── sessions        — channel_id, topic, context (평문), updated_at
  │     └── channel_skills  — channel_id, skill_name
  │
  ├── mcp-skills.json       — 스킬 레지스트리 (name, description)
  │
  └── Codex CLI (spawn, shell:false)
        └── --full-auto -p "<prompt>" 으로 비대화형 호출
```

### 프롬프트 구성 순서

```
[활성 MCP 툴 지침]   ← /skill on 으로 활성화된 스킬의 description 주입
[topic]              ← /topic set 으로 설정된 주제
[이전 대화 context]  ← SQLite에 누적된 대화 히스토리
[질문]
```

---

## 슬래시 명령어

| 명령어 | 설명 |
|--------|------|
| `/ask question:<text>` | Codex에게 질문 (컨텍스트 + 활성 스킬 포함) |
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

### Codex CLI MCP 설정 (서버 ~/.codex/config.json)

Codex CLI가 실제로 MCP 툴을 호출하려면 서버의 config.json에 mcpServers 등록 필요:

```json
{
  "mcpServers": {
    "agent-auto-memo": {
      "url": "http://192.168.0.100:8000/sse"
    }
  }
}
```

### 스킬 동작 흐름

1. `/skill on agent-auto-memo` → `channel_skills` 테이블에 저장
2. 사용자 질문 시 → 활성 스킬의 `description`을 프롬프트 앞에 주입
3. Codex CLI가 `~/.codex/config.json`의 mcpServers를 통해 실제 툴 호출

---

## 환경변수 (.env)

```env
DISCORD_TOKEN=    # Discord Developer Portal > Bot > Token
CLIENT_ID=        # Discord Developer Portal > General Information > Application ID
GUILD_ID=         # (선택) 길드 ID — 설정 시 해당 서버에만 즉시 명령어 등록
OPENAI_API_KEY=   # platform.openai.com/api-keys
```

---

## SQLite 스키마

```sql
CREATE TABLE sessions (
  channel_id  TEXT PRIMARY KEY,
  topic       TEXT,
  context     TEXT DEFAULT '',  -- 평문 누적 대화 텍스트
  updated_at  INTEGER
);

CREATE TABLE channel_skills (
  channel_id  TEXT NOT NULL,
  skill_name  TEXT NOT NULL,
  PRIMARY KEY (channel_id, skill_name)
);
```

- context 60줄 초과 시 Codex CLI로 12줄 요약 압축

---

## 배포 절차

### 최초 배포

```bash
# 1. 환경변수 설정
cp .env.example .env
# .env 편집 (DISCORD_TOKEN, CLIENT_ID, GUILD_ID, OPENAI_API_KEY)

# 2. data 디렉토리 생성
mkdir -p data

# 3. 빌드 및 실행
docker compose up -d --build

# 4. 슬래시 명령어 등록 (최초 1회)
docker exec codex-discord node deploy-commands.mjs
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

### 로그 확인

```bash
docker compose logs -f
docker logs codex-discord --tail 50
```

---

## 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| `SQLITE_CANTOPEN` | `data/` 디렉토리 없거나 권한 없음 | `mkdir -p data` 확인 |
| `OPENAI_API_KEY is not set` | `.env`에 API 키 미설정 | `.env` 파일에 `OPENAI_API_KEY` 추가 |
| `Codex CLI spawn failed` | `@openai/codex` 미설치 | Docker 재빌드 (`docker compose up -d --build`) |
| `Codex CLI timeout` | 느린 네트워크 또는 복잡한 요청 | `CODEX_TIMEOUT_MS` 상수 값 증가 (기본 180초) |
| 슬래시 명령어 미반영 | CLIENT_ID 미설정 또는 등록 미실행 | `docker exec codex-discord node deploy-commands.mjs` |
| MCP 툴이 호출 안 됨 | `~/.codex/config.json`에 mcpServers 미등록 | 서버 `~/.codex/config.json`에 mcpServers 추가 |
| ANSI 코드가 응답에 포함됨 | CLI 출력 포맷 문제 | bot.mjs의 ANSI strip 정규식이 적용됨, 정상 동작 확인 |

---

## 연관 프로젝트

| 프로젝트 | 위치 | 역할 |
|----------|------|------|
| agent-auto-memo | `../agent-auto-memo` | Obsidian 메모 저장 MCP 서버 (SSE, port 8000) |
| claude-discord | `../claude-discord` | 동일 기능의 Claude API 버전 |
| gemini-discord | `../gemini-discord` | 동일 기능의 Gemini CLI 버전 |
