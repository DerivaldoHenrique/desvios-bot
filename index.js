require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession }  = require('telegram/sessions');
const { NewMessage }     = require('telegram/events');
const TelegramBot        = require('node-telegram-bot-api');
const Anthropic          = require('@anthropic-ai/sdk');
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
const BACKUP_ID_FILE = '/tmp/desvios-backup-id.txt';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── State ────────────────────────────────────────────────────────────────────
let desvios     = {};
let pendingAcao = null;
let backupMsgId = null;

function loadLocalState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    desvios     = raw.desvios     || {};
    pendingAcao = raw.pendingAcao || null;
    console.log(`[STATE] ${Object.keys(desvios).length} desvios carregados do /tmp`);
  } catch (_) {}
  try { backupMsgId = parseInt(fs.readFileSync(BACKUP_ID_FILE, 'utf8').trim()); } catch (_) {}
}

function saveLocalState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ desvios, pendingAcao })); } catch (_) {}
}

async function restoreFromTelegram(client) {
  try {
    const messages = await client.getMessages(parseInt(MY_CHAT_ID), { limit: 80 });
    for (const m of messages) {
      const txt = m.message || '';
      if (txt.includes('[BACKUP ESTADO]')) {
        const jsonMatch = txt.match(/\{[\s\S]+\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          desvios     = parsed.desvios     || {};
          pendingAcao = parsed.pendingAcao || null;
          backupMsgId = m.id;
          fs.writeFileSync(BACKUP_ID_FILE, String(m.id));
          saveLocalState();
          console.log(`[BACKUP] Restaurado: ${Object.keys(desvios).length} desvios`);
          return true;
        }
      }
    }
  } catch (err) {
    console.error('[BACKUP] Erro ao restaurar:', err.message);
  }
  return false;
}

async function saveBackup() {
  saveLocalState();
  try {
    const payload = JSON.stringify({ desvios, pendingAcao });
    const text = `📦 [BACKUP ESTADO]\n${payload}`;
    if (backupMsgId) {
      await bot.editMessageText(text, { chat_id: MY_CHAT_ID, message_id: backupMsgId });
    } else {
      const sent = await bot.sendMessage(MY_CHAT_ID, text);
      backupMsgId = sent.message_id;
      fs.writeFileSync(BACKUP_ID_FILE, String(backupMsgId));
    }
  } catch (err) {
    console.error('[BACKUP] Erro ao salvar:', err.message);
  }
}

// ─── Bot ──────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ─── Claude Vision: extrai campos do relatório ────────────────────────────────
async function parseComClaude(buffer, mimeType) {
  const base64    = buffer.toString('base64');
  const mediaType = (mimeType && mimeType.startsWith('image/')) ? mimeType : 'image/jpeg';

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 },
        },
        {
          type: 'text',
          text: `Você está analisando uma imagem de um relatório chamado "DIÁRIO DE BORDO" de desvio operacional de uma empresa de transporte.

Extraia os seguintes campos e retorne SOMENTE um JSON válido, sem markdown, sem texto extra:

{
  "id": "valor do campo Identificação no topo direito (formato DI-XXXX)",
  "evento": "tipo do evento — item 1 da tabela",
  "placa": "placa do veículo — item 2",
  "motorista": "nome completo do motorista/ajudante — item 3",
  "dataDesvio": "data do desvio em formato YYYY-MM-DD — item 4",
  "horario": "horário do desvio em HH:MM — item 5",
  "turno": "NOTURNO ou DIURNO — item 6",
  "reincidente": "SIM ou NÃO — item 7",
  "unidade": "nome da unidade — item 9",
  "supervisor": "nome do supervisor — item 10",
  "gravidade": "ALTA, MÉDIA ou BAIXA — item 13",
  "descricao": "descrição do evento — item 15",
  "analise": "análise completa — item 16",
  "respondente": "nome do respondente no cabeçalho",
  "dataResposta": "data de resposta no cabeçalho em DD/MM/YYYY HH:MM"
}

Se um campo não estiver visível, use null. Não invente valores.`,
        },
      ],
    }],
  });

  const text = response.content[0].text.trim();
  // Remove possíveis blocos markdown
  const clean = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
  return JSON.parse(clean);
}

