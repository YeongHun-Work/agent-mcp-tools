/**
 * Discord + Claude API Bot
 * - 슬래시 명령어: /ask, /topic, /history, /skill
 * - 멘션/DM 메시지도 /ask와 동일하게 처리
 * - 채널별 대화 세션을 SQLite에 저장
 * - Anthropic Claude API + MCP 툴 지원 (agentic loop)
 */

import 'dotenv/config';
import {
  Client as DiscordClient,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

// ─────────────────────────────────────────────
// 상수 정의
// ─────────────────────────────────────────────
const CLAUDE_MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS        = 8192;
const MAX_TOOL_ITERS    = 10;
const MSG_PAIR_LIMIT    = 20;    // 메시지 쌍 수 초과 시 압축
const SUMMARY_PAIRS     = 5;     // 압축 후 유지할 최근 쌍 수
const INPUT_MAX_CHARS   = 4_000;
const DISCORD_MSG_LIMIT = 2_000;

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
    channel_id   TEXT PRIMARY KEY,
    topic        TEXT,
    messages     TEXT DEFAULT '[]',
    updated_at   INTEGER
  );
  CREATE TABLE IF NOT EXISTS channel_skills (
    channel_id   TEXT NOT NULL,
    skill_name   TEXT NOT NULL,
    PRIMARY KEY (channel_id, skill_name)
  );
