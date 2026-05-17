require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession }  = require('telegram/sessions');
const { NewMessage }     = require('telegram/events');
const TelegramBot        = require('node-telegram-bot-api');
const Anthropic          = require('@anthropic-ai/sdk');
const pdfParse           = require('pdf-parse');
const fs                 = require('fs');
const db                 = require('./db');

// ─── Config ───────────────────────────────────────────────────────────────────
const API_ID        = parseInt(process.env.TELEGRAM_API_ID);
const API_HASH      = process.env.TELEGRAM_API_HASH;
const SESSION_STR   = process.env.TELEGRAM_SESSION || '';
const GROUP_NAME    = process.env.TELEGRAM_GROUP_NAME || 'OPERAÇÃO QSEMST - ES - BNL';
const SENDER_ID     = process.env.TELEGRAM_SENDER_ID ? parseInt(process.env.TELEGRAM_SENDER_ID) : null;
const BOT_TOKEN     = process.env.DESVIOS_BOT_TOKEN;
const MY_CHAT_ID    = process.env.TELEGRAM_MY_CHAT_ID;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── State (em memória, fonte da verdade = PostgreSQL) ────────────────────────
// Chave = telegramMsgId (string) — único por mensagem, sem colisões de ID DI-XXXX
let desvios     = {};   // { [telegramMsgId]: DesvioRecord }
let pendingAcao = null; // { desvioKey: telegramMsgId, aguardando: 'confirmacao' }

async function reloadDesvios() {
  const rows = await db.loadAllDesvios();
  desvios = {};
  for (const d of rows) desvios[d.telegramMsgId] = d;
  console.log(`[DB] ${rows.length} desvios carregados`);
}

async function persistirDesvio(desvio, telegramMsgId) {
  if (!telegramMsgId) throw new Error('persistirDesvio: telegramMsgId obrigatório');
  const key = String(telegramMsgId);
  desvios[key] = { ...desvio, telegramMsgId: key };
  await db.saveDesvio(desvio, telegramMsgId);
  await db.markMsgProcessed(telegramMsgId, true, desvio.id);
}

