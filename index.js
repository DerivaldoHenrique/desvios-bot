require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession }  = require('telegram/sessions');
const { NewMessage }     = require('telegram/events');
const TelegramBot        = require('node-telegram-bot-api');
const pdfParse           = require('pdf-parse');
const Tesseract          = require('tesseract.js');
const fs                 = require('fs');

// ─── Config ───────────────────────────────────────────────────────────────────
const API_ID        = parseInt(process.env.TELEGRAM_API_ID);
const API_HASH      = process.env.TELEGRAM_API_HASH;
const SESSION_STR   = process.env.TELEGRAM_SESSION || '';
const GROUP_NAME    = process.env.TELEGRAM_GROUP_NAME || 'OPERAÇÃO QSEMST - ES - BNL';
const SENDER_ID     = process.env.TELEGRAM_SENDER_ID ? parseInt(process.env.TELEGRAM_SENDER_ID) : null;
const BOT_TOKEN     = process.env.DESVIOS_BOT_TOKEN;
const MY_CHAT_ID    = process.env.TELEGRAM_MY_CHAT_ID;
const STATE_FILE      = '/tmp/desvios-state.json';
const BACKUP_ID_FILE  = '/tmp/desvios-backup-id.txt';

// ─── Desvios state ────────────────────────────────────────────────────────────
let desvios     = {};    // { [id]: DesvioRecord }
let pendingAcao = null;  // { desvioId, aguardando: 'confirmacao' }
let backupMsgId = null;  // ID da msg de backup editável no chat do bot

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

// Restaura estado lendo o histórico do chat com o bot via userbot (gramjs)
// Chamado no startup APÓS conectar o cliente MTProto
async function restoreFromTelegram(client) {
  try {
    const messages = await client.getMessages(parseInt(MY_CHAT_ID), { limit: 50 });
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
          console.log(`[BACKUP] Estado restaurado do Telegram: ${Object.keys(desvios).length} desvios`);
          return true;
        }
      }
    }
  } catch (err) {
    console.error('[BACKUP] Erro ao restaurar:', err.message);
  }
  return false;
}

// Salva estado como mensagem editável no chat do bot (sobrevive a qualquer restart)
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

// ─── Desvios bot (envia msgs ao usuário) ──────────────────────────────────────
// polling inicia manualmente após delay para evitar 409 no Railway
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ─── OCR (imagens) ────────────────────────────────────────────────────────────
async function ocrImage(buffer) {
  const { data: { text } } = await Tesseract.recognize(buffer, 'por', {
    logger: () => {},
  });
  return text;
}

// ─── Detecta se o texto parece um relatório de desvio ─────────────────────────
function isRelatorioDesvio(text) {
  const keywords = ['DIÁRIO DE BORDO', 'DESVIO', 'MOTORISTA', 'GRAVIDADE', 'EVENTO', 'ANÁLISE', 'DI-'];
  const upper = text.toUpperCase();
  const matches = keywords.filter(k => upper.includes(k)).length;
  return matches >= 3; // precisa ter pelo menos 3 palavras-chave
}

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

