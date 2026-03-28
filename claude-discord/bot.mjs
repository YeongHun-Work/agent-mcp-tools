/**
 * Discord + Claude CLI Bot
 * - 슬래시 명령어: /ask, /topic, /history, /skill
 * - 멘션/DM 메시지도 /ask와 동일하게 처리
 * - 채널별 대화 세션을 SQLite에 저장
 * - Claude CLI(claude)를 spawn으로 호출 (shell:false)
 */

import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ─────────────────────────────────────────────
// 상수 정의
// ─────────────────────────────────────────────
const CLAUDE_TIMEOUT_MS  = 180_000;  // 3분
const INPUT_MAX_CHARS    = 4_000;    // 입력 최대 길이
const CONTEXT_MAX_LINES  = 60;       // 이 줄 수 초과 시 요약 압축
const SUMMARY_LINES      = 12;       // 요약 목표 줄 수
const DISCORD_MSG_LIMIT  = 2_000;    // Discord 메시지 한 건 최대 길이

// ─────────────────────────────────────────────
// SQLite 초기화
// ─────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR  = path.join(__dirname, 'data');
const DB_PATH = path.join(DB_DIR, 'sessions.db');

// data 디렉토리가 없으면 생성
mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

// 테이블 생성 (없으면)
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    channel_id  TEXT PRIMARY KEY,
    topic       TEXT,
    context     TEXT DEFAULT '',
    updated_at  INTEGER
  );
  CREATE TABLE IF NOT EXISTS channel_skills (
    channel_id  TEXT NOT NULL,
    skill_name  TEXT NOT NULL,
    PRIMARY KEY (channel_id, skill_name)
  );