// ─── Parse PDF com pdf-parse ──────────────────────────────────────────────────
async function parseComPdfParse(buffer) {
  const data = await pdfParse(buffer);
  // Para PDFs também usamos Claude Vision convertendo para texto estruturado
  // mas primeiro tenta extrair direto se o texto for legível
  const text = data.text;
  const idMatch = text.match(/DI-\d+/i);
  if (!idMatch) throw new Error('PDF sem ID de desvio');
  // Usa o texto extraído para montar campos básicos
  return {
    id:          (text.match(/DI-\d+/i)?.[0] || `DI-${Date.now().toString().slice(-6)}`).toUpperCase(),
    evento:      text.match(/\bFADIGA\b|\bDISTRAÇÃO\b|\bSONOLÊNCIA\b|\bDORMINDO\b/i)?.[0] || null,
    placa:       text.match(/PLACA[^\n]*\n([A-Z0-9\-]{5,12})/i)?.[1]?.trim() || null,
    motorista:   text.match(/NOME DO MOTORISTA[^\n]*\n([^\n]{5,50})/i)?.[1]?.trim() || null,
    dataDesvio:  text.match(/\b(202\d-\d{2}-\d{2})\b/)?.[1] || null,
    horario:     text.match(/\b(\d{2}:\d{2})\b/)?.[1] || null,
    turno:       text.match(/\b(NOTURNO|DIURNO)\b/i)?.[1]?.toUpperCase() || null,
    reincidente: text.match(/REINCIDENTE[^\n]*(SIM|NÃO|NAO)/i)?.[1]?.toUpperCase() || null,
    unidade:     text.match(/UNIDADE[^\n]*\n([^\n]{3,30})/i)?.[1]?.trim() || null,
    supervisor:  text.match(/SUPERVISOR[^\n]*\n([^\n]{3,40})/i)?.[1]?.trim() || null,
    gravidade:   text.match(/\b(ALTA|MÉDIA|MEDIA|BAIXA)\b/i)?.[1]?.toUpperCase().replace('MEDIA','MÉDIA') || null,
    descricao:   text.match(/DESCRIÇÃO DE EVENTO[^\n]*\n([^\n]{5,})/i)?.[1]?.trim() || null,
    analise:     text.match(/ANÁLISE[^\n]*\n([\s\S]{20,400}?)(?:\n\n|\d{2}\/\d{2}|$)/i)?.[1]?.replace(/\s+/g,' ').trim() || null,
    respondente: text.match(/Respondente:\s*([^\n]+)/i)?.[1]?.trim() || null,
    dataResposta: text.match(/Data de Resposta:\s*([^\n]+)/i)?.[1]?.trim() || null,
  };
}

// ─── Detecta se é relatório de desvio ────────────────────────────────────────
function isRelatorioDesvio(campos) {
  // Tem ID no formato DI- OU tem pelo menos 3 campos preenchidos
  if (campos.id && /DI-\d+/i.test(campos.id)) return true;
  const preenchidos = Object.values(campos).filter(v => v && v !== 'null').length;
  return preenchidos >= 4;
}

// ─── Monta registro do desvio ─────────────────────────────────────────────────
function montarDesvio(campos) {
  const id = (campos.id && /DI-\d+/i.test(campos.id))
    ? campos.id.toUpperCase()
    : `DI-${Date.now().toString().slice(-6)}`;

  return {
    id,
    evento:       campos.evento      || '—',
    placa:        campos.placa       || '—',
    motorista:    campos.motorista   || '—',
    dataDesvio:   campos.dataDesvio  || '—',
    horario:      campos.horario     || '—',
    turno:        campos.turno       || '—',
    reincidente:  campos.reincidente || '—',
    unidade:      campos.unidade     || '—',
    supervisor:   campos.supervisor  || '—',
    gravidade:    campos.gravidade   || '—',
    descricao:    campos.descricao   || '—',
    analise:      campos.analise     || '—',
    respondente:  campos.respondente || '—',
    dataResposta: campos.dataResposta || '—',
    status:       'PENDENTE',
    criadoEm:     new Date().toISOString(),
  };
}

