require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession }  = require('telegram/sessions');
const { NewMessage }     = require('telegram/events');
const TelegramBot        = require('node-telegram-bot-api');
const pdfParse           = require('pdf-parse');
const fs                 = require('fs');

// ─── Config ───────────────────────────────────────────────────────────────────
const API_ID        = parseInt(process.env.TELEGRAM_API_ID);
const API_HASH      = process.env.TELEGRAM_API_HASH;
const SESSION_STR   = process.env.TELEGRAM_SESSION || '';
const GROUP_NAME    = process.env.TELEGRAM_GROUP_NAME || 'OPERAÇÃO QSEMST - ES - BNL';
const SENDER_ID     = process.env.TELEGRAM_SENDER_ID ? parseInt(process.env.TELEGRAM_SENDER_ID) : null;
const BOT_TOKEN     = process.env.DESVIOS_BOT_TOKEN;
const MY_CHAT_ID    = process.env.TELEGRAM_MY_CHAT_ID;
const STATE_FILE    = '/tmp/desvios-state.json';

// ─── Desvios state ────────────────────────────────────────────────────────────
let desvios = {};           // { [id]: DesvioRecord }
let pendingAcao = null;     // { desvioId, aguardando: 'confirmacao' }

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    desvios     = raw.desvios     || {};
    pendingAcao = raw.pendingAcao || null;
    console.log(`[STATE] ${Object.keys(desvios).length} desvios carregados`);
  } catch (_) {}
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ desvios, pendingAcao }));
  } catch (_) {}
}