function parseDesvioFromText(text) {
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

// ─── Roteador: PDF ou imagem ──────────────────────────────────────────────────
async function parseDocument(buffer, mimeType) {
  const isPdf = mimeType === 'application/pdf';
  const isImg = mimeType?.startsWith('image/') || !mimeType;

  let text;
  if (isPdf) {
    const data = await pdfParse(buffer);
    text = data.text;
  } else if (isImg) {
    text = await ocrImage(buffer);
    console.log('[OCR] Texto extraído (primeiros 300 chars):', text.slice(0, 300));
  } else {
    throw new Error(`Tipo não suportado: ${mimeType}`);
  }

  if (!isRelatorioDesvio(text)) {
    throw new Error('NÃO_RELATORIO'); // sinal para ignorar sem erro
  }

  return parseDesvioFromText(text);
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

  // DD/MM/YYYY — desvios da data
  const dateMatch = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dateMatch) {
    const [, dd, mm, yyyy] = dateMatch;
    // Monta variações do formato que pode vir do PDF (2026-05-12, 13/05/2026, 2026/05/13...)
    const isoDate   = `${yyyy}-${mm}-${dd}`;   // 2026-05-12
    const brDate    = `${dd}/${mm}/${yyyy}`;    // 12/05/2026
    const brDate2   = `${dd}/${mm}`;            // 12/05 (parcial)

    const found = Object.values(desvios).filter(d => {
      const dv = (d.dataDesvio || '') + (d.criadoEm || '');
      return dv.includes(isoDate) || dv.includes(brDate) || dv.includes(brDate2);
    });

    if (found.length === 0) {
      await bot.sendMessage(MY_CHAT_ID, `📭 Nenhum desvio registrado em *${brDate}*.`, { parse_mode: 'Markdown' });
      return;
    }

    const gEmoji = (g) => {
      const l = (g || '').toLowerCase();
      if (l.includes('alta') || l.includes('crítica')) return '🔴';
      if (l.includes('média') || l.includes('media'))  return '🟡';
      if (l.includes('baixa'))                         return '🟢';
      return '⚪';
    };
    const statusIcon = (s) => s === 'PENDENTE' ? '🔴' : s === 'EM_TRATATIVA' ? '🟡' : '✅';

    let msg = `📅 *Desvios em ${brDate}* — ${found.length} registro(s)\n\n`;
    found.forEach((d, i) => {
      msg +=
        `*${i + 1}. ${d.id}* ${statusIcon(d.status)}\n` +
        `👤 ${d.motorista}\n` +
        `⚡ ${d.evento} ${gEmoji(d.gravidade)} ${d.gravidade}\n` +
        `🕐 ${d.horario} | 🚛 ${d.placa}\n` +
        `📌 ${d.status}\n\n`;
    });
    msg += `_Use /desvio ID para detalhes completos_`;

    await bot.sendMessage(MY_CHAT_ID, msg, { parse_mode: 'Markdown' });
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
        await saveBackup();
        await bot.sendMessage(MY_CHAT_ID,
          `✅ Desvio \`${id}\` marcado como *EM TRATATIVA*.\n\n` +
          `📧 Em breve: envio automático de e-mail ao supervisor ${d.supervisor}.`,
          { parse_mode: 'Markdown' });
        console.log(`[BOT] Desvio ${id} → EM_TRATATIVA`);
      }
      pendingAcao = null;
      await saveBackup();
      return;
    }

    if (lower === 'não' || lower === 'nao' || lower === 'n') {
      await bot.sendMessage(MY_CHAT_ID,
        `⏭ Desvio \`${id}\` mantido como *PENDENTE*. Use /desvio ${id} para retomar.`,
        { parse_mode: 'Markdown' });
      pendingAcao = null;
      await saveBackup();
      return;
    }
  }

  // /sincronizar [dias] — busca PDFs antigos do grupo
  const sincMatch = text.match(/^\/sincronizar(?:\s+(\d+))?$/i);
  if (sincMatch) {
    const dias = parseInt(sincMatch[1] || '7');
    await bot.sendMessage(MY_CHAT_ID, `🔄 Buscando PDFs dos últimos *${dias} dias* no grupo...`, { parse_mode: 'Markdown' });
    sincronizarGrupo(dias).catch(err =>
      bot.sendMessage(MY_CHAT_ID, `❌ Erro na sincronização: ${err.message}`)
    );
    return;
  }

  // Help
  await bot.sendMessage(MY_CHAT_ID,
    `Comandos:\n` +
    `/desvios — lista todos os desvios\n` +
    `/desvio DI-0001 — detalhes do desvio\n` +
    `/pendentes — aguardando tratativa\n` +
    `/sincronizar 7 — reprocessa PDFs dos últimos N dias\n\n` +
    `DD/MM/AAAA — desvios de uma data específica\n\n` +
    `Quando um novo relatório chegar, responda *sim* ou *não*.`);
});