// ─── Processa mídia (foto ou documento) ──────────────────────────────────────
async function processarMidia(buffer, mimeType, origem) {
  let campos;
  const isPdf = mimeType === 'application/pdf';

  if (isPdf) {
    campos = await parseComPdfParse(buffer);
  } else {
    // Imagem → Claude Vision
    campos = await parseComClaude(buffer, mimeType);
  }

  if (!isRelatorioDesvio(campos)) {
    console.log(`[${origem}] Ignorado: não parece relatório de desvio`);
    return null;
  }

  return montarDesvio(campos);
}

// ─── Emojis ───────────────────────────────────────────────────────────────────
function gravidadeEmoji(g) {
  const l = (g || '').toLowerCase();
  if (l.includes('alta') || l.includes('crítica')) return '🔴';
  if (l.includes('média') || l.includes('media'))  return '🟡';
  if (l.includes('baixa'))                         return '🟢';
  return '⚪';
}
function statusEmoji(s) {
  if (s === 'PENDENTE')     return '🔴';
  if (s === 'EM_TRATATIVA') return '🟡';
  if (s === 'CONCLUIDO')    return '✅';
  return '⚪';
}
function campo(label, val) {
  return (val && val !== '—') ? `${label} ${val}\n` : '';
}

// ─── Formata resumo ───────────────────────────────────────────────────────────
function formatResumo(d, completo = false) {
  const gEmoji   = gravidadeEmoji(d.gravidade);
  const reincAviso = (d.reincidente || '').toUpperCase() === 'SIM' ? '⚠️ *REINCIDENTE*\n' : '';

  let msg =
    `🚨 *Desvio ${d.id}* ${statusEmoji(d.status)}\n` +
    reincAviso + `\n` +
    campo('👤 *Motorista:*', d.motorista) +
    campo('🚛 *Placa:*', d.placa) +
    campo(`📅 *Data/Hora:*`, d.dataDesvio && d.horario !== '—'
      ? `${d.dataDesvio} às ${d.horario} (${d.turno})`
      : d.dataDesvio || d.horario) +
    campo('📍 *Unidade:*', d.unidade) +
    campo('👔 *Supervisor:*', d.supervisor) +
    `\n` +
    campo('⚡ *Evento:*', d.evento) +
    `${gEmoji} *Gravidade:* ${d.gravidade}\n`;

  if (d.descricao && d.descricao !== '—' && d.descricao !== d.evento) {
    msg += `\n📝 *Descrição:* ${d.descricao}\n`;
  }

  if (completo && d.analise && d.analise !== '—') {
    msg += `\n📊 *Análise:*\n${d.analise.slice(0, 600)}\n`;
    if (d.respondente && d.respondente !== '—') {
      msg += `\n📋 *Respondente:* ${d.respondente}\n`;
      msg += campo('🕐 *Data Resposta:*', d.dataResposta);
    }
  }

  msg += `\n─────────────────\n📌 *Status:* ${d.status}`;

  if (d.status === 'PENDENTE') {
    msg += `\n\nDigite *sim* para iniciar tratativa ou *não* para ignorar.`;
  }

  return msg;
}

// ─── Notifica novo desvio ─────────────────────────────────────────────────────
async function notificarDesvio(desvio) {
  pendingAcao = { desvioId: desvio.id, aguardando: 'confirmacao' };
  await saveBackup();
  await bot.sendMessage(MY_CHAT_ID, formatResumo(desvio), { parse_mode: 'Markdown' });
  console.log(`[BOT] Desvio ${desvio.id} notificado — ${desvio.motorista}`);
}

