const { Pool } = require('pg');

const connStr = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;

if (!connStr) {
  console.error('[DB] ERRO: DATABASE_URL não configurada! Adicione no Railway Variables.');
  process.exit(1);
}

const useSSL = !connStr.includes('railway.internal');

const pool = new Pool({
  connectionString: connStr,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
});

// Pool secundário — banco principal Ponto (cadastro_pessoas)
const neonPool = process.env.NEON_DATABASE_URL
  ? new Pool({
      connectionString: process.env.NEON_DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
      connectionTimeoutMillis: 8000,
    })
  : null;

// ─── Setup ────────────────────────────────────────────────────────────────────
async function setupDb() {
  // Cria tabelas se não existirem (setup novo — PK já é telegram_msg_id)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      telegram_msg_id BIGINT PRIMARY KEY,
      processed_at    TIMESTAMPTZ DEFAULT NOW(),
      is_desvio       BOOLEAN DEFAULT FALSE,
      desvio_id       VARCHAR(30)
    );

    CREATE TABLE IF NOT EXISTS desvios (
      telegram_msg_id     BIGINT PRIMARY KEY,
      id                  VARCHAR(30),
      evento              VARCHAR(200),
      placa               VARCHAR(30),
      motorista           VARCHAR(200),
      data_desvio         VARCHAR(20),
      horario             VARCHAR(10),
      turno               VARCHAR(20),
      reincidente         VARCHAR(10),
      primeira_ocorrencia TEXT,
      unidade             VARCHAR(150),
      supervisor          VARCHAR(150),
      descumpriu_cartilha VARCHAR(10),
      evidencia_tratativa VARCHAR(100),
      gravidade           VARCHAR(50),
      observacao          TEXT,
      descricao           TEXT,
      analise             TEXT,
      contato_realizado   VARCHAR(10),
      respondente         VARCHAR(150),
      autor               VARCHAR(150),
      data_resposta       VARCHAR(50),
      status              VARCHAR(20) DEFAULT 'PENDENTE',
      criado_em           TIMESTAMPTZ DEFAULT NOW(),
      atualizado_em       TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Migração: se tabela antiga ainda tem id como PK, converte para telegram_msg_id
  await pool.query(`
    DO $$
    DECLARE
      pk_col TEXT;
    BEGIN
      SELECT kcu.column_name INTO pk_col
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema   = kcu.table_schema
        AND tc.table_name     = kcu.table_name
      WHERE tc.table_schema = 'public'
        AND tc.table_name   = 'desvios'
        AND tc.constraint_type = 'PRIMARY KEY'
      LIMIT 1;

      IF pk_col = 'id' THEN
        RAISE NOTICE '[DB] Migrando PK de id para telegram_msg_id...';
        ALTER TABLE desvios DROP CONSTRAINT desvios_pkey;
        UPDATE desvios
        SET telegram_msg_id = (
          EXTRACT(EPOCH FROM COALESCE(criado_em, NOW()))::bigint * 1000
          + (random() * 999)::int
        )
        WHERE telegram_msg_id IS NULL;
        ALTER TABLE desvios ALTER COLUMN telegram_msg_id SET NOT NULL;
        ALTER TABLE desvios ADD CONSTRAINT desvios_pkey PRIMARY KEY (telegram_msg_id);
        RAISE NOTICE '[DB] Migracao concluida.';
      END IF;
    END $$;
  `);

  // Adiciona coluna matricula se não existir (migration incremental)
  await pool.query(`
    ALTER TABLE desvios ADD COLUMN IF NOT EXISTS matricula VARCHAR(30);
  `);

  console.log('[DB] Tabelas OK');
}

// ─── Processed messages ───────────────────────────────────────────────────────

async function isMsgProcessed(telegramMsgId) {
  const r = await pool.query(
    'SELECT telegram_msg_id FROM processed_messages WHERE telegram_msg_id = $1',
    [telegramMsgId]
  );
  return r.rowCount > 0;
}

async function markMsgProcessed(telegramMsgId, isDesvio, desvioId = null) {
  await pool.query(
    `INSERT INTO processed_messages (telegram_msg_id, is_desvio, desvio_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_msg_id) DO NOTHING`,
    [telegramMsgId, isDesvio, desvioId]
  );
}

async function clearProcessedMessages() {
  await pool.query('DELETE FROM processed_messages');
}

// ─── Desvios ──────────────────────────────────────────────────────────────────

// telegramMsgId é a PK — obrigatório
async function saveDesvio(d, telegramMsgId) {
  if (!telegramMsgId) throw new Error('saveDesvio: telegramMsgId obrigatório');

  await pool.query(
    `INSERT INTO desvios (
      telegram_msg_id, id, evento, placa, motorista, matricula, data_desvio, horario, turno,
      reincidente, primeira_ocorrencia, unidade, supervisor, descumpriu_cartilha,
      evidencia_tratativa, gravidade, observacao, descricao, analise,
      contato_realizado, respondente, autor, data_resposta, status, atualizado_em
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,NOW()
    )
    ON CONFLICT (telegram_msg_id) DO UPDATE SET
      id = EXCLUDED.id, evento = EXCLUDED.evento, placa = EXCLUDED.placa,
      motorista = EXCLUDED.motorista, matricula = EXCLUDED.matricula,
      data_desvio = EXCLUDED.data_desvio, horario = EXCLUDED.horario, turno = EXCLUDED.turno,
      reincidente = EXCLUDED.reincidente, unidade = EXCLUDED.unidade,
      supervisor = EXCLUDED.supervisor, gravidade = EXCLUDED.gravidade,
      descricao = EXCLUDED.descricao, analise = EXCLUDED.analise,
      respondente = EXCLUDED.respondente, status = EXCLUDED.status,
      atualizado_em = NOW()`,
    [
      telegramMsgId,
      d.id, d.evento, d.placa, d.motorista, d.matricula || null,
      d.dataDesvio, d.horario, d.turno,
      d.reincidente, d.primeiraOcorrencia, d.unidade, d.supervisor, d.descumpriuCartilha,
      d.evidenciaTratativa, d.gravidade, d.observacao, d.descricao, d.analise,
      d.contatoRealizado, d.respondente, d.autor, d.dataResposta, d.status,
    ]
  );
}