// ─── Referências globais ao userbot ──────────────────────────────────────────
let userbotClient  = null;
let userbotGroupId = null;

// ─── Sincronização retroativa ─────────────────────────────────────────────────
async function sincronizarGrupo(dias = 7) {
  if (!userbotClient || !userbotGroupId) {
    await bot.sendMessage(MY_CHAT_ID, '❌ Userbot não conectado. Verifique as variáveis TELEGRAM_API_ID/HASH/SESSION.');
    return;
  }

  const limitDate = new Date();
  limitDate.setDate(limitDate.getDate() - dias);
  const limitTs = Math.floor(limitDate.getTime() / 1000);

  let novos = 0, ignorados = 0, erros = 0;
  const messages = await userbotClient.getMessages(userbotGroupId, { limit: 300 });
  console.log(`[SINC] Total de mensagens no grupo: ${messages.length}`);

  for (const m of messages) {
    if (m.date < limitTs) continue;

    // Filtra remetente (log para debug)
    if (SENDER_ID && Number(m.senderId) !== SENDER_ID) continue;

    const media    = m.media;
    const hasDoc   = !!media?.document;
    const hasPhoto = !!media?.photo;
    if (!hasDoc && !hasPhoto) continue;

    let mimeType = 'image/jpeg';
    if (hasDoc) {
      const doc  = media.document;
      mimeType   = doc.mimeType || '';
      const fn   = doc.attributes?.find(a => a.fileName)?.fileName || '';
      const isImg = mimeType.startsWith('image/');
      const isPdf = mimeType === 'application/pdf' || fn.toLowerCase().endsWith('.pdf');
      if (!isImg && !isPdf) {
        console.log(`[SINC] Ignorando doc tipo: ${mimeType} "${fn}"`);
        continue;
      }
    }

    console.log(`[SINC] Processando msg ${m.id} tipo=${mimeType} foto=${hasPhoto} sender=${m.senderId}`);

    try {
      const buffer = await userbotClient.downloadMedia(m, { outputFile: Buffer });
      if (!buffer || buffer.length === 0) { console.log(`[SINC] Buffer vazio msg ${m.id}`); continue; }

      const desvio = await parseDocument(buffer, mimeType);

      if (desvios[desvio.id]) { ignorados++; continue; }

      desvios[desvio.id] = desvio;
      novos++;
      console.log(`[SINC] Novo desvio importado: ${desvio.id} — ${desvio.motorista}`);
    } catch (err) {
      if (err.message === 'NÃO_RELATORIO') { console.log(`[SINC] Msg ${m.id}: não é relatório de desvio`); continue; }
      console.error(`[SINC] Erro msg ${m.id}:`, err.message);
      erros++;
    }
  }

  // Log de senders encontrados no período (ajuda a confirmar o SENDER_ID certo)
  const sendersNoGrupo = [...new Set(
    messages
      .filter(m => m.date >= limitTs && (m.media?.photo || m.media?.document))
      .map(m => String(m.senderId))
  )];
  console.log(`[SINC] Senders com mídia no período: ${sendersNoGrupo.join(', ') || 'nenhum'}`);

  await saveBackup();
  await bot.sendMessage(MY_CHAT_ID,
    `✅ *Sincronização concluída!*\n` +
    `📥 ${novos} novo(s) | ⏭ ${ignorados} já existia(m) | ❌ ${erros} erro(s)\n\n` +
    (novos > 0 ? `Use /desvios para ver a lista completa.` : `Nenhum relatório de desvio encontrado.\nVerifique o log do Railway para detalhes.`),
    { parse_mode: 'Markdown' });
}

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

      // Verifica se tem mídia (documento ou foto)
      const media = message.media;
      if (!media) return;

      const hasDoc   = !!media.document;
      const hasPhoto = !!media.photo;
      if (!hasDoc && !hasPhoto) return;

      let mimeType = 'image/jpeg';
      let fileName = 'imagem';
      if (hasDoc) {
        const doc = media.document;
        mimeType  = doc.mimeType || '';
        fileName  = doc.attributes?.find(a => a.fileName)?.fileName || 'arquivo';
        // Ignora arquivos que claramente não são relevantes (ex: vídeos)
        const isImg = mimeType.startsWith('image/');
        const isPdf = mimeType === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf');
        if (!isImg && !isPdf) return;
      }

      console.log(`[USERBOT] Mídia recebida: "${fileName}" (${mimeType}) de sender ${message.senderId}`);

      // Download
      const buffer = await client.downloadMedia(message, { outputFile: Buffer });
      if (!buffer || buffer.length === 0) {
        console.error('[USERBOT] Buffer vazio ao baixar mídia');
        return;
      }

      // Parse (PDF ou OCR de imagem)
      let desvio;
      try {
        desvio = await parseDocument(buffer, mimeType);
      } catch (err) {
        if (err.message === 'NÃO_RELATORIO') {
          console.log('[USERBOT] Imagem ignorada: não é relatório de desvio');
          return;
        }
        console.error('[USERBOT] Erro ao parsear mídia:', err.message);
        await bot.sendMessage(MY_CHAT_ID,
          `⚠️ Recebi uma imagem do grupo mas não consegui extrair os dados.\nArquivo: ${fileName}\nErro: ${err.message}`);
        return;
      }

      // Guarda o desvio
      desvios[desvio.id] = desvio;
      await saveBackup();

      // Notifica
      await notificarDesvio(desvio);

    } catch (err) {
      console.error('[USERBOT] Erro no handler:', err.message);
    }
  }, new NewMessage({}));

  console.log(`[USERBOT] Monitorando grupo "${GROUP_NAME}"...`);

  // Expõe função de sincronização retroativa
  userbotClient = client;
  userbotGroupId = targetGroupId;
}

