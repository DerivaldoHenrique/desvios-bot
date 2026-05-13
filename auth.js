/**
 * auth.js — Geração da session string do userbot (rodar UMA VEZ localmente)
 *
 * Execute: node auth.js
 * Copie a string gerada para a variável TELEGRAM_SESSION no .env / Railway
 */

require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

(async () => {
  const apiId   = parseInt(process.env.TELEGRAM_API_ID   || await ask('API ID (my.telegram.org): '));
  const apiHash =          process.env.TELEGRAM_API_HASH || await ask('API Hash: ');

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber:  async () => ask('Seu número de telefone (ex: +5511999999999): '),
    password:     async () => ask('Senha 2FA (Enter se não tiver): '),
    phoneCode:    async () => ask('Código recebido no Telegram: '),
    onError:      (err) => console.error('[AUTH] Erro:', err),
  });

  const session = client.session.save();
  console.log('\n✅ Autenticado com sucesso!\n');
  console.log('Copie a linha abaixo para TELEGRAM_SESSION no .env e no Railway:\n');
  console.log(session);
  console.log('');

  // Listar grupos para encontrar o ID do grupo monitorado
  console.log('\n📋 Seus grupos/canais (para confirmar o nome exato):');
  const dialogs = await client.getDialogs({ limit: 50 });
  for (const d of dialogs) {
    if (d.isGroup || d.isChannel) {
      console.log(`  [${d.id}] ${d.title}`);
    }
  }

  rl.close();
  process.exit(0);
})();