`);

/**
 * 채널 세션을 가져온다. 없으면 빈 세션 반환.
 * @param {string} channelId
 * @returns {{ channel_id: string, topic: string|null, context: string, updated_at: number|null }}
 */
function getSession(channelId) {
  const row = db
    .prepare('SELECT * FROM sessions WHERE channel_id = ?')
    .get(channelId);
  return row ?? { channel_id: channelId, topic: null, context: '', updated_at: null };
}

/**
 * 세션을 저장(upsert)한다.
 * @param {string} channelId
 * @param {{ topic?: string|null, context?: string }} fields
 */
function saveSession(channelId, fields) {
  const session = getSession(channelId);
  const topic   = 'topic'   in fields ? fields.topic   : session.topic;
  const context = 'context' in fields ? fields.context : session.context;
  db.prepare(`
    INSERT INTO sessions (channel_id, topic, context, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      topic      = excluded.topic,
      context    = excluded.context,
      updated_at = excluded.updated_at
  `).run(channelId, topic, context, Date.now());
}

// ─────────────────────────────────────────────
// MCP 스킬 관리
// ─────────────────────────────────────────────

/**
 * mcp-skills.json에서 등록된 스킬 목록을 로드한다.
 * @returns {{ name: string, description: string }[]}
 */
function loadSkills() {
  try {
    const raw = readFileSync(path.join(__dirname, 'mcp-skills.json'), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * 채널에서 활성화된 스킬 이름 목록을 반환한다.
 * @param {string} channelId
 * @returns {string[]}
 */
function getChannelSkills(channelId) {
  return db
    .prepare('SELECT skill_name FROM channel_skills WHERE channel_id = ?')
    .all(channelId)
    .map((r) => r.skill_name);
}

/**
 * 채널의 스킬을 활성화 또는 비활성화한다.
 * @param {string} channelId
 * @param {string} skillName
 * @param {boolean} enabled
 */
function setChannelSkill(channelId, skillName, enabled) {
  if (enabled) {
    db.prepare(
      'INSERT OR IGNORE INTO channel_skills (channel_id, skill_name) VALUES (?, ?)'
    ).run(channelId, skillName);
  } else {
    db.prepare(
      'DELETE FROM channel_skills WHERE channel_id = ? AND skill_name = ?'
    ).run(channelId, skillName);
  }
}

// ─────────────────────────────────────────────
// Claude CLI 호출
// ─────────────────────────────────────────────

/**
 * Claude CLI를 spawn으로 실행하고 stdout을 반환한다.
 * @param {string} prompt  - Claude에 전달할 프롬프트
 * @returns {Promise<string>} - Claude 응답 텍스트
 */
function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    // 입력 길이 제한
    const safePrompt = prompt.length > INPUT_MAX_CHARS
      ? prompt.slice(0, INPUT_MAX_CHARS)
      : prompt;

    console.log(`[Claude CLI] 호출 시작 | 프롬프트 길이: ${safePrompt.length}자`);

    const proc = spawn(
      'claude',
      ['-p', safePrompt, '--dangerously-skip-permissions'],
      {
        shell: false,  // 보안: shell injection 방지
        stdio: ['ignore', 'pipe', 'pipe'],  // stdin 닫기 (< /dev/null 동일)
        env: {
          ...process.env,
          NO_COLOR: '1',
          TERM: 'dumb',
        },
      }
    );

    console.log(`[Claude CLI] PID: ${proc.pid}`);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      const str = chunk.toString();
      stdout += str;
      console.log(`[Claude CLI][stdout chunk] ${str.slice(0, 100)}`);
    });
    proc.stderr.on('data', (chunk) => {
      const msg = chunk.toString();
      stderr += msg;
      console.log(`[Claude CLI][stderr] ${msg.trim()}`);
    });

    // 타임아웃 처리
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Claude CLI 타임아웃 (${CLAUDE_TIMEOUT_MS / 1000}초 초과)`));
    }, CLAUDE_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      console.log(`[Claude CLI] 종료 | code: ${code} | stdout: ${stdout.length}자 | stderr: ${stderr.length}자`);
      if (code === 0) {
        // ANSI 이스케이프 코드 제거
        const cleaned = stdout.replace(/\x1B\[[0-9;]*[mGKHF]/g, '').trim();
        resolve(cleaned);
      } else {
        console.error(`[Claude CLI][실패] stderr: ${stderr.trim()}`);
        reject(new Error(`Claude CLI 종료 코드 ${code}: ${stderr.trim()}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      console.error(`[Claude CLI][error] ${err.message}`);
      reject(new Error(`Claude CLI 실행 실패: ${err.message}`));
    });
  });
}

// ─────────────────────────────────────────────
// 대화 컨텍스트 관리
// ─────────────────────────────────────────────

/**
 * 컨텍스트에 새 대화 라인을 추가하고,
 * 60줄 초과 시 Claude로 12줄 요약 압축한다.
 * @param {string} channelId
 * @param {string} question
 * @param {string} answer
 * @returns {Promise<string>} - 업데이트된 context 문자열
 */
async function appendContext(channelId, question, answer) {
  const session = getSession(channelId);
  const newLines = `사용자: ${question}\nClaude: ${answer}`;
  const updated  = session.context
    ? `${session.context}\n${newLines}`
    : newLines;

  const lineCount = updated.split('\n').length;

  if (lineCount > CONTEXT_MAX_LINES) {
    // 60줄 초과 시 Claude로 요약 압축
    console.log(`[컨텍스트 압축] 채널 ${channelId} - ${lineCount}줄 → ${SUMMARY_LINES}줄로 요약`);
    try {
      const summaryPrompt = `다음 대화를 ${SUMMARY_LINES}줄로 요약해줘:\n${updated}`;
      const summarized    = await callClaude(summaryPrompt);
      saveSession(channelId, { context: summarized });
      return summarized;
    } catch (err) {
      // 요약 실패 시 기존 컨텍스트 유지
      console.error('[컨텍스트 압축 실패]', err.message);
      saveSession(channelId, { context: updated });
      return updated;
    }
  }

  saveSession(channelId, { context: updated });
  return updated;
}

/**
 * 채널 세션 컨텍스트와 topic을 이용해 Claude 프롬프트를 구성하고 호출한다.
 * @param {string} channelId
 * @param {string} question
 * @returns {Promise<string>} - Claude 응답
 */
async function askClaude(channelId, question) {
  const session      = getSession(channelId);
  const activeSkills = getChannelSkills(channelId);
  const allSkills    = loadSkills();

  let prompt = '';

  // 활성 스킬 지침 주입
  if (activeSkills.length > 0) {
    const instructions = activeSkills
      .map((name) => {
        const skill = allSkills.find((s) => s.name === name);
        return skill ? `- ${skill.name}: ${skill.description}` : null;
      })
      .filter(Boolean)
      .join('\n');
    if (instructions) {
      prompt += `[활성 MCP 툴 - 필요 시 사용]\n${instructions}\n\n`;
    }
  }

  // 프롬프트 구성: topic → 이전 대화 → 질문 순
  if (session.topic)   prompt += `주제: ${session.topic}\n\n`;
  if (session.context) prompt += `이전 대화:\n${session.context}\n\n`;
  prompt += `질문: ${question}`;

  const answer = await callClaude(prompt);
  await appendContext(channelId, question, answer);
  return answer;
}

// ─────────────────────────────────────────────
// Discord 메시지 분할 전송 유틸
// ─────────────────────────────────────────────

/**
 * 텍스트가 Discord 2000자 제한을 초과하면 분할해서 배열로 반환한다.
 * @param {string} text
 * @returns {string[]}
 */
function splitMessage(text) {
  if (text.length <= DISCORD_MSG_LIMIT) return [text];

  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    // 가능하면 줄 바꿈 기준으로 자름
    let cutAt = DISCORD_MSG_LIMIT;
    if (remaining.length > DISCORD_MSG_LIMIT) {
      const newlineIdx = remaining.lastIndexOf('\n', DISCORD_MSG_LIMIT);
      if (newlineIdx > 0) cutAt = newlineIdx + 1;
    }
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt);
  }
  return chunks;
}

/**
 * Interaction(슬래시 명령어)에 분할 메시지를 전송한다.
 * 첫 번째는 editReply, 이후는 followUp으로 전송.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {string} text
 */
async function replyInChunks(interaction, text) {
  const chunks = splitMessage(text);
  await interaction.editReply(chunks[0]);
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp(chunks[i]);
  }
}

/**
 * 일반 메시지(멘션/DM)에 분할 메시지를 전송한다.
 * @param {import('discord.js').Message} message
 * @param {string} text
 */
async function sendInChunks(message, text) {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await message.channel.send(chunk);
  }
}

// ─────────────────────────────────────────────
// Discord 클라이언트 초기화
// ─────────────────────────────────────────────

// MessageContent Intent는 옵션으로 처리 (없어도 동작)
const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.DirectMessages,
];

// MessageContent가 지원되면 추가 (봇 설정에서 활성화 시 멘션 텍스트 읽기 가능)
try {
  intents.push(GatewayIntentBits.MessageContent);
} catch {
  // 무시: 일부 환경에서 없을 수 있음
}

const client = new Client({
  intents,
  partials: [Partials.Channel, Partials.Message], // DM 처리를 위해 필요
});

// ─────────────────────────────────────────────
// 슬래시 명령어 등록 (런타임 등록)
// ─────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Claude에게 질문합니다 (채널 세션 컨텍스트 유지)')
    .addStringOption((opt) =>
      opt
        .setName('question')
        .setDescription('질문 내용')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('topic')
    .setDescription('채널 대화 주제를 설정합니다')
    .addStringOption((opt) =>
      opt
        .setName('set')
        .setDescription('새 주제 텍스트')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('history')
    .setDescription('현재 채널의 대화 히스토리를 관리합니다')
    .addSubcommand((sub) =>
      sub.setName('show').setDescription('대화 히스토리를 조회합니다')
    )
    .addSubcommand((sub) =>
      sub.setName('clear').setDescription('대화 히스토리를 초기화합니다')
    ),
  new SlashCommandBuilder()
    .setName('skill')
    .setDescription('채널에서 사용할 MCP 스킬을 관리합니다')
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('사용 가능한 스킬 목록과 활성화 상태를 조회합니다')
    )
    .addSubcommand((sub) =>
      sub
        .setName('on')
        .setDescription('스킬을 활성화합니다')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('스킬 이름').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('off')
        .setDescription('스킬을 비활성화합니다')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('스킬 이름').setRequired(true)
        )
    ),
].map((cmd) => cmd.toJSON());

/**
 * 슬래시 명령어를 Discord API에 등록한다.
 * GUILD_ID가 있으면 길드 전용(즉시 반영), 없으면 전역(최대 1시간 소요) 등록.
 */
async function registerCommands() {
  const token    = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;
  const guildId  = process.env.GUILD_ID;

  if (!token || !clientId) {
    console.warn('[슬래시 등록 건너뜀] DISCORD_TOKEN 또는 CLIENT_ID 환경변수 없음');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(token);
  try {
    if (guildId) {
      console.log(`[슬래시 등록] 길드(${guildId}) 등록 시작...`);
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
        body: commands,
      });
      console.log('[슬래시 등록] 길드 등록 완료');
    } else {
      console.log('[슬래시 등록] 전역 등록 시작...');
      await rest.put(Routes.applicationCommands(clientId), {
        body: commands,
      });
      console.log('[슬래시 등록] 전역 등록 완료 (반영까지 최대 1시간 소요)');
    }
  } catch (err) {
    console.error('[슬래시 등록 실패]', err);
  }
}

// ─────────────────────────────────────────────
// InteractionCreate 핸들러 (슬래시 명령어)
// ─────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  // 슬래시 명령어만 처리
  if (!interaction.isChatInputCommand()) return;

  const { commandName, channelId } = interaction;

  // ── /ask ───────────────────────────────────
  if (commandName === 'ask') {
    const rawQuestion = interaction.options.getString('question', true);
    // 입력 4000자 초과 시 잘라냄
    const question = rawQuestion.slice(0, INPUT_MAX_CHARS);

    // Claude 응답이 느릴 수 있으므로 defer 처리
    await interaction.deferReply();

    try {
      const answer = await askClaude(channelId, question);
      await replyInChunks(interaction, answer || '(응답 없음)');
    } catch (err) {
      console.error('[/ask 오류]', err.message);
      await interaction.editReply(`오류가 발생했습니다: ${err.message}`);
    }
    return;
  }

  // ── /topic ─────────────────────────────────
  if (commandName === 'topic') {
    const topic = interaction.options.getString('set', true).slice(0, INPUT_MAX_CHARS);

    try {
      saveSession(channelId, { topic });
      await interaction.reply(`채널 주제가 설정되었습니다: **${topic}**`);
    } catch (err) {
      console.error('[/topic 오류]', err.message);
      await interaction.reply(`주제 설정 중 오류가 발생했습니다: ${err.message}`);
    }
    return;
  }

  // ── /skill ─────────────────────────────────
  if (commandName === 'skill') {
    const sub       = interaction.options.getSubcommand();
    const allSkills = loadSkills();

    if (sub === 'list') {
      if (allSkills.length === 0) {
        await interaction.reply('등록된 스킬이 없습니다. `mcp-skills.json`을 확인하세요.');
        return;
      }
      const active = getChannelSkills(channelId);
      const lines  = allSkills.map((s) => {
        const flag = active.includes(s.name) ? '✅' : '⬜';
        return `${flag} **${s.name}** — ${s.description}`;
      });
      await interaction.reply(`**MCP 스킬 목록 (이 채널)**\n${lines.join('\n')}`);
      return;
    }

    if (sub === 'on' || sub === 'off') {
      const skillName = interaction.options.getString('name', true);
      const exists    = allSkills.some((s) => s.name === skillName);
      if (!exists) {
        await interaction.reply(`스킬 \`${skillName}\`을 찾을 수 없습니다. \`/skill list\`로 확인하세요.`);
        return;
      }
      const enabling = sub === 'on';
      setChannelSkill(channelId, skillName, enabling);
      await interaction.reply(
        enabling
          ? `✅ **${skillName}** 스킬이 이 채널에서 활성화되었습니다.`
          : `⬜ **${skillName}** 스킬이 이 채널에서 비활성화되었습니다.`
      );
      return;
    }
  }

  // ── /history ───────────────────────────────
  if (commandName === 'history') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'clear') {
      try {
        saveSession(channelId, { context: '', topic: null });
        await interaction.reply('✅ 이 채널의 대화 히스토리가 초기화되었습니다.');
      } catch (err) {
        console.error('[/history clear 오류]', err.message);
        await interaction.reply(`히스토리 초기화 중 오류가 발생했습니다: ${err.message}`);
      }
      return;
    }

    // sub === 'show'
    const session = getSession(channelId);

    if (!session.context) {
      await interaction.reply('아직 이 채널에 대화 히스토리가 없습니다.');
      return;
    }

    const topicLine = session.topic ? `**주제:** ${session.topic}\n\n` : '';
    const fullText  = `${topicLine}**대화 히스토리:**\n\`\`\`\n${session.context}\n\`\`\``;

    await interaction.deferReply();
    await replyInChunks(interaction, fullText);
    return;
  }
});

