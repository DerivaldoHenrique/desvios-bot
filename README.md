# Desvios Bot — Monitoramento de Relatórios via Telegram

Monitora o grupo **OPERAÇÃO QSEMST - ES - BNL**, detecta PDFs de **Diário de Bordo**,
extrai os dados do desvio e envia um resumo estruturado via @desviosbot.

## Como funciona

```
Grupo Telegram (PDF recebido)
       │
       └── Userbot (sua conta) detecta o PDF
             └── Extrai: motorista, evento, gravidade, análise...
                   └── @desviosbot → envia resumo + pergunta sobre tratativa
                         └── Você responde "sim" → status EM_TRATATIVA
```

## Setup

### 1. Obter credenciais MTProto

1. Acesse https://my.telegram.org
2. Faça login com seu número de telefone
3. Vá em **API development tools**
4. Crie um aplicativo e copie `api_id` e `api_hash`

### 2. Gerar session string (rodar UMA VEZ localmente)

```bash
cp .env.example .env
# Preencha TELEGRAM_API_ID e TELEGRAM_API_HASH no .env
npm install
npm run auth
```

Siga as instruções — você receberá um código no Telegram.
Copie a **session string** gerada para `TELEGRAM_SESSION` no .env e no Railway.

O script também lista seus grupos para confirmar o nome exato.

### 3. Obter seu Chat ID com o desviosbot

1. Abra o Telegram e inicie uma conversa com @desviosbot
2. Envie `/start`
3. Use @userinfobot para obter seu Chat ID

### 4. Configurar variáveis de ambiente

```
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=abcdef1234567890abcdef
TELEGRAM_SESSION=1BVtsOK8Bu...  (string longa gerada pelo auth.js)
TELEGRAM_GROUP_NAME=OPERAÇÃO QSEMST - ES - BNL
TELEGRAM_SENDER_ID=             (opcional: ID do contato que envia os PDFs)
DESVIOS_BOT_TOKEN=8872886328:AAHSIef18NMIMjjTO0kOc6yZ9GQmuMhqdL8
TELEGRAM_MY_CHAT_ID=seu_chat_id
```

### 5. Deploy no Railway

1. Crie um novo projeto no Railway
2. Conecte este repositório
3. Adicione todas as variáveis acima em **Variables**
4. Start command: `node index.js`

## Comandos do bot

| Comando | Ação |
|---|---|
| `/desvios` | Lista todos os desvios (pendentes, em tratativa, concluídos) |
| `/desvio DI-0001` | Detalhes completos de um desvio |
| `/pendentes` | Apenas desvios aguardando tratativa |
| `sim` | Inicia tratativa do último desvio notificado |
| `não` | Mantém como pendente |

## Fluxo de status

```
PENDENTE → EM_TRATATIVA → CONCLUIDO
```