// ─── Comandos do bot ──────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (String(msg.chat.id) !== String(MY_CHAT_ID)) return;
  const text = (msg.text || '').trim();
  if (!text) return;

  // ── /desvios ────────────────────────────────────────────────────────────────
  if (text === '/desvios') {
    const list = Object.values(desvios);
    if (list.length === 0) { await bot.sendMessage(MY_CHAT_ID, '✅ Nenhum desvio registrado.'); return; }

    const grupos = {
      PENDENTE:     list.filter(d => d.status === 'PENDENTE'),
      EM_TRATATIVA: list.filter(d => d.status === 'EM_TRATATIVA'),
      CONCLUIDO:    list.filter(d => d.status === 'CONCLUIDO'),
    };

    const linha = (d) => {
      const data  = d.dataDesvio !== '—' ? d.dataDesvio : d.criadoEm?.slice(0,10);
      const nome  = d.motorista  !== '—' ? d.motorista  : '(nome não identificado)';
      const evt   = d.evento     !== '—' ? ` | ${d.evento}` : '';
      const grav  = d.gravidade  !== '—' ? ` ${gravidadeEmoji(d.gravidade)}` : '';
      return `  • \`${d.id}\`${grav} ${nome}${evt} | ${data}\n`;
    };

    let msgOut = `📋 *Desvios — ${list.length} total*\n\n`;
    if (grupos.PENDENTE.length)     { msgOut += `🔴 *Pendentes (${grupos.PENDENTE.length}):*\n`;     grupos.PENDENTE.forEach(d => { msgOut += linha(d); }); }
    if (grupos.EM_TRATATIVA.length) { msgOut += `\n🟡 *Em Tratativa (${grupos.EM_TRATATIVA.length}):*\n`; grupos.EM_TRATATIVA.forEach(d => { msgOut += linha(d); }); }
    if (grupos.CONCLUIDO.length)    { msgOut += `\n✅ *Concluídos (${grupos.CONCLUIDO.length}):*\n`; grupos.CONCLUIDO.slice(-5).forEach(d => { msgOut += linha(d); }); }
    msgOut += `\n_Use /desvio DI-XXXX para detalhes_`;

    await bot.sendMessage(MY_CHAT_ID, msgOut, { parse_mode: 'Markdown' });
    return;
  }

  // ── /desvio ID ──────────────────────────────────────────────────────────────
  const desvioCmd = text.match(/^\/desvio\s+([A-Z]{2}-[\dA-Z]+)/i);
  if (desvioCmd) {
    const id = desvioCmd[1].toUpperCase();
    const d  = desvios[id];
    if (!d) { await bot.sendMessage(MY_CHAT_ID, `❌ \`${id}\` não encontrado.`, { parse_mode: 'Markdown' }); return; }
    await bot.sendMessage(MY_CHAT_ID, formatResumo(d, true), { parse_mode: 'Markdown' });
    return;
  }

  // ── /pendentes ──────────────────────────────────────────────────────────────
  if (text === '/pendentes') {
    const pend = Object.values(desvios).filter(d => d.status === 'PENDENTE');
    if (pend.length === 0) { await bot.sendMessage(MY_CHAT_ID, '✅ Nenhum desvio pendente.'); return; }
    for (const d of pend.slice(0, 5)) {
      await bot.sendMessage(MY_CHAT_ID, formatResumo(d), { parse_mode: 'Markdown' });
    }
    return;
  }

  // ── DD/MM/YYYY ──────────────────────────────────────────────────────────────
  const dateMatch = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dateMatch) {
    const [, dd, mm, yyyy] = dateMatch;
    const iso   = `${yyyy}-${mm}-${dd}`;
    const brFmt = `${dd}/${mm}/${yyyy}`;

    const encontrados = Object.values(desvios).filter(d => {
      const dv = (d.dataDesvio || '') + (d.criadoEm || '');
      return dv.includes(iso) || dv.includes(brFmt);
    }).sort((a, b) => (a.dataDesvio || '').localeCompare(b.dataDesvio || ''));

    if (encontrados.length === 0) {
      await bot.sendMessage(MY_CHAT_ID, `📭 Nenhum desvio em *${brFmt}*.`, { parse_mode: 'Markdown' });
      return;
    }

    let msg = `📅 *Desvios em ${brFmt}* — ${encontrados.length} registro(s)\n\n`;
    encontrados.forEach((d, i) => {
      msg +=
        `*${i+1}. ${d.id}* ${statusEmoji(d.status)} ${gravidadeEmoji(d.gravidade)}\n` +
        `👤 ${d.motorista !== '—' ? d.motorista : '—'}\n` +
        `⚡ ${d.evento} | 🕐 ${d.horario}\n` +
        (d.placa !== '—' ? `🚛 ${d.placa}\n` : '') +
        `📌 ${d.status}\n\n`;
    });
    msg += `_Use /desvio DI-XXXX para detalhes completos_`;
    await bot.sendMessage(MY_CHAT_ID, msg, { parse_mode: 'Markdown' });
    return;
  }

  // ── /sincronizar [dias] ─────────────────────────────────────────────────────
  const sincMatch = text.match(/^\/sincronizar(?:\s+(\d+))?$/i);
  if (sincMatch) {
    const dias = parseInt(sincMatch[1] || '7');
    await bot.sendMessage(MY_CHAT_ID, `🔄 Buscando relatórios dos últimos *${dias} dias*...`, { parse_mode: 'Markdown' });
    sincronizarGrupo(dias).catch(err => bot.sendMessage(MY_CHAT_ID, `❌ Erro: ${err.message}`));
    return;
  }

  // ── Confirmação de tratativa ────────────────────────────────────────────────
  if (pendingAcao?.aguardando === 'confirmacao') {
    const lower = text.toLowerCase();
    const id    = pendingAcao.desvioId;
    const d     = desvios[id];

    if (lower === 'sim' || lower === 's') {
      if (d) { d.status = 'EM_TRATATIVA'; await saveBackup(); }
      await bot.sendMessage(MY_CHAT_ID,
        `✅ Desvio \`${id}\` → *EM TRATATIVA*\n📧 Em breve: envio automático de e-mail.`,
        { parse_mode: 'Markdown' });
      pendingAcao = null;
      await saveBackup();
      return;
    }
    if (lower === 'não' || lower === 'nao' || lower === 'n') {
      await bot.sendMessage(MY_CHAT_ID, `⏭ \`${id}\` mantido como PENDENTE.`, { parse_mode: 'Markdown' });
      pendingAcao = null;
      await saveBackup();
      return;
    }
  }

  // ── Help ────────────────────────────────────────────────────────────────────
  await bot.sendMessage(MY_CHAT_ID,
    `*Desvios Bot*\n\n` +
    `Comandos:\n` +
    `/desvios — lista completa\n` +
    `/desvio DI-0001 — detalhes\n` +
    `/pendentes — aguardando tratativa\n` +
    `/sincronizar 7 — importar últimos N dias\n\n` +
    `DD/MM/AAAA — desvios de uma data\n\n` +
    `Quando um relatório chegar, responda *sim* ou *não*.`,
    { parse_mode: 'Markdown' });
});