// ─── Desvios bot (envia msgs ao usuário) ──────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── PDF Parser ───────────────────────────────────────────────────────────────
function extractField(text, label) {
  // Tenta capturar o valor após o rótulo, até a próxima linha não-vazia
  const regex = new RegExp(label + '[\\s\\n]+([^\\n]+(?:\\n(?![A-Z]{3})[^\\n]+)*)', 'i');
  const m = text.match(regex);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

function parseDesvioId(text) {
  const m = text.match(/Identifica[çc][aã]o[:\s]+([A-Z]{2}-\d+)/i);
  return m ? m[1] : `DI-${Date.now().toString().slice(-6)}`;
}

async function parsePdf(buffer) {
  const data = await pdfParse(buffer);
  const text = data.text;

  const get = (label) => extractField(text, label);

  // Extrai campos principais
  const id          = parseDesvioId(text);
  const evento      = get('EVENTO') || get('1\\s+EVENTO') || get('EVENTO 1');
  const placa       = get('PLACA')  || get('PLACA 2');
  const motorista   = get('NOME DO MOTORISTA[/A-Z ]*QUE COMETEU') || get('MOTORISTA[/\\w ]+DESVIO');
  const dataDesvio  = get('DATA DO DESVIO');
  const horario     = get('HOR[ÁA]RIO DO DESVIO');
  const turno       = get('TURNO');
  const reincidente = get('MOTORISTA REINCIDENTE');
  const unidade     = get('UNIDADE');
  const supervisor  = get('SUPERVISOR');
  const gravidade   = get('GRAVIDADE DO DESVIO');
  const descricao   = get('DESCRI[ÇC][ÃA]O DE EVENTO');
  const analise     = get('AN[ÁA]LISE');
  const autor       = get('Autor');
  const respondente = get('Respondente');
  const dataResp    = get('Data de Resposta');

  return {
    id,
    evento:      evento      || '—',
    placa:       placa       || '—',
    motorista:   motorista   || '—',
    dataDesvio:  dataDesvio  || '—',
    horario:     horario     || '—',
    turno:       turno       || '—',
    reincidente: reincidente || '—',
    unidade:     unidade     || '—',
    supervisor:  supervisor  || '—',
    gravidade:   gravidade   || '—',
    descricao:   descricao   || '—',
    analise:     analise     || '—',
    autor:       autor       || '—',
    respondente: respondente || '—',
    dataResposta: dataResp   || '—',
    status:      'PENDENTE',
    criadoEm:    new Date().toISOString(),
    rawText:     text,
  };
}

// ─── Gravidade emoji ──────────────────────────────────────────────────────────
function gravidadeEmoji(g) {
  const lower = (g || '').toLowerCase();
  if (lower.includes('alta') || lower.includes('crítica')) return '🔴';
  if (lower.includes('média') || lower.includes('media'))  return '🟡';
  if (lower.includes('baixa'))                             return '🟢';
  return '⚪';
}

// ─── Formata resumo do desvio ─────────────────────────────────────────────────
function formatResumo(d, { completo = false } = {}) {
  const gEmoji = gravidadeEmoji(d.gravidade);
  const reincIcon = d.reincidente?.toLowerCase().includes('sim') ? '⚠️ *REINCIDENTE*\n' : '';

  let msg =
    `🚨 *Novo Desvio Identificado — ${d.id}*\n` +
    reincIcon +
    `\n` +
    `👤 *Motorista:* ${d.motorista}\n` +
    `🚛 *Placa:* ${d.placa}\n` +
    `📅 *Data/Hora:* ${d.dataDesvio} às ${d.horario} (${d.turno})\n` +
    `📍 *Unidade:* ${d.unidade}\n` +
    `👔 *Supervisor:* ${d.supervisor}\n` +
    `\n` +
    `⚡ *Evento:* ${d.evento}\n` +
    `${gEmoji} *Gravidade:* ${d.gravidade}\n` +
    `\n` +
    `📝 *Descrição:* ${d.descricao}\n`;

  if (completo) {
    msg +=
      `\n📊 *Análise:*\n${d.analise}\n` +
      `\n` +
      `📋 *Respondente:* ${d.respondente}\n` +
      `🕐 *Data Resposta:* ${d.dataResposta}\n`;
  }

  msg +=
    `\n─────────────────────\n` +
    `📌 *Status:* ${d.status}\n` +
    `\nDigite *sim* para iniciar a tratativa ou *não* para ignorar.`;

  return msg;
}

// ─── Envia resumo ao usuário ──────────────────────────────────────────────────
async function notificarDesvio(desvio) {
  pendingAcao = { desvioId: desvio.id, aguardando: 'confirmacao' };
  saveState();
  await bot.sendMessage(MY_CHAT_ID, formatResumo(desvio), { parse_mode: 'Markdown' });
  console.log(`[BOT] Desvio ${desvio.id} notificado ao usuário`);
}

// ─── Telegram bot commands ────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (String(msg.chat.id) !== String(MY_CHAT_ID)) return;
  const text = (msg.text || '').trim();
  if (!text) return;

  // /desvios — lista todos os desvios
  if (text === '/desvios') {
    const list = Object.values(desvios);
    if (list.length === 0) {
      await bot.sendMessage(MY_CHAT_ID, '✅ Nenhum desvio registrado.');
      return;
    }
    const pendentes   = list.filter(d => d.status === 'PENDENTE');
    const tratativas  = list.filter(d => d.status === 'EM_TRATATIVA');
    const concluidos  = list.filter(d => d.status === 'CONCLUIDO');

    let msg = `📋 *Desvios*\n\n`;
    if (pendentes.length) {
      msg += `🔴 *Pendentes (${pendentes.length}):*\n`;
      pendentes.forEach(d => {
        msg += `  • \`${d.id}\` — ${d.motorista} | ${d.evento} | ${d.dataDesvio}\n`;
      });
    }
    if (tratativas.length) {
      msg += `\n🟡 *Em Tratativa (${tratativas.length}):*\n`;
      tratativas.forEach(d => {
        msg += `  • \`${d.id}\` — ${d.motorista} | ${d.evento}\n`;
      });
    }
    if (concluidos.length) {
      msg += `\n✅ *Concluídos (${concluidos.length}):*\n`;
      concluidos.slice(-5).forEach(d => {
        msg += `  • \`${d.id}\` — ${d.motorista}\n`;
      });
    }
    await bot.sendMessage(MY_CHAT_ID, msg, { parse_mode: 'Markdown' });
    return;
  }

  // /desvio ID — detalhe completo
  const desvioCmd = text.match(/^\/desvio\s+([A-Z]{2}-\d+)/i);
  if (desvioCmd) {
    const id = desvioCmd[1].toUpperCase();
    const d  = desvios[id];
    if (!d) {
      await bot.sendMessage(MY_CHAT_ID, `❌ Desvio \`${id}\` não encontrado.`, { parse_mode: 'Markdown' });
      return;
    }
    await bot.sendMessage(MY_CHAT_ID, formatResumo(d, { completo: true }), { parse_mode: 'Markdown' });
    return;
  }

  // /pendentes — atalho para pendentes
  if (text === '/pendentes') {
    const pendentes = Object.values(desvios).filter(d => d.status === 'PENDENTE');
    if (pendentes.length === 0) {
      await bot.sendMessage(MY_CHAT_ID, '✅ Nenhum desvio pendente.');
      return;
    }
    for (const d of pendentes.slice(0, 5)) {
      await bot.sendMessage(MY_CHAT_ID, formatResumo(d), { parse_mode: 'Markdown' });
    }
    return;
  }

  // Resposta à confirmação de tratativa
  if (pendingAcao?.aguardando === 'confirmacao') {
    const lower = text.toLowerCase();
    const id    = pendingAcao.desvioId;
    const d     = desvios[id];

    if (lower === 'sim' || lower === 's') {
      if (d) {
        d.status = 'EM_TRATATIVA';
        saveState();
        await bot.sendMessage(MY_CHAT_ID,
          `✅ Desvio \`${id}\` marcado como *EM TRATATIVA*.\n\n` +
          `📧 Em breve: envio automático de e-mail ao supervisor ${d.supervisor}.`,
          { parse_mode: 'Markdown' });
        console.log(`[BOT] Desvio ${id} → EM_TRATATIVA`);
      }
      pendingAcao = null;
      saveState();
      return;
    }

    if (lower === 'não' || lower === 'nao' || lower === 'n') {
      await bot.sendMessage(MY_CHAT_ID,
        `⏭ Desvio \`${id}\` mantido como *PENDENTE*. Use /desvio ${id} para retomar.`,
        { parse_mode: 'Markdown' });
      pendingAcao = null;
      saveState();
      return;
    }
  }

  // Help
  await bot.sendMessage(MY_CHAT_ID,
    `Comandos:\n` +
    `/desvios — lista todos os desvios\n` +
    `/desvio DI-0001 — detalhes do desvio\n` +
    `/pendentes — desvios aguardando tratativa\n\n` +
    `Quando um novo relatório chegar, responda *sim* ou *não* para iniciar a tratativa.`);
});

