const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal')
    ? false
    : { rejectUnauthorized: false },
});

// ─── Setup ────────────────────────────────────────────────────────────────────
async function setupDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      telegram_msg_id BIGINT PRIMARY KEY,
      processed_at    TIMESTAMPTZ DEFAULT NOW(),
      is_desvio       BOOLEAN DEFAULT FALSE,
      desvio_id       VARCHAR(30)
    );

    CREATE TABLE IF NOT EXISTS desvios (
      id                  VARCHAR(30) PRIMARY KEY,
      telegram_msg_id     BIGINT,
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
  console.log('[DB] Tabelas OK');
}

// ─── Processed messages ───────────────────────────────────────────────────────

// Verifica se mensagem já foi processada
async function isMsgProcessed(telegramMsgId) {
  const r = await pool.query(
    'SELECT telegram_msg_id FROM processed_messages WHERE telegram_msg_id = $1',
    [telegramMsgId]
  );
  return r.rowCount > 0;
}

// Marca mensagem como processada
async function markMsgProcessed(telegramMsgId, isDesvio, desvioId = null) {
  await pool.query(
    `INSERT INTO processed_messages (telegram_msg_id, is_desvio, desvio_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_msg_id) DO NOTHING`,
    [telegramMsgId, isDesvio, desvioId]
  );
}

// ─── Desvios ──────────────────────────────────────────────────────────────────

async function saveDesvio(d, telegramMsgId = null) {
  await pool.query(
    `INSERT INTO desvios (
      id, telegram_msg_id, evento, placa, motorista, data_desvio, horario, turno,
      reincidente, primeira_ocorrencia, unidade, supervisor, descumpriu_cartilha,
      evidencia_tratativa, gravidade, observacao, descricao, analise,
      contato_realizado, respondente, autor, data_resposta, status, atualizado_em
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      evento = EXCLUDED.evento, placa = EXCLUDED.placa, motorista = EXCLUDED.motorista,
      data_desvio = EXCLUDED.data_desvio, horario = EXCLUDED.horario, turno = EXCLUDED.turno,
      reincidente = EXCLUDED.reincidente, unidade = EXCLUDED.unidade, supervisor = EXCLUDED.supervisor,
      gravidade = EXCLUDED.gravidade, descricao = EXCLUDED.descricao, analise = EXCLUDED.analise,
      respondente = EXCLUDED.respondente, status = EXCLUDED.status, atualizado_em = NOW()`,
    [
      d.id, telegramMsgId, d.evento, d.placa, d.motorista, d.dataDesvio, d.horario, d.turno,
      d.reincidente, d.primeiraOcorrencia, d.unidade, d.supervisor, d.descumpriuCartilha,
      d.evidenciaTratativa, d.gravidade, d.observacao, d.descricao, d.analise,
      d.contatoRealizado, d.respondente, d.autor, d.dataResposta, d.status,
    ]
  );
}

async function updateDesvioStatus(id, status) {
  await pool.query(
    'UPDATE desvios SET status = $1, atualizado_em = NOW() WHERE id = $2',
    [status, id]
  );
}

async function loadAllDesvios() {
  const r = await pool.query('SELECT * FROM desvios ORDER BY criado_em DESC');
  // Converte snake_case → camelCase para compatibilidade com o resto do código
  return r.rows.map(row => ({
    id:                 row.id,
    evento:             row.evento             || '—',
    placa:              row.placa              || '—',
    motorista:          row.motorista          || '—',
    dataDesvio:         row.data_desvio        || '—',
    horario:            row.horario            || '—',
    turno:              row.turno              || '—',
    reincidente:        row.reincidente        || '—',
    primeiraOcorrencia: row.primeira_ocorrencia|| '—',
    unidade:            row.unidade            || '—',
    supervisor:         row.supervisor         || '—',
    descumpriuCartilha: row.descumpriu_cartilha|| '—',
    evidenciaTratativa: row.evidencia_tratativa|| '—',
    gravidade:          row.gravidade          || '—',
    observacao:         row.observacao         || '—',
    descricao:          row.descricao          || '—',
    analise:            row.analise            || '—',
    contatoRealizado:   row.contato_realizado  || '—',
    respondente:        row.respondente        || '—',
    autor:              row.autor              || '—',
    dataResposta:       row.data_resposta      || '—',
    status:             row.status             || 'PENDENTE',
    criadoEm:           row.criado_em?.toISOString() || new Date().toISOString(),
  }));
}

module.exports = {
  setupDb,
  isMsgProcessed,
  markMsgProcessed,
  saveDesvio,
  updateDesvioStatus,
  loadAllDesvios,
};