// ─── Referências globais ao userbot ──────────────────────────────────────────
let userbotClient  = null;
let userbotGroupId = null;

// ─── Sincronização retroativa ─────────────────────────────────────────────────
async function sincronizarGrupo(dias = 7) {
  if (!userbotClient || !userbotGroupId) {
    await bot.sendMessage(MY_CHAT_ID, '❌ Userbot não conectado.');
    return;
  }

  const limitTs = Math.floor((Date.now() - dias * 86400000) / 1000);
  let novos = 0, ignorados = 0, erros = 0;

  const messages = await userbotClient.getMessages(userbotGroupId, { limit: 300 });
  const candidatos = messages.filter(m => {
    if (m.date < limitTs) return false;
    if (SENDER_ID && Number(m.senderId) !== SENDER_ID) return false;
    return !!(m.media?.photo || m.media?.document);
  });

  console.log(`[SINC] ${candidatos.length} mensagens com mídia do sender no período`);

  for (const m of candidatos) {
    const hasPhoto = !!m.media?.photo;
    const doc      = m.media?.document;
    let mimeType   = 'image/jpeg';

    if (doc) {
      mimeType = doc.mimeType || '';
      const fn = doc.attributes?.find(a => a.fileName)?.fileName || '';
      const isPdf = mimeType === 'application/pdf' || fn.toLowerCase().endsWith('.pdf');
      const isImg = mimeType.startsWith('image/');
      if (!isPdf && !isImg) { console.log(`[SINC] Ignorando ${mimeType}`); continue; }
    }

    try {
      const buffer = await userbotClient.downloadMedia(m, {});
      if (!buffer || buffer.length === 0) continue;

      const desvio = await processarMidia(buffer, mimeType, 'SINC');
      if (!desvio) { ignorados++; continue; }
      if (desvios[desvio.id]) { ignorados++; continue; }

      desvios[desvio.id] = desvio;
      novos++;
      console.log(`[SINC] Importado: ${desvio.id} — ${desvio.motorista}`);
    } catch (err) {
      console.error(`[SINC] Erro msg ${m.id}:`, err.message);
      erros++;
    }
  }

  await saveBackup();
  await bot.sendMessage(MY_CHAT_ID,
    `✅ *Sincronização concluída!*\n` +
    `📥 ${novos} novo(s) | ⏭ ${ignorados} ignorado(s) | ❌ ${erros} erro(s)\n\n` +
    (novos > 0 ? `Use /desvios para ver.` : `Nenhum relatório novo encontrado.`),
    { parse_mode: 'Markdown' });
}

