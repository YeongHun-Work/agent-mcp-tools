import os
import re
import asyncio
from datetime import datetime
from dotenv import load_dotenv

from mcp.server import Server
import mcp.types as types
from mcp.server.stdio import stdio_server

import aiofiles

# Starlette imports for raw ASGI SSE
from starlette.applications import Starlette
from starlette.routing import Route
from mcp.server.sse import SseServerTransport
import uvicorn
from starlette.requests import Request

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

    try:
        # 대상 폴더가 없으면 생성
        os.makedirs(target_dir, exist_ok=True)
        
        # 파일 직접 쓰기 (비동기)
        async with aiofiles.open(file_path, 'w', encoding='utf-8') as f:
            await f.write(final_content)
            
        return [types.TextContent(
            type="text", 
            text=f"성공적으로 메모가 로컬에 저장되었습니다! 경로: '{file_path}'"
        )]
    except Exception as e:
        return [types.TextContent(type="text", text=f"메모 로컬 저장 중 실패: {str(e)}")]

# ==========================================
# Transport Runners
# ==========================================
async def run_stdio():
    print("Starting agent-auto-memo with stdio transport...", flush=True)
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())

# SSE 통신을 위한 Starlette 설정
sse = SseServerTransport("/messages")

async def handle_sse(request: Request):
    async with sse.connect_sse(request.scope, request.receive, request._send) as streams:
        await server.run(streams[0], streams[1], server.create_initialization_options())

async def handle_messages(request: Request):
    await sse.handle_post_message(request.scope, request.receive, request._send)

app = Starlette(debug=True, routes=[
    Route("/sse", endpoint=handle_sse),
    Route("/messages", endpoint=handle_messages, methods=["POST"])
])

import sys

def main():
    # .env 의 값을 기본으로 하되, 실행 시 명령줄(Argument)로 넘어온 값이 있으면 우선 적용합니다.
    mode = MCP_TRANSPORT
    if len(sys.argv) > 1:
        if sys.argv[1] == "--stdio":
            mode = "stdio"
        elif sys.argv[1] == "--sse":
            mode = "sse"

    if mode == "sse":
        print(f"Starting agent-auto-memo with SSE transport on port {SSE_PORT}...")
        uvicorn.run(app, host="0.0.0.0", port=SSE_PORT)
    else:
        # 기본값: stdio
        asyncio.run(run_stdio())

if __name__ == "__main__":
    main()
