import os
import sys
import re
import asyncio
from datetime import datetime
from dotenv import load_dotenv
from uuid import UUID

from mcp.server import Server
import mcp.types as types
from mcp.server.stdio import stdio_server

import aiofiles

# Starlette imports for raw ASGI SSE
from starlette.applications import Starlette
from starlette.routing import Route
from mcp.server.sse import SseServerTransport
import uvicorn

# 환경변수 로드
load_dotenv()

# Configuration
OBSIDIAN_VAULT_PATH = os.getenv("OBSIDIAN_VAULT_PATH", "/data/workspace/obsidian/").rstrip("/")
OBSIDIAN_TARGET_FOLDER = os.getenv("OBSIDIAN_TARGET_FOLDER", "Memo").strip("/")
MCP_TRANSPORT = os.getenv("MCP_TRANSPORT", "stdio").lower()
SSE_PORT = int(os.getenv("SSE_PORT", "8000"))

# agent-auto-memo
server = Server("agent-auto-memo")

def sanitize_filename(title: str) -> str:
    # 특수문자 제거 및 공백을 하이픈으로 대체
    safe_title = re.sub(r'[\\/*?:"<>|]', "", title)
    safe_title = safe_title.replace(" ", "-")
    return safe_title

@server.list_tools()
async def list_tools() -> list[types.Tool]:
    return [
        types.Tool(
            name="save_memo",
            description="URL의 내용을 마크다운 형태로 Obsidian Memo 버킷에 저장합니다.",
            inputSchema={
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "원본 URL"
                    },
                    "title": {
                        "type": "string",
                        "description": "저장할 메모의 제목 (파일명과 메인 타이틀에 사용됨)"
                    },
                    "content": {
                        "type": "string",
                        "description": "포맷팅이 완료된 마크다운 내용 (Frontmatter 포함 권장)"
                    },
                    "folder": {
                        "type": "string",
                        "description": "저장할 대상 폴더명 (옵션). 제공하지 않으면 기본 폴더를 사용합니다. 예: 'Memo/IT'"
                    }
                },
                "required": ["url", "title", "content"]
            }
        )
    ]

@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[types.TextContent]:
    print(f"[call_tool] name={name}, title={arguments.get('title','')}, folder={arguments.get('folder','')}", file=sys.stderr, flush=True)
    if name != "save_memo":
        raise ValueError(f"Unknown tool: {name}")

    if not OBSIDIAN_VAULT_PATH or OBSIDIAN_VAULT_PATH == "/path/to/your/obsidian/vault":
        return [types.TextContent(type="text", text="Error: OBSIDIAN_VAULT_PATH가 .env 파일에 올바르게 설정되지 않았습니다.")]

    title = arguments["title"]
    url = arguments["url"]
    content = arguments["content"]
    folder = arguments.get("folder", "")

    # 폴더 결정 로직
    target_folder = folder.strip("/") if folder else OBSIDIAN_TARGET_FOLDER

    # 파일명 생성: YYYYMMDD-HHmmss-title.md
    now_str = datetime.now().strftime("%Y%m%d-%H%M%S")
    safe_title = sanitize_filename(title)
    filename = f"{now_str}-{safe_title}.md"
    
    # 파일 내 원본 URL 명시 (Frontmatter가 없다면 하단에 추가)
    final_content = content
    if url not in final_content:
        final_content += f"\n\n---\n**Source:** {url}"

    # 파일 시스템 저장 로직
    if target_folder:
        target_dir = os.path.join(OBSIDIAN_VAULT_PATH, target_folder)
    else:
        # 타겟 폴더가 비어있으면 볼트 루트에 직접 저장
        target_dir = OBSIDIAN_VAULT_PATH
    
    file_path = os.path.join(target_dir, filename)

    print(f"[call_tool] writing to: {file_path}", file=sys.stderr, flush=True)
    try:
        # 대상 폴더가 없으면 생성
        os.makedirs(target_dir, exist_ok=True)

        expected_size = len(final_content.encode('utf-8'))

        # 파일 쓰기 + Python 버퍼 → OS 버퍼 flush 명시
        async with aiofiles.open(file_path, 'w', encoding='utf-8') as f:
            await f.write(final_content)
            await f.flush()  # Python 내부 버퍼 → OS 버퍼 강제 flush

        # ── 검증 1: 파일 존재 여부 ──────────────────────────────
        if not os.path.exists(file_path):
            raise IOError(f"파일이 존재하지 않음 (write 후): {file_path}")

        # ── 검증 2: 파일 크기 (0바이트 or 기대치와 크게 다름) ───
        file_size = os.path.getsize(file_path)
        if file_size == 0:
            raise IOError(f"파일이 비어있음 (0 bytes): {file_path}")
        if file_size < expected_size * 0.9:  # 10% 이상 차이나면 의심
            raise IOError(
                f"파일 크기 불일치: 기대={expected_size} bytes, 실제={file_size} bytes"
            )

        # ── 검증 3: 내용 앞부분 read-back ───────────────────────
        async with aiofiles.open(file_path, 'r', encoding='utf-8') as f:
            head = await f.read(80)
        expected_head = final_content[:80]
        if head != expected_head:
            raise IOError(
                f"파일 내용 불일치 (read-back 실패):\n"
                f"  기대: {repr(expected_head)}\n"
                f"  실제: {repr(head)}"
            )

        print(f"[call_tool] verified: {file_path} ({file_size} bytes)", file=sys.stderr, flush=True)

        result_text = (
            f"✅ 메모 저장 완료\n"
            f"- 파일명: {filename}\n"
            f"- 저장 경로: {file_path}\n"
            f"- 폴더: {target_folder}\n"
            f"- 파일 크기: {file_size} bytes\n"
            f"- 저장 시각: {now_str}"
        )
        return [types.TextContent(type="text", text=result_text)]
    except Exception as e:
        print(f"[call_tool] ERROR: {e}", file=sys.stderr, flush=True)
        return [types.TextContent(type="text", text=f"❌ 메모 저장 실패: {str(e)}")]