// ─── Userbot ──────────────────────────────────────────────────────────────────
async function startUserbot() {
  if (!API_ID || !API_HASH || !SESSION_STR) {
    console.warn('[USERBOT] Credenciais MTProto não configuradas.');
    return;
  }

  const client = new TelegramClient(new StringSession(SESSION_STR), API_ID, API_HASH, {
    connectionRetries: 5,
  });

  await client.connect();
  console.log('[USERBOT] Conectado.');

  // Encontra grupo
  const dialogs = await client.getDialogs({ limit: 100 });
  for (const d of dialogs) {
    if (d.title && d.title.toLowerCase().includes(GROUP_NAME.toLowerCase())) {
      userbotGroupId = d.id;
      console.log(`[USERBOT] Grupo: "${d.title}" (${d.id})`);
      break;
    }
  }

  if (!userbotGroupId) {
    console.error(`[USERBOT] Grupo "${GROUP_NAME}" não encontrado.`);
    return;
  }

  userbotClient = client;

  // Listener de novas mensagens
  client.addEventHandler(async (event) => {
    try {
      const message = event.message;
      if (!message) return;

      // Filtra grupo
      const peerId   = message.peerId;
      const chatId   = peerId?.channelId ?? peerId?.chatId ?? peerId?.userId;
      const absGroup = BigInt(String(userbotGroupId).replace('-100', '').replace('-', ''));
      if (BigInt(String(chatId ?? 0)) !== absGroup) return;

      // Filtra sender
      if (SENDER_ID && Number(message.senderId) !== SENDER_ID) return;

      const media    = message.media;
      const hasPhoto = !!media?.photo;
      const doc      = media?.document;
      if (!hasPhoto && !doc) return;

      let mimeType = 'image/jpeg';
      if (doc) {
        mimeType = doc.mimeType || '';
        const fn = doc.attributes?.find(a => a.fileName)?.fileName || '';
        const isPdf = mimeType === 'application/pdf' || fn.toLowerCase().endsWith('.pdf');
        const isImg = mimeType.startsWith('image/');
        if (!isPdf && !isImg) return;
      }

      console.log(`[USERBOT] Nova mídia recebida — tipo: ${mimeType}, foto: ${hasPhoto}`);

      const buffer = await client.downloadMedia(message, {});
      if (!buffer || buffer.length === 0) return;

      const desvio = await processarMidia(buffer, mimeType, 'USERBOT');
      if (!desvio) return;

      if (desvios[desvio.id]) {
        console.log(`[USERBOT] Desvio ${desvio.id} já existe, ignorando.`);
        return;
      }

      desvios[desvio.id] = desvio;
      await notificarDesvio(desvio);

    } catch (err) {
      console.error('[USERBOT] Erro no handler:', err.message);
    }
  }, new NewMessage({}));

  console.log('[USERBOT] Monitorando...');
}

// ─── Startup ──────────────────────────────────────────────────────────────────
(async () => {
  console.log('[BOT] Iniciando Desvios Bot...');
  loadLocalState();

  try {
    await startUserbot();
  } catch (err) {
    console.error('[USERBOT] Falha:', err.message);
  }

  if (userbotClient && Object.keys(desvios).length === 0) {
    await restoreFromTelegram(userbotClient).catch(() => {});
  }

  // Delay para evitar 409 Conflict no Railway
  console.log('[BOT] Aguardando 8s antes de iniciar polling...');
  await new Promise(r => setTimeout(r, 8000));
  bot.startPolling({ restart: false });
  console.log('[BOT] Polling iniciado.');

  await bot.sendMessage(MY_CHAT_ID,
    `🤖 *Desvios Bot iniciado!*\n` +
    `📋 ${Object.keys(desvios).length} desvios carregados\n` +
    `🔍 Monitorando: _${GROUP_NAME}_\n` +
    `🤖 Parser: Claude Vision\n\n` +
    `/desvios · /pendentes · /sincronizar 7\n` +
    `DD/MM/AAAA — desvios por data`,
    { parse_mode: 'Markdown' });

  console.log('[BOT] Pronto.');
})();
