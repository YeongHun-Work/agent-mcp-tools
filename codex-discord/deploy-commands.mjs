/**
 * deploy-commands.mjs
 * Discord 슬래시 명령어 등록 스크립트
 *
 * 사용법:
 *   node deploy-commands.mjs
 *
 * 환경변수:
 *   DISCORD_TOKEN  - Discord 봇 토큰
 *   CLIENT_ID      - 애플리케이션(봇) ID
 *   GUILD_ID       - (옵션) 길드 ID. 설정 시 해당 길드에만 즉시 등록,
 *                    미설정 시 전역(Global) 등록 (반영까지 최대 1시간 소요)
 */

import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

// ─── 명령어 정의 ────────────────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Codex에게 질문합니다.')
    .addStringOption((opt) =>
      opt.setName('question').setDescription('질문 내용을 입력하세요.').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('topic')
    .setDescription('현재 대화 주제(컨텍스트)를 설정합니다.')
    .addStringOption((opt) =>
      opt.setName('set').setDescription('설정할 주제 또는 배경 정보를 입력하세요.').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('history')
    .setDescription('현재 채널의 대화 기록을 관리합니다.')
    .addSubcommand((sub) =>
      sub.setName('show').setDescription('현재 채널의 대화 기록을 조회합니다.')
    )
    .addSubcommand((sub) =>
      sub.setName('clear').setDescription('현재 채널의 대화 기록을 초기화합니다.')
    ),
  new SlashCommandBuilder()
    .setName('skill')
    .setDescription('채널에서 사용할 MCP 스킬을 관리합니다.')
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('사용 가능한 스킬 목록과 활성화 상태를 조회합니다.')
    )
    .addSubcommand((sub) =>
      sub
        .setName('on')
        .setDescription('스킬을 활성화합니다.')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('스킬 이름').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('off')
        .setDescription('스킬을 비활성화합니다.')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('스킬 이름').setRequired(true)
        )
    ),
].map((cmd) => cmd.toJSON());

// ─── 환경변수 검증 ───────────────────────────────────────────────────────────

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN) {
  console.error('[오류] 환경변수 DISCORD_TOKEN 이 설정되지 않았습니다.');
  process.exit(1);
}
if (!CLIENT_ID) {
  console.error('[오류] 환경변수 CLIENT_ID 가 설정되지 않았습니다.');
  process.exit(1);
}

// ─── REST 클라이언트 초기화 ──────────────────────────────────────────────────

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

// ─── 명령어 등록 ─────────────────────────────────────────────────────────────

(async () => {
  try {
    console.log(`슬래시 명령어 ${commands.length}개를 등록하는 중...`);

    let route;
    let scope;

    if (GUILD_ID) {
      // 길드(서버) 등록: 즉시 반영
      route = Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID);
      scope = `길드(${GUILD_ID})`;
    } else {
      // 전역 등록: 모든 서버에 적용되지만 최대 1시간 소요
      route = Routes.applicationCommands(CLIENT_ID);
      scope = '전역(Global)';
    }

    const data = await rest.put(route, { body: commands });

    console.log(`[완료] ${scope} 슬래시 명령어 ${data.length}개 등록 성공.`);
  } catch (error) {
    console.error('[오류] 명령어 등록 실패:', error);
    process.exit(1);
  }
})();
