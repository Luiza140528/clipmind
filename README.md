# 🎬 ClipMind — Plataforma de Cortes Virais com IA

**A mente inteligente por trás do seu viral**

Transforme vídeos longos em cortes estratégicos para TikTok, Reels e YouTube Shorts. Otimizado para políticos. Powered by IA.

---

## 📋 Stack

- **Backend:** Node.js + Express
- **Database:** Supabase (PostgreSQL)
- **Storage:** Supabase Storage
- **Transcrição:** OpenAI Whisper
- **IA Análise:** Anthropic Claude Haiku
- **Edição de Vídeo:** FFmpeg + yt-dlp
- **Pagamento:** Mercado Pago
- **Hospedagem:** Railway

---

## 🚀 Quick Start

### 1. Clone o repositório

```bash
git clone https://github.com/Luiza140528/clipmind.git
cd clipmind/backend
```

### 2. Instale dependências

```bash
npm install
```

### 3. Configure variáveis de ambiente

```bash
cp .env.example .env.local
```

**Preencha com suas chaves (veja instruções abaixo)**

### 4. Setup Supabase

```bash
# 1. Acesse https://app.supabase.com
# 2. Crie um novo projeto
# 3. Na aba "SQL Editor", cole o conteúdo de schema.sql
# 4. Copie URL e chaves para .env.local
```

### 5. Execute localmente

```bash
npm run dev
```

**Backend roda em:** `http://localhost:8080`

---

## 🔑 Configurar Chaves de API

### OpenAI (Whisper)
1. Acesse https://platform.openai.com/api-keys
2. Crie uma nova API key
3. Copie para `OPENAI_API_KEY`
4. Certifique-se que tem crédito suficiente

### Anthropic (Claude)
1. Acesse https://console.anthropic.com
2. Crie uma nova API key
3. Copie para `ANTHROPIC_API_KEY`
4. Certifique-se que tem crédito suficiente

### Mercado Pago
1. Acesse https://www.mercadopago.com.br/developers
2. Copie tokens de desenvolvedor
3. Cole em `MERCADO_PAGO_ACCESS_TOKEN` e `MERCADO_PAGO_PUBLIC_KEY`

### Supabase
1. Crie projeto em https://app.supabase.com
2. Copie URL e chaves
3. Cole em `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`

---

## 📁 Estrutura de Pastas

```
clipmind/
├── backend/
│   ├── src/
│   │   └── server.js                # Express principal
│   ├── package.json                 # Dependências
│   ├── .env.example                 # Template de variáveis
│   ├── Dockerfile                   # Build pra Railway
│   └── schema.sql                   # Schema Supabase
├── frontend/
│   ├── index.html                   # Landing + app
│   ├── css/                         # Estilos
│   └── js/                          # JavaScript
└── README.md                        # Este arquivo
```

---

## 🔌 Endpoints da API

### Autenticação

**POST /api/auth/signup**
```json
{
  "email": "politico@email.com",
  "password": "senha123",
  "name": "João Silva"
}
```

**POST /api/auth/login**
```json
{
  "email": "politico@email.com",
  "password": "senha123"
}
```

### Processamento

**POST /api/process**
```json
{
  "youtube_url": "https://youtube.com/watch?v=..."
}
```

Response:
```json
{
  "job_id": "job_1234567890",
  "status": "processing"
}
```

### Listar Clips

**GET /api/clips**
- Header: `Authorization: Bearer {token}`

Response:
```json
{
  "clips": [
    {
      "id": "clip_123",
      "title": "Clip 1",
      "reason": "Promessa sobre economia",
      "appeal": "promessa",
      "duration": 30,
      "storage_url": "https://...",
      "created_at": "2026-06-15T10:30:00Z"
    }
  ]
}
```

### Verificar Status

**GET /api/process/:job_id**
- Header: `Authorization: Bearer {token}`

Response:
```json
{
  "id": "job_123",
  "status": "completed",
  "clips": [...]
}
```

---

## 📦 Deploy no Railway

### 1. Criar conta Railway

https://railway.app

### 2. Conectar GitHub

- Criar repo privado em GitHub
- Conectar a Railway
- Railway detecta Dockerfile automaticamente

### 3. Configurar variáveis

No painel Railway:
- Adicione todas as variáveis de `.env.example`
- Railway faz deploy automático

### 4. Acessar

Railway fornece URL pública automaticamente

---

## 🧪 Testar Localmente

### 1. Com curl

```bash
# Signup
curl -X POST http://localhost:8080/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"123456"}'

# Login
curl -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"123456"}'

# Processar vídeo (use token do login)
curl -X POST http://localhost:8080/api/process \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {token}" \
  -d '{"youtube_url":"https://youtube.com/watch?v=..."}'
```

### 2. Com Postman

- Importe collection (vou criar depois)
- Teste cada endpoint

---

## 🛠️ Troubleshooting

### "API key not found"
- Verifique se `.env.local` existe
- Verifique se todas as chaves estão preenchidas

### "FFmpeg not found"
- Instale FFmpeg: `brew install ffmpeg` (Mac) ou `apt-get install ffmpeg` (Linux)

### "Supabase connection failed"
- Verifique SUPABASE_URL e chaves
- Certifique-se que projeto está ativo em https://app.supabase.com

### "Whisper timeout"
- Áudio muito longo pode demorar
- Máximo ~25MB ou ~30 minutos

### "Claude API error"
- Verifique crédito em https://console.anthropic.com
- Verifique rate limits

---

## 📊 Logs

Logs são exibidos em tempo real no console:

```
[2026-06-15T10:30:00.000Z] ClipMind server running on port 8080
[2026-06-15T10:31:00.000Z] Job created: job_1234567890
[2026-06-15T10:31:10.000Z] Downloading video: https://youtube.com/...
[2026-06-15T10:31:20.000Z] Transcribing video...
[2026-06-15T10:31:30.000Z] Claude identified 5 moments
[2026-06-15T10:32:00.000Z] Clip generated: clip_1
```

---

## 🔐 Segurança

- RLS (Row Level Security) ativo no Supabase
- Tokens JWT validados em cada request
- Senhas hasheadas via Supabase Auth
- CORS configurado
- Helmet para headers de segurança

---

## 📈 Próximos Passos

- [ ] Frontend completo (upload + download)
- [ ] Integração Mercado Pago
- [ ] Landing page
- [ ] Analytics
- [ ] Dashboard
- [ ] Biblioteca com busca
- [ ] Gamificação

---

## 📞 Suporte

- Issues: https://github.com/Luiza140528/clipmind/issues
- Email: contato@clipmind.com

---

**ClipMind © 2026 — Transforme vídeos em estratégia**