`);

// 기존 DB 마이그레이션: context 컬럼 → messages 컬럼
const cols = db.pragma('table_info(sessions)').map((c) => c.name);
if (cols.includes('context') && !cols.includes('messages')) {
  db.exec(`ALTER TABLE sessions ADD COLUMN messages TEXT DEFAULT '[]'`);
  const rows = db.prepare('SELECT channel_id, context FROM sessions').all();
  const stmt = db.prepare('UPDATE sessions SET messages = ? WHERE channel_id = ?');
  for (const row of rows) {
    if (!row.context) continue;
    const lines = row.context.split('\n');
    const msgs = [];
    for (const line of lines) {
      if (line.startsWith('사용자: ')) msgs.push({ role: 'user', content: line.slice(4) });
      else if (line.startsWith('Gemini: ')) msgs.push({ role: 'assistant', content: line.slice(8) });
    }
    stmt.run(JSON.stringify(msgs), row.channel_id);
  }
  console.log('[마이그레이션] context → messages 변환 완료');
}

/**
 * 채널 세션을 가져온다. 없으면 빈 세션 반환.
 * @param {string} channelId
 * @returns {{ channel_id: string, topic: string|null, messages: string, updated_at: number|null }}
 */
function getSession(channelId) {
  const row = db
    .prepare('SELECT * FROM sessions WHERE channel_id = ?')
    .get(channelId);
  return row ?? { channel_id: channelId, topic: null, messages: '[]', updated_at: null };
}

/**
 * 세션을 저장(upsert)한다.
 * @param {string} channelId
 * @param {{ topic?: string|null, messages?: string }} fields
 */
function saveSession(channelId, fields) {
  const session  = getSession(channelId);
  const topic    = 'topic'    in fields ? fields.topic    : session.topic;
  const messages = 'messages' in fields ? fields.messages : session.messages;
  db.prepare(`
    INSERT INTO sessions (channel_id, topic, messages, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      topic      = excluded.topic,
      messages   = excluded.messages,
      updated_at = excluded.updated_at
  `).run(channelId, topic, messages, Date.now());
}

// ─────────────────────────────────────────────
// MCP 스킬 관리
// ─────────────────────────────────────────────

/**
 * mcp-skills.json에서 등록된 스킬 목록을 로드한다.
 * @returns {{ name: string, url: string, transport?: string, description: string }[]}
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
// Anthropic 클라이언트 초기화
// ─────────────────────────────────────────────
const anthropic = new Anthropic(); // ANTHROPIC_API_KEY 환경변수 자동 사용

// ─────────────────────────────────────────────
// MCP 연결 헬퍼
// ─────────────────────────────────────────────

/**
 * mcp-skills.json의 transport 필드('sse' 또는 기본 streamableHttp)로 MCP 클라이언트에 연결.
 * 연결 후 툴 목록을 Anthropic 포맷으로 반환.
 * @param {{ name: string, url: string, transport?: string, description: string }} skill
 * @returns {Promise<{ client: McpClient, tools: Array }>}
 */
async function connectMcpSkill(skill) {
  const mcpClient = new McpClient(
    { name: 'claude-discord', version: '1.0.0' },
    { capabilities: {} }
  );

  let transport;
  if (skill.transport === 'sse') {
    transport = new SSEClientTransport(new URL(skill.url));
  } else {
    transport = new StreamableHTTPClientTransport(new URL(skill.url));
  }

  await mcpClient.connect(transport);
  const { tools } = await mcpClient.listTools();

  const anthropicTools = tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: t.inputSchema ?? { type: 'object', properties: {} },
  }));

  return { client: mcpClient, tools: anthropicTools };
}

// ─────────────────────────────────────────────
// 컨텍스트 압축 저장
// ─────────────────────────────────────────────

/**
 * messages 배열을 DB에 저장. MSG_PAIR_LIMIT 초과 시 Claude로 압축.
 * @param {string} channelId
 * @param {Array} messages
 */
async function saveMessagesWithCompression(channelId, messages) {
  const userMsgCount = messages.filter((m) => m.role === 'user').length;

  if (userMsgCount > MSG_PAIR_LIMIT) {
    console.log(`[컨텍스트 압축] 채널 ${channelId} - ${userMsgCount}쌍 → 요약 압축`);
    try {
      const recentMessages = messages.slice(-(SUMMARY_PAIRS * 2));
      const oldMessages    = messages.slice(0, -(SUMMARY_PAIRS * 2));

      // 텍스트 메시지만 추출
      const oldText = oldMessages
        .filter((m) => typeof m.content === 'string')
        .map((m) => `${m.role === 'user' ? '사용자' : 'Claude'}: ${m.content}`)
        .join('\n');

      if (oldText) {
        const summaryResp = await anthropic.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 1024,
          messages: [{ role: 'user', content: `다음 대화를 3-5문장으로 요약해줘:\n${oldText}` }],
        });
        const summary = summaryResp.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('');

        const compressedMessages = [
          { role: 'user', content: `[이전 대화 요약]\n${summary}` },
          { role: 'assistant', content: '이전 대화 내용을 확인했습니다.' },
          ...recentMessages,
        ];

        saveSession(channelId, { messages: JSON.stringify(compressedMessages) });
        return;
      }
    } catch (err) {
      console.error('[컨텍스트 압축 실패]', err.message);
    }
  }

  saveSession(channelId, { messages: JSON.stringify(messages) });
}

// ─────────────────────────────────────────────
// Claude API 호출 (agentic loop)
// ─────────────────────────────────────────────

/**
 * Claude API 호출. 활성 MCP 스킬이 있으면 agentic loop 실행.
 * messages 배열을 DB에서 로드하고 저장.
 * @param {string} channelId
 * @param {string} question
 * @returns {Promise<string>} - Claude 응답 텍스트
 */
async function callClaude(channelId, question) {
  const session         = getSession(channelId);
  const activeSkillNames = getChannelSkills(channelId);
  const allSkills       = loadSkills();

  let messages = JSON.parse(session.messages || '[]');

  // 시스템 프롬프트
  let systemPrompt = 'You are a helpful assistant on Discord. Respond in the same language as the user.';
  if (session.topic) systemPrompt += `\n\n현재 대화 주제: ${session.topic}`;

  // 새 사용자 질문 추가
  messages.push({ role: 'user', content: question });

  // MCP 클라이언트 연결
  const mcpConnections = []; // { client, skillName, tools }
  const allTools = [];

  for (const skillName of activeSkillNames) {
    const skill = allSkills.find((s) => s.name === skillName);
    if (!skill) continue;
    try {
      const { client, tools } = await connectMcpSkill(skill);
      mcpConnections.push({ client, skillName, tools });
      allTools.push(...tools);
    } catch (err) {
      console.error(`[MCP 연결 실패] ${skillName}: ${err.message}`);
    }
  }

  let finalText = '';
  let iterations = 0;

  try {
    while (iterations < MAX_TOOL_ITERS) {
      iterations++;

      const response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages,
        ...(allTools.length > 0 && { tools: allTools }),
      });

      if (response.stop_reason === 'end_turn') {
        finalText = response.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        messages.push({ role: 'assistant', content: response.content });
        break;
      }

      if (response.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content });

        const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
        const toolResults   = [];

        for (const toolBlock of toolUseBlocks) {
          let resultContent = '';
          try {
            // 해당 툴을 가진 MCP 연결 찾기
            const conn = mcpConnections.find((c) =>
              c.tools.some((t) => t.name === toolBlock.name)
            );
            if (!conn) throw new Error(`툴 ${toolBlock.name}을 처리할 MCP 서버를 찾을 수 없음`);

            const mcpResult = await conn.client.callTool({
              name: toolBlock.name,
              arguments: toolBlock.input,
            });
            resultContent = mcpResult.content
              .map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)))
              .join('\n');
          } catch (err) {
            resultContent = `오류: ${err.message}`;
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolBlock.id,
            content: resultContent,
          });
        }

        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      // max_tokens 등 기타 stop_reason
      finalText = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      messages.push({
        role: 'assistant',
        content: typeof finalText === 'string' ? finalText : JSON.stringify(finalText),
      });
      break;
    }

    if (!finalText && iterations >= MAX_TOOL_ITERS) {
      finalText = '(최대 반복 횟수 초과. `/history clear` 또는 다시 시도해주세요.)';
    }
  } finally {
    // MCP 연결 정리
    for (const { client } of mcpConnections) {
      try { await client.close(); } catch { /* 무시 */ }
    }
  }

  // DB 저장 (압축 포함)
  await saveMessagesWithCompression(channelId, messages);

  return finalText;
}

/**
 * 채널 세션 컨텍스트와 topic을 이용해 Claude를 호출한다.
 * @param {string} channelId
 * @param {string} question
 * @returns {Promise<string>} - Claude 응답
 */
async function askClaude(channelId, question) {
  return callClaude(channelId, question);
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

const client = new DiscordClient({
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
    .setDescription('현재 채널의 대화 히스토리를 출력합니다')
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
        saveSession(channelId, { messages: '[]' });
        await interaction.reply('대화 히스토리가 초기화되었습니다.');
      } catch (err) {
        console.error('[/history clear 오류]', err.message);
        await interaction.reply(`히스토리 초기화 중 오류가 발생했습니다: ${err.message}`);
      }
      return;
    }

    // sub === 'show'
    const session  = getSession(channelId);
    const messages = JSON.parse(session.messages || '[]');

    if (messages.length === 0) {
      await interaction.reply('아직 이 채널에 대화 히스토리가 없습니다.');
      return;
    }

    const topicLine = session.topic ? `**주제:** ${session.topic}\n\n` : '';
    // 텍스트 메시지만 표시 (tool_use/tool_result 제외)
    const historyText = messages
      .filter((m) => typeof m.content === 'string' && m.content.length > 0)
      .map((m) => `${m.role === 'user' ? '사용자' : 'Claude'}: ${m.content}`)
      .join('\n');

    const fullText = `${topicLine}**대화 히스토리:**\n\`\`\`\n${historyText}\n\`\`\``;

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

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('[오류] ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다. .env 파일을 확인하세요.');
  process.exit(1);
}

client.login(token).catch((err) => {
  console.error('[로그인 실패]', err.message);
  process.exit(1);
});