// ─── Bot ──────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ─── Claude Vision: extrai campos do relatório ────────────────────────────────
async function parseComClaude(buffer, mimeType) {
  const base64    = buffer.toString('base64');
  const mediaType = (mimeType && mimeType.startsWith('image/')) ? mimeType : 'image/jpeg';

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 },
        },
        {
          type: 'text',
          text: `Analise esta imagem de um relatório "DIÁRIO DE BORDO" de desvio operacional de empresa de transporte.

A tabela tem duas colunas: PERGUNTAS (coluna esquerda, fundo escuro) e RESPOSTA (coluna direita, fundo claro).
Leia SOMENTE a coluna RESPOSTA. Nunca copie texto da coluna PERGUNTAS.

VALORES DE REFERÊNCIA conhecidos desta empresa (use para corrigir leituras próximas):
- Unidade: "SEACREST ES" (não SEACHERS, SEACRES, SEACRESTS, etc.)
- Supervisor: "DERIVALDO" (não DERRIVALDO, DERIVADOR, DERRIVAL, etc.)
- Turno: "NOTURNO" ou "DIURNO"
- Reincidente: "SIM" ou "NÃO"

Retorne SOMENTE JSON válido, sem markdown, sem comentários:

{
  "id": "string no canto superior direito após 'Identificação:' — ex: DI-0001 — copie todos os dígitos",
  "evento": "RESPOSTA do item 1 — tipo do desvio (ex: FADIGA, DISTRAÇÃO, SONOLÊNCIA, AJUDANTE DORMINDO)",
  "placa": "RESPOSTA do item 2 — placa exata (ex: 12118-THY9D46)",
  "motorista": "RESPOSTA do item 3 — nome completo do motorista ou ajudante",
  "dataDesvio": "RESPOSTA do item 4 — formato YYYY-MM-DD",
  "horario": "RESPOSTA do item 5 — formato HH:MM",
  "turno": "RESPOSTA do item 6 — NOTURNO ou DIURNO",
  "reincidente": "RESPOSTA do item 7 — SIM ou NÃO",
  "primeiraOcorrencia": "RESPOSTA do item 8 se visível, senão null",
  "unidade": "RESPOSTA do item 9 — use valor de referência se próximo",
  "supervisor": "RESPOSTA do item 10 — use valor de referência se próximo",
  "descumpriuCartilha": "RESPOSTA do item 11 — SIM ou NÃO",
  "evidenciaTratativa": "RESPOSTA do item 12",
  "gravidade": "RESPOSTA do item 13 — LEVE, MÉDIA, ALTA, GRAVE, GRAVÍSSIMA ou CRÍTICA",
  "observacao": "RESPOSTA do item 14 — texto completo",
  "descricao": "RESPOSTA do item 15 — descrição do evento, texto completo",
  "analise": "RESPOSTA do item 16 — análise completa, copie fielmente sem resumir",
  "contatoRealizado": "RESPOSTA do item 21 se visível — SIM ou NÃO",
  "respondente": "valor do campo Respondente no cabeçalho",
  "autor": "valor do campo Autor no cabeçalho",
  "dataResposta": "valor do campo Data de Resposta no cabeçalho — ex: 11/05/2026, 15:54"
}

REGRAS:
- Leia caractere por caractere o nome do motorista — não invente nem complete
- Se a imagem não for um Diário de Bordo, retorne: {"id":null,"motorista":null,"evento":null}
- Campos não visíveis: use null`,
        },
      ],
    }],
  });

  const text = response.content[0].text.trim();
  // Remove possíveis blocos markdown
  const clean = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();

  // Se Claude não retornou JSON (ex: "Não é um relatório de desvio")
  if (!clean.startsWith('{')) {
    console.log('[CLAUDE] Resposta não-JSON:', clean.slice(0, 80));
    throw new Error('NÃO_RELATORIO');
  }

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

// ─── Normaliza campos com valores conhecidos ──────────────────────────────────
// Distância de Levenshtein simples para detectar erros de OCR
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

// Corrige valor para o mais próximo de uma lista de valores conhecidos
// Só substitui se a distância for pequena (≤ maxDist) e o valor correto for bem mais próximo
function corrigirParaConhecido(valor, conhecidos, maxDist = 3) {
  if (!valor) return valor;
  const upper = valor.trim().toUpperCase();
  let melhor = null, melhorDist = Infinity;
  for (const c of conhecidos) {
    const d = levenshtein(upper, c.toUpperCase());
    if (d < melhorDist) { melhorDist = d; melhor = c; }
  }
  if (melhorDist <= maxDist && melhorDist > 0) {
    console.log(`[NORM] "${valor}" → "${melhor}" (dist=${melhorDist})`);
    return melhor;
  }
  return valor;
}

const UNIDADES_CONHECIDAS = [
  'SEACREST ES',
];

const SUPERVISORES_CONHECIDOS = [
  'DERIVALDO',
];