# ==========================================
# Transport Runners
# ==========================================
async def run_stdio():
    print("Starting agent-auto-memo with stdio transport...", file=sys.stderr, flush=True)
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())

# SSE 통신을 위한 Starlette 설정
sse = SseServerTransport("/messages")

class SSEHandler:
    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return

        # connect_sse 진입 전 세션 목록 스냅샷
        sessions_before: set[UUID] = set(sse._read_stream_writers.keys())
        new_session_id: UUID | None = None

        try:
            async with sse.connect_sse(scope, receive, send) as streams:
                # connect_sse가 yield된 시점에 이미 session_id가 등록돼 있음
                # before/after 비교로 이 연결의 session_id를 캡처
                new_ids = set(sse._read_stream_writers.keys()) - sessions_before
                if new_ids:
                    new_session_id = next(iter(new_ids))
                    print(f"[SSEHandler] Session started: {new_session_id.hex}", file=sys.stderr, flush=True)

                # server.run이 왜 종료되는지 원인 로깅
                try:
                    await server.run(streams[0], streams[1], server.create_initialization_options())
                    print(f"[SSEHandler] server.run exited normally (session={new_session_id and new_session_id.hex})", file=sys.stderr, flush=True)
                except Exception as run_err:
                    print(f"[SSEHandler] server.run raised: {type(run_err).__name__}: {run_err}", file=sys.stderr, flush=True)
                    raise
        except Exception as e:
            print(f"[SSEHandler] connect_sse ended: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        finally:
            # MCP 라이브러리가 _read_stream_writers에서 session_id를 제거하지 않는 버그 보완:
            # 세션 종료 시 직접 제거 → 이후 POST 요청이 404로 깔끔하게 처리됨
            if new_session_id is not None:
                sse._read_stream_writers.pop(new_session_id, None)
                print(f"[SSEHandler] Session cleaned up: {new_session_id.hex}", file=sys.stderr, flush=True)

class MessageHandler:
    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return
        try:
            await sse.handle_post_message(scope, receive, send)
        except Exception as e:
            # SSEHandler의 finally와 handle_post_message 사이의 극히 좁은 race window 대비 fallback
            print(f"[MessageHandler] Session expired or closed: {type(e).__name__}: {e}", file=sys.stderr, flush=True)

app = Starlette(debug=True, routes=[
    Route("/sse", endpoint=SSEHandler()),
    Route("/messages", endpoint=MessageHandler(), methods=["POST"])
])


def main():
    # .env 의 값을 기본으로 하되, 실행 시 명령줄(Argument)로 넘어온 값이 있으면 우선 적용합니다.
    mode = MCP_TRANSPORT
    if len(sys.argv) > 1:
        if sys.argv[1] == "--stdio":
            mode = "stdio"
        elif sys.argv[1] == "--sse":
            mode = "sse"

    if mode == "sse":
        print(f"Starting agent-auto-memo with SSE transport on port {SSE_PORT}...", file=sys.stderr)
        uvicorn.run(app, host="0.0.0.0", port=SSE_PORT)
    else:
        # 기본값: stdio
        asyncio.run(run_stdio())

if __name__ == "__main__":
    main()