// ─── Startup ──────────────────────────────────────────────────────────────────
(async () => {
  console.log('[BOT] Iniciando Desvios Bot...');
  loadLocalState(); // carrega /tmp (rápido, pode estar vazio após restart)

  try {
    await startUserbot(); // conecta userbot e expõe userbotClient
  } catch (err) {
    console.error('[USERBOT] Falha ao iniciar:', err.message);
  }

  // Tenta restaurar estado do histórico do Telegram (sobrevive a restarts)
  if (userbotClient && Object.keys(desvios).length === 0) {
    const restored = await restoreFromTelegram(userbotClient);
    if (!restored) {
      console.log('[BACKUP] Sem backup encontrado, iniciando do zero.');
    }
  }

  // Aguarda 8s antes de iniciar polling — evita 409 Conflict no Railway
  // (instância anterior precisa de tempo para encerrar)
  console.log('[BOT] Aguardando 8s antes de iniciar polling...');
  await new Promise(r => setTimeout(r, 8000));
  bot.startPolling({ restart: false });
  console.log('[BOT] Polling iniciado.');

  try {
    await bot.sendMessage(MY_CHAT_ID,
      `🤖 *Desvios Bot iniciado!*\n` +
      `📋 ${Object.keys(desvios).length} desvios carregados\n\n` +
      `Monitorando: _${GROUP_NAME}_\n\n` +
      `/desvios — lista completa\n` +
      `/pendentes — aguardando tratativa\n` +
      `/sincronizar 7 — importar PDFs antigos`,
      { parse_mode: 'Markdown' });
    console.log('[BOT] Pronto.');
  } catch (err) {
    console.error('[BOT] Erro na msg de startup:', err.message);
  }
})();