function normalizarCampos(campos) {
  const c = { ...campos };

  // Unidade — corrige erros próximos
  if (c.unidade) {
    c.unidade = corrigirParaConhecido(c.unidade, UNIDADES_CONHECIDAS, 4);
  }

  // Supervisor — corrige erros de digitação/OCR
  if (c.supervisor) {
    // Remove duplicatas de letras comuns em erros OCR (ex: DERRIVALDO → DERIVALDO)
    const limpo = c.supervisor.trim().toUpperCase();
    c.supervisor = corrigirParaConhecido(limpo, SUPERVISORES_CONHECIDOS, 4);
  }

  // Turno — normaliza
  if (c.turno) {
    const t = c.turno.trim().toUpperCase();
    if (t.includes('NOTU')) c.turno = 'NOTURNO';
    else if (t.includes('DIU')) c.turno = 'DIURNO';
  }

  // SIM/NÃO — normaliza variações
  for (const key of ['reincidente', 'descumpriuCartilha', 'contatoRealizado']) {
    if (!c[key]) continue;
    const v = c[key].trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (v === 'SIM' || v === 'S' || v === 'YES') c[key] = 'SIM';
    else if (v === 'NAO' || v === 'N' || v === 'NO' || v === 'NÃO') c[key] = 'NÃO';
  }

  // Gravidade — normaliza variações
  if (c.gravidade) {
    const g = c.gravidade.trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const gravidades = ['GRAVISSIMA', 'CRITICA', 'GRAVE', 'ALTA', 'MEDIA', 'MODERADA', 'LEVE', 'BAIXA'];
    const map = { GRAVISSIMA: 'GRAVÍSSIMA', CRITICA: 'CRÍTICA', MEDIA: 'MÉDIA' };
    const match = gravidades.find(gr => g.includes(gr));
    if (match) c.gravidade = map[match] || match;
  }

  return c;
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
  const id = (campos.id && /DI-[\dA-Z]+/i.test(campos.id))
    ? campos.id.toUpperCase().trim()
    : `DI-${Date.now().toString().slice(-6)}`;

  // Se evento veio como "EVENTO 1" (cabeçalho da coluna), usa descrição como fallback
  const eventoRaw = campos.evento || '';
  const evento = /^EVENTO\s*\d*$/i.test(eventoRaw.trim())
    ? (campos.descricao || '—')
    : (eventoRaw || campos.descricao || '—');

  return {
    id,
    evento,
    placa:               campos.placa               || '—',
    motorista:           campos.motorista            || '—',
    dataDesvio:          campos.dataDesvio           || '—',
    horario:             campos.horario              || '—',
    turno:               campos.turno                || '—',
    reincidente:         campos.reincidente          || '—',
    primeiraOcorrencia:  campos.primeiraOcorrencia   || '—',
    unidade:             campos.unidade              || '—',
    supervisor:          campos.supervisor           || '—',
    descumpriuCartilha:  campos.descumpriuCartilha   || '—',
    evidenciaTratativa:  campos.evidenciaTratativa   || '—',
    gravidade:           campos.gravidade            || '—',
    observacao:          campos.observacao           || '—',
    descricao:           campos.descricao            || '—',
    analise:             campos.analise              || '—',
    contatoRealizado:    campos.contatoRealizado      || '—',
    respondente:         campos.respondente          || '—',
    autor:               campos.autor                || '—',
    dataResposta:        campos.dataResposta         || '—',
    status:              'PENDENTE',
    criadoEm:            new Date().toISOString(),
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

  return montarDesvio(normalizarCampos(campos));
}

// ─── Emojis ───────────────────────────────────────────────────────────────────
function gravidadeEmoji(g) {
  const l = (g || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (l.includes('gravissima') || l.includes('critica'))  return '🔴';
  if (l.includes('grave') || l.includes('alta'))          return '🟠';
  if (l.includes('media') || l.includes('moderada'))      return '🟡';
  if (l.includes('leve') || l.includes('baixa'))          return '🟢';
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
  const gEmoji     = gravidadeEmoji(d.gravidade);
  const reinc      = (d.reincidente || '').toUpperCase();
  const reincAviso = reinc === 'SIM' ? '⚠️ *REINCIDENTE*\n' : '';

  const dataHora = [
    d.dataDesvio !== '—' ? d.dataDesvio : null,
    d.horario    !== '—' ? `às ${d.horario}` : null,
    d.turno      !== '—' ? `(${d.turno})` : null,
  ].filter(Boolean).join(' ');

  let msg =
    `🚨 *Desvio ${d.id}* ${statusEmoji(d.status)}\n` +
    reincAviso + `\n` +
    campo('👤 *Motorista:*',  d.motorista) +
    campo('🚛 *Placa:*',      d.placa) +
    (dataHora ? `📅 *Data/Hora:* ${dataHora}\n` : '') +
    campo('📍 *Unidade:*',    d.unidade) +
    campo('👔 *Supervisor:*', d.supervisor) +
    `\n` +
    campo('⚡ *Evento:*', d.evento) +
    (d.gravidade !== '—' ? `${gEmoji} *Gravidade:* ${d.gravidade}\n` : '');

  if (d.descricao && d.descricao !== '—' && d.descricao !== d.evento) {
    msg += `\n📝 *Descrição:* ${d.descricao}\n`;
  }

  if (completo) {
    if (d.analise && d.analise !== '—') {
      msg += `\n📊 *Análise:*\n${d.analise.slice(0, 700)}\n`;
    }
    if (d.observacao && d.observacao !== '—' && d.observacao !== 'N/A') {
      msg += `\n💬 *Observação:* ${d.observacao}\n`;
    }

    // Campos de auditoria
    const auditoria = [
      d.descumpriuCartilha !== '—' ? `📋 Descumpriu cartilha: ${d.descumpriuCartilha}` : null,
      d.evidenciaTratativa !== '—' ? `📎 Evidência tratativa: ${d.evidenciaTratativa}` : null,
      d.contatoRealizado   !== '—' ? `📞 Contato realizado: ${d.contatoRealizado}` : null,
    ].filter(Boolean);
    if (auditoria.length) msg += `\n${auditoria.join('\n')}\n`;

    if (d.respondente && d.respondente !== '—') {
      msg += `\n📋 *Respondente:* ${d.respondente}\n`;
      if (d.autor && d.autor !== '—') msg += `✍️ *Autor:* ${d.autor}\n`;
      msg += campo('🕐 *Data Resposta:*', d.dataResposta);
    }
  }

  msg += `\n─────────────────\n📌 *Status:* ${d.status}`;

  if (d.status === 'PENDENTE' && !completo) {
    msg += `\n\nDigite *sim* para iniciar tratativa ou *não* para ignorar.`;
  }

  return msg;
}

// ─── Notifica novo desvio ─────────────────────────────────────────────────────
async function notificarDesvio(desvio) {
  pendingAcao = { desvioKey: desvio.telegramMsgId, aguardando: 'confirmacao' };
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
    const list = Object.values(desvios).sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || ''));
    if (list.length === 0) { await bot.sendMessage(MY_CHAT_ID, '✅ Nenhum desvio registrado.'); return; }

    const pendentes   = list.filter(d => d.status === 'PENDENTE');
    const tratativas  = list.filter(d => d.status === 'EM_TRATATIVA');
    const concluidos  = list.filter(d => d.status === 'CONCLUIDO');

    // Cabeçalho resumido
    await bot.sendMessage(MY_CHAT_ID,
      `📋 *Desvios — ${list.length} total*\n` +
      `🔴 Pendentes: ${pendentes.length} · 🟡 Em Tratativa: ${tratativas.length} · ✅ Concluídos: ${concluidos.length}`,
      { parse_mode: 'Markdown' });

    // Envia card completo para cada pendente (até 10)
    for (const d of pendentes.slice(0, 10)) {
      await bot.sendMessage(MY_CHAT_ID, formatResumo(d, true), { parse_mode: 'Markdown' });
    }

    // Em tratativa: card sem análise
    if (tratativas.length) {
      for (const d of tratativas) {
        await bot.sendMessage(MY_CHAT_ID, formatResumo(d, false), { parse_mode: 'Markdown' });
      }
    }

    // Concluídos: só lista compacta
    if (concluidos.length) {
      const linhas = concluidos.slice(-5).map(d =>
        `✅ \`${d.id}\` ${d.motorista !== '—' ? d.motorista : '—'} | ${d.dataDesvio}`
      );
      await bot.sendMessage(MY_CHAT_ID, `*Concluídos recentes:*\n${linhas.join('\n')}`, { parse_mode: 'Markdown' });
    }
    return;
  }

  // ── /desvio ID ──────────────────────────────────────────────────────────────
  const desvioCmd = text.match(/^\/desvio\s+([A-Z]{2}-[\dA-Z]+)/i);
  if (desvioCmd) {
    const id = desvioCmd[1].toUpperCase();
    // Busca por id (pode haver múltiplos com mesmo DI-XXXX em datas diferentes)
    const matches = Object.values(desvios)
      .filter(d => (d.id || '').toUpperCase() === id)
      .sort((a, b) => (b.dataDesvio || '').localeCompare(a.dataDesvio || ''));
    if (matches.length === 0) {
      await bot.sendMessage(MY_CHAT_ID, `❌ \`${id}\` não encontrado.`, { parse_mode: 'Markdown' });
      return;
    }
    for (const d of matches) {
      await bot.sendMessage(MY_CHAT_ID, formatResumo(d, true), { parse_mode: 'Markdown' });
    }
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

  // ── /sincronizar [dias] [force] ────────────────────────────────────────────
  const sincMatch = text.match(/^\/sincronizar(?:\s+(\d+))?(?:\s+(force))?$/i);
  if (sincMatch) {
    const dias  = parseInt(sincMatch[1] || '7');
    const force = !!(sincMatch[2]);
    await bot.sendMessage(MY_CHAT_ID,
      `🔄 Buscando relatórios dos últimos *${dias} dias*${force ? ' (force)' : ''}...`,
      { parse_mode: 'Markdown' });
    sincronizarGrupo(dias, force).catch(err => bot.sendMessage(MY_CHAT_ID, `❌ Erro: ${err.message}`));
    return;
  }

  // ── /resincronizar [dias] — limpa tudo e reimporta ──────────────────────────
  const resincMatch = text.match(/^\/resincronizar(?:\s+(\d+))?$/i);
  if (resincMatch) {
    const dias = parseInt(resincMatch[1] || '30');
    await bot.sendMessage(MY_CHAT_ID,
      `🗑 Limpando dados antigos e reimportando últimos *${dias} dias*...`,
      { parse_mode: 'Markdown' });
    try {
      await db.clearAllDesvios();
      await db.clearProcessedMessages();
      desvios = {};
      await sincronizarGrupo(dias, true);
    } catch (err) {
      await bot.sendMessage(MY_CHAT_ID, `❌ Erro: ${err.message}`);
    }
    return;
  }

  // ── Confirmação de tratativa ────────────────────────────────────────────────
  if (pendingAcao?.aguardando === 'confirmacao') {
    const lower = text.toLowerCase();
    const key   = pendingAcao.desvioKey;
    const d     = desvios[key];
    const label = d ? d.id : key;

    if (lower === 'sim' || lower === 's') {
      if (d) {
        d.status = 'EM_TRATATIVA';
        await db.updateDesvioStatus(key, 'EM_TRATATIVA');
      }
      await bot.sendMessage(MY_CHAT_ID,
        `✅ Desvio \`${label}\` → *EM TRATATIVA*\n📧 Em breve: envio automático de e-mail.`,
        { parse_mode: 'Markdown' });
      pendingAcao = null;
      return;
    }
    if (lower === 'não' || lower === 'nao' || lower === 'n') {
      await bot.sendMessage(MY_CHAT_ID, `⏭ \`${label}\` mantido como PENDENTE.`, { parse_mode: 'Markdown' });
      pendingAcao = null;
      return;
    }
  }

  // ── Help ────────────────────────────────────────────────────────────────────
  await bot.sendMessage(MY_CHAT_ID,
    `*Desvios Bot*\n\n` +
    `Comandos:\n` +
    `/desvios — lista completa\n` +
    `/desvio DI-0001 — detalhes (todas as ocorrências)\n` +
    `/pendentes — aguardando tratativa\n` +
    `/sincronizar 7 — importar últimos N dias\n` +
    `/sincronizar 7 force — reimporta mesmo já vistos\n` +
    `/resincronizar 30 — limpa tudo e reimporta do zero\n\n` +
    `DD/MM/AAAA — desvios de uma data\n\n` +
    `Quando um relatório chegar, responda *sim* ou *não*.`,
    { parse_mode: 'Markdown' });
});