// ─────────────────────────────────────────────
// MessageCreate 핸들러 (멘션 / DM)
// ─────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  // 봇 자신의 메시지는 무시
  if (message.author.bot) return;

  const isDM      = !message.guild;
  const isMention = message.mentions.has(client.user);

  // DM이거나 봇 멘션인 경우에만 처리
  if (!isDM && !isMention) return;

  // 멘션 태그 제거 후 질문 추출
  let rawQuestion = message.content
    .replace(/<@!?\d+>/g, '')  // 멘션 태그 제거
    .trim();

  if (!rawQuestion) {
    await message.channel.send('질문 내용을 입력해주세요. (예: @봇 오늘 날씨 어때?)');
    return;
  }

  // 입력 4000자 초과 시 잘라냄
  const question  = rawQuestion.slice(0, INPUT_MAX_CHARS);
  const channelId = message.channelId;

  // typing indicator 표시 (응답 대기 중)
  try {
    await message.channel.sendTyping();
  } catch {
    // sendTyping 실패는 무시 (권한 없을 수 있음)
  }

  try {
    const answer = await askClaude(channelId, question);
    await sendInChunks(message, answer || '(응답 없음)');
  } catch (err) {
    console.error('[MessageCreate 오류]', err.message);
    await message.channel.send(`오류가 발생했습니다: ${err.message}`);
  }
});

// ─────────────────────────────────────────────
// 봇 준비 이벤트
// ─────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`[봇 준비 완료] ${client.user.tag} 로그인됨`);
  // 봇 활동 상태 설정
  client.user.setActivity('Claude CLI');
  // 봇 시작 시 슬래시 명령어 자동 등록
  await registerCommands();
});

// ─────────────────────────────────────────────
// 예상치 못한 오류 처리
// ─────────────────────────────────────────────

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

// ─────────────────────────────────────────────
// 봇 로그인
// ─────────────────────────────────────────────

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('[오류] DISCORD_TOKEN 환경변수가 설정되지 않았습니다. .env 파일을 확인하세요.');
  process.exit(1);
}

client.login(token).catch((err) => {
  console.error('[로그인 실패]', err.message);
  process.exit(1);
});