async function updateDesvioStatus(telegramMsgId, status) {
  await pool.query(
    'UPDATE desvios SET status = $1, atualizado_em = NOW() WHERE telegram_msg_id = $2',
    [status, telegramMsgId]
  );
}

async function clearAllDesvios() {
  await pool.query('DELETE FROM desvios');
}

async function loadAllDesvios() {
  const r = await pool.query('SELECT * FROM desvios ORDER BY criado_em DESC');
  return r.rows.map(row => ({
    telegramMsgId:      String(row.telegram_msg_id),
    id:                 row.id                  || '—',
    evento:             row.evento              || '—',
    placa:              row.placa               || '—',
    motorista:          row.motorista           || '—',
    dataDesvio:         row.data_desvio         || '—',
    horario:            row.horario             || '—',
    turno:              row.turno               || '—',
    reincidente:        row.reincidente         || '—',
    primeiraOcorrencia: row.primeira_ocorrencia || '—',
    unidade:            row.unidade             || '—',
    supervisor:         row.supervisor          || '—',
    descumpriuCartilha: row.descumpriu_cartilha || '—',
    evidenciaTratativa: row.evidencia_tratativa || '—',
    gravidade:          row.gravidade           || '—',
    observacao:         row.observacao          || '—',
    descricao:          row.descricao           || '—',
    analise:            row.analise             || '—',
    contatoRealizado:   row.contato_realizado   || '—',
    respondente:        row.respondente         || '—',
    autor:              row.autor               || '—',
    dataResposta:       row.data_resposta       || '—',
    matricula:          row.matricula           || '—',
    status:             row.status              || 'PENDENTE',
    criadoEm:           row.criado_em?.toISOString() || new Date().toISOString(),
  }));
}

// ─── Colaboradores (banco principal Ponto/Neon) ───────────────────────────────

// Remove acentos em JS para comparação sem depender de unaccent no DB
function semAcento(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

async function buscarColaborador(nome) {
  if (!neonPool) return null;
  if (!nome || nome === '—' || nome.length < 4) return null;

  const nomeNorm = semAcento(nome);

  try {
    // 1. unaccent + trgm — melhor para nomes com variação de acento (CONCEICAO vs CONCEIÇÃO)
    let r = await neonPool.query(`
      SELECT nome, documento,
             similarity(unaccent(lower(nome)), $1) AS sim
      FROM cadastro_pessoas
      WHERE similarity(unaccent(lower(nome)), $1) > 0.35
      ORDER BY sim DESC
      LIMIT 1
    `, [nomeNorm]).catch(() => null);

    if (r?.rowCount > 0) {
      const row = r.rows[0];
      const pct = Math.round((row.sim || 0) * 100);
      console.log(`[CADASTRO] trgm+unaccent "${nome}" → "${row.nome}" (${pct}%)`);
      return { nome: row.nome, documento: row.documento, confianca: pct >= 55 ? 'alta' : 'media' };
    }

    // 2. trgm sem unaccent (fallback se extensão não disponível)
    r = await neonPool.query(`
      SELECT nome, documento,
             similarity(lower(nome), lower($1)) AS sim
      FROM cadastro_pessoas
      WHERE similarity(lower(nome), lower($1)) > 0.30
      ORDER BY sim DESC
      LIMIT 1
    `, [nome]).catch(() => null);

    if (r?.rowCount > 0) {
      const row = r.rows[0];
      const pct = Math.round((row.sim || 0) * 100);
      console.log(`[CADASTRO] trgm "${nome}" → "${row.nome}" (${pct}%)`);
      return { nome: row.nome, documento: row.documento, confianca: pct >= 50 ? 'alta' : 'media' };
    }

    // 3. LIKE com 2 palavras longas consecutivas — só usa se resultado ÚNICO no banco
    //    Ex: "CONCEICAO GOMES" → só 1 pessoa → confiança média, não substitui nome
    const partes = nomeNorm.split(/\s+/).filter(p => p.length >= 5);
    for (let i = partes.length - 1; i >= 1; i--) {
      const r3 = await neonPool.query(
        `SELECT nome, documento FROM cadastro_pessoas
         WHERE unaccent(lower(nome)) LIKE $1 LIMIT 2`,
        [`%${partes[i-1]}%${partes[i]}%`]
      ).catch(() => null);

      if (r3?.rowCount === 1) {
        console.log(`[CADASTRO] LIKE único "${partes[i-1]} ${partes[i]}" → "${r3.rows[0].nome}"`);
        // Confiança baixa: traz matrícula mas NÃO substitui o nome
        return { nome: r3.rows[0].nome, documento: r3.rows[0].documento, confianca: 'baixa' };
      }
    }

    console.log(`[CADASTRO] Sem match para "${nome}"`);
    return null;
  } catch (err) {
    console.error('[CADASTRO] Erro:', err.message);
    return null;
  }
}

module.exports = {
  setupDb,
  isMsgProcessed,
  markMsgProcessed,
  clearProcessedMessages,
  saveDesvio,
  updateDesvioStatus,
  clearAllDesvios,
  loadAllDesvios,
  buscarColaborador,
};