// ─── Referências globais ao userbot ──────────────────────────────────────────
let userbotClient  = null;
let userbotGroupId = null;

// ─── Sincronização retroativa ─────────────────────────────────────────────────
async function sincronizarGrupo(dias = 7, force = false) {
  if (!userbotClient || !userbotGroupId) {
    await bot.sendMessage(MY_CHAT_ID, '❌ Userbot não conectado.');
    return;
  }

  const limitTs = Math.floor((Date.now() - dias * 86400000) / 1000);
  let novos = 0, ignorados = 0, jaVisto = 0, erros = 0;

  const messages = await userbotClient.getMessages(userbotGroupId, { limit: 400 });
  const candidatos = messages.filter(m => {
    if (m.date < limitTs) return false;
    if (SENDER_ID && Number(m.senderId) !== SENDER_ID) return false;
    return !!(m.media?.photo || m.media?.document);
  });

  console.log(`[SINC] ${candidatos.length} mensagens com mídia do sender no período`);

  for (const m of candidatos) {
    // ── SKIP se já processado — a menos que force=true ───────────────────────
    if (!force && await db.isMsgProcessed(m.id)) { jaVisto++; continue; }

    const doc    = m.media?.document;
    let mimeType = 'image/jpeg';

    if (doc) {
      mimeType = doc.mimeType || '';
      const fn = doc.attributes?.find(a => a.fileName)?.fileName || '';
      const isPdf = mimeType === 'application/pdf' || fn.toLowerCase().endsWith('.pdf');
      const isImg = mimeType.startsWith('image/');
      if (!isPdf && !isImg) {
        // Marca como processado para nunca mais verificar (é vídeo, etc.)
        await db.markMsgProcessed(m.id, false);
        continue;
      }
    }

    try {
      const buffer = await userbotClient.downloadMedia(m, {});
      if (!buffer || buffer.length === 0) { await db.markMsgProcessed(m.id, false); continue; }

      const desvio = await processarMidia(buffer, mimeType, 'SINC');

      if (!desvio) {
        // Não é relatório — marca para nunca mais chamar Claude nessa imagem
        await db.markMsgProcessed(m.id, false);
        ignorados++;
        continue;
      }

      await persistirDesvio(desvio, m.id);
      novos++;
      console.log(`[SINC] Importado: ${desvio.id} — ${desvio.motorista}`);
    } catch (err) {
      console.error(`[SINC] Erro msg ${m.id}:`, err.message);
      erros++;
    }
  }
  await reloadDesvios();
  await bot.sendMessage(MY_CHAT_ID,
    `✅ *Sincronização concluída!*\n` +
    `📥 ${novos} novo(s) | ⏭ ${jaVisto} já vistos (sem custo) | 🚫 ${ignorados} ignorados | ❌ ${erros} erro(s)\n\n` +
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

      // Skip se já processado
      if (await db.isMsgProcessed(message.id)) {
        console.log(`[USERBOT] Msg ${message.id} já processada, ignorando.`);
        return;
      }

      const desvio = await processarMidia(buffer, mimeType, 'USERBOT');

      if (!desvio) {
        await db.markMsgProcessed(message.id, false);
        return;
      }

      await persistirDesvio(desvio, message.id);
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

  // Banco de dados
  await db.setupDb();
  await reloadDesvios();

  try {
    await startUserbot();
  } catch (err) {
    console.error('[USERBOT] Falha:', err.message);
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