// ─── Userbot (monitora o grupo) ───────────────────────────────────────────────
async function startUserbot() {
  if (!API_ID || !API_HASH || !SESSION_STR) {
    console.warn('[USERBOT] TELEGRAM_API_ID / API_HASH / SESSION não configurados — monitoramento de grupo desativado.');
    console.warn('[USERBOT] Execute "npm run auth" localmente para gerar a sessão.');
    return;
  }

  const client = new TelegramClient(new StringSession(SESSION_STR), API_ID, API_HASH, {
    connectionRetries: 5,
  });

  await client.connect();
  console.log('[USERBOT] Conectado como usuário.');

  // Encontra o grupo pelo nome
  let targetGroupId = null;
  const dialogs = await client.getDialogs({ limit: 100 });
  for (const d of dialogs) {
    if (d.title && d.title.toLowerCase().includes(GROUP_NAME.toLowerCase())) {
      targetGroupId = d.id;
      console.log(`[USERBOT] Grupo encontrado: "${d.title}" (ID: ${d.id})`);
      break;
    }
  }

  if (!targetGroupId) {
    console.error(`[USERBOT] Grupo "${GROUP_NAME}" não encontrado. Verifique TELEGRAM_GROUP_NAME.`);
    return;
  }

  // Listener de novas mensagens
  client.addEventHandler(async (event) => {
    try {
      const message = event.message;
      if (!message) return;

      // Filtra pelo grupo
      const chatId = message.peerId?.channelId || message.peerId?.chatId;
      const absGroupId = Math.abs(Number(targetGroupId));
      if (Math.abs(Number(chatId)) !== absGroupId) return;

      // Filtra pelo remetente (se configurado)
      if (SENDER_ID && Number(message.senderId) !== SENDER_ID) return;

      // Verifica se tem documento (PDF)
      const media = message.media;
      if (!media || !media.document) return;

      const doc      = media.document;
      const mimeType = doc.mimeType || '';
      const fileName = doc.attributes?.find(a => a.fileName)?.fileName || '';

      const isPdf = mimeType === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf');
      if (!isPdf) return;

      console.log(`[USERBOT] PDF recebido: "${fileName}" de sender ${message.senderId}`);

      // Download do PDF
      const buffer = await client.downloadMedia(message, { outputFile: Buffer });
      if (!buffer || buffer.length === 0) {
        console.error('[USERBOT] Buffer vazio ao baixar PDF');
        return;
      }

      // Parse
      let desvio;
      try {
        desvio = await parsePdf(buffer);
      } catch (err) {
        console.error('[USERBOT] Erro ao parsear PDF:', err.message);
        await bot.sendMessage(MY_CHAT_ID,
          `⚠️ Recebi um PDF do grupo mas não consegui extrair os dados.\nArquivo: ${fileName}\nErro: ${err.message}`);
        return;
      }

      // Guarda o desvio
      desvios[desvio.id] = desvio;
      saveState();

      // Notifica
      await notificarDesvio(desvio);

    } catch (err) {
      console.error('[USERBOT] Erro no handler:', err.message);
    }
  }, new NewMessage({}));

  console.log(`[USERBOT] Monitorando grupo "${GROUP_NAME}"...`);
}

// ─── Startup ──────────────────────────────────────────────────────────────────
(async () => {
  console.log('[BOT] Iniciando Desvios Bot...');
  loadState();

  try {
    await startUserbot();
  } catch (err) {
    console.error('[USERBOT] Falha ao iniciar:', err.message);
  }

  try {
    await bot.sendMessage(MY_CHAT_ID,
      `🤖 *Desvios Bot iniciado!*\n` +
      `📋 ${Object.keys(desvios).length} desvios carregados\n\n` +
      `Monitorando: _${GROUP_NAME}_\n\n` +
      `/desvios — lista completa\n` +
      `/pendentes — aguardando tratativa`,
      { parse_mode: 'Markdown' });
    console.log('[BOT] Pronto.');
  } catch (err) {
    console.error('[BOT] Erro na msg de startup:', err.message);
  }
})();
