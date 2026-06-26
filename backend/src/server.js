// server.js - InovaShot Backend (MVP)
// Stack: Express + Supabase + Whisper + Claude Haiku + FFmpeg

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const logger = (message) => {
  console.log(`[${new Date().toISOString()}] ${message}`);
};

// ============================================
// MIDDLEWARE DE AUTENTICAÇÃO
// ============================================

const authenticateUser = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    const { data, error } = await supabase.auth.getUser(token);
    if (error) return res.status(401).json({ error: 'Invalid token' });
    req.user = data.user;
    next();
  } catch (error) {
    logger(`Auth error: ${error.message}`);
    res.status(500).json({ error: 'Authentication failed' });
  }
};

// ============================================
// ROTAS DE AUTENTICAÇÃO
// ============================================

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return res.status(400).json({ error: error.message });
    const { error: insertError } = await supabase.from('users').insert({
      id: data.user.id, email, name: name || '', plan: 'free', credits: 3,
    });
    if (insertError) logger(`Insert user row error: ${insertError.message}`);
    logger(`User signed up: ${email}`);
    res.status(201).json({ user_id: data.user.id, email });
  } catch (error) {
    logger(`Signup error: ${error.message}`);
    res.status(500).json({ error: 'Signup failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(400).json({ error: error.message });
    logger(`User logged in: ${email}`);
    res.json({ user_id: data.user.id, email: data.user.email, access_token: data.session.access_token });
  } catch (error) {
    logger(`Login error: ${error.message}`);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ============================================
// ROTAS DE PROCESSAMENTO
// ============================================

app.post('/api/process', authenticateUser, async (req, res) => {
  try {
    const { youtube_url, objetivo, tom, destino } = req.body;
    const user_id = req.user.id;
    const videoConfig = { objetivo, tom, destino };
    if (!youtube_url) return res.status(400).json({ error: 'YouTube URL required' });

    const { data: userData } = await supabase.from('users').select('credits, plan').eq('id', user_id).single();
    if (userData.credits <= 0) return res.status(402).json({ error: 'No credits available' });

    const job_id = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const { error: jobError } = await supabase.from('processing_jobs').insert({
      id: job_id, user_id, youtube_url, status: 'pending',
    });
    if (jobError) {
      logger(`Job creation error: ${jobError.message}`);
      return res.status(500).json({ error: 'Failed to create job' });
    }

    logger(`Job created: ${job_id} for user ${user_id}`);
    processVideoAsync(job_id, user_id, youtube_url, null, userData.plan, videoConfig);
    res.json({ job_id, status: 'processing', message: 'Seu vídeo está sendo processado.' });
  } catch (error) {
    logger(`Process error: ${error.message}`);
    res.status(500).json({ error: 'Processing failed' });
  }
});

const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 500 * 1024 * 1024 } });

app.post('/api/process/upload', authenticateUser, upload.single('video'), async (req, res) => {
  try {
    const user_id = req.user.id;
    if (!req.file) return res.status(400).json({ error: 'Video file required' });

    const { data: userData } = await supabase.from('users').select('credits, plan').eq('id', user_id).single();
    if (!userData || userData.credits <= 0) {
      fs.unlink(req.file.path, () => {});
      return res.status(402).json({ error: 'No credits available' });
    }

    const job_id = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const ext = path.extname(req.file.originalname) || '.mp4';
    const videoPath = `/tmp/${job_id}${ext}`;
    fs.renameSync(req.file.path, videoPath);

    const { error: jobError } = await supabase.from('processing_jobs').insert({
      id: job_id, user_id, youtube_url: `upload:${req.file.originalname}`, status: 'pending',
    });
    if (jobError) {
      logger(`Job creation error: ${jobError.message}`);
      return res.status(500).json({ error: 'Failed to create job' });
    }

    logger(`Upload job created: ${job_id} for user ${user_id}`);
    const videoConfig = {
      objetivo: req.body.objetivo || 'viralizar',
      tom: req.body.tom || 'dinamico',
      destino: req.body.destino || 'todos',
    };

    processVideoAsync(job_id, user_id, null, videoPath, userData.plan, videoConfig);
    res.json({ job_id, status: 'processing', message: 'Seu vídeo está sendo processado.' });
  } catch (error) {
    logger(`Upload process error: ${error.message}`);
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ============================================
// STATUS DO JOB
// ============================================

app.get('/api/jobs/:job_id', authenticateUser, async (req, res) => {
  try {
    const { job_id } = req.params;
    const { data, error } = await supabase.from('processing_jobs').select('*').eq('id', job_id).single();
    if (error) return res.status(404).json({ error: 'Job not found' });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get job status' });
  }
});

app.get('/api/clips', authenticateUser, async (req, res) => {
  try {
    const user_id = req.user.id;
    const { data, error } = await supabase.from('clips').select('*').eq('user_id', user_id).order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get clips' });
  }
});

// ============================================
// PROCESSAMENTO ASSÍNCRONO
// ============================================

async function processVideoAsync(job_id, user_id, youtube_url, existingVideoPath = null, plan = 'free', config = {}) {
  try {
    logger(`Starting processing for job ${job_id}`);
    const applyWatermark = plan === 'free';

    let videoPath;
    if (existingVideoPath) {
      videoPath = existingVideoPath;
      logger(`Using uploaded video: ${videoPath}`);
    } else {
      logger(`Downloading video: ${youtube_url}`);
      videoPath = await downloadVideo(youtube_url, job_id);
    }

    logger(`Transcribing video...`);
    const transcription = await transcribeVideo(videoPath);
    const transcript = transcription.text;
    const words = transcription.words || [];

    let videoDuration = 999;
    try {
      const { stdout } = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${videoPath}"`);
      videoDuration = parseFloat(stdout.trim());
      logger(`Video duration: ${videoDuration}s`);
    } catch (e) {
      logger(`Could not get video duration: ${e.message}`);
    }

    logger(`Analyzing moments...`);
    const moments = await analyzeWithClaude(transcript, config);

    const validMoments = moments.filter(m => m.start < videoDuration).map(m => ({
      ...m,
      start: Math.max(0, m.start),
      end: Math.min(videoDuration - 0.5, m.end),
    }));

    logger(`Valid moments: ${validMoments.length}/${moments.length}`);
    const finalMoments = validMoments.length > 0 ? validMoments : [
      { index: 1, start: 0, end: videoDuration - 0.5, reason: 'Clip completo', appeal: 'promessa', score: 5 }
    ];

    logger(`Generating clips...`);
    const clipIds = [];

    for (const moment of finalMoments) {
      const clipId = `clip_${job_id}_${moment.index}`;
      const clipWords = words.filter(w => w.start >= moment.start && w.end <= moment.end)
        .map(w => ({ ...w, start: w.start - moment.start, end: w.end - moment.start }));

      const clipPath = await generateClip(videoPath, moment.start, moment.end, moment.reason, applyWatermark, clipWords);

      logger(`Uploading clip ${clipId} to storage...`);
      let storagePath = null;
      try {
        storagePath = await uploadClipToStorage(clipPath, user_id, clipId);
      } catch (storageErr) {
        logger(`Storage upload failed: ${storageErr.message}`);
        storagePath = `${user_id}/${clipId}.mp4`;
      }

      try {
        const { error: insertError } = await supabase.from('clips').insert({
          id: clipId,
          job_id,
          user_id,
          title: `Clip - ${moment.reason || 'Clip gerado'}`,
          reason: moment.reason || 'Clip gerado',
          duration: Math.round((moment.end || 30) - (moment.start || 0)),
          storage_url: storagePath || `${user_id}/${clipId}.mp4`,
          hook_a: moment.hook_a || null,
          hook_b: moment.hook_b || null,
          virality_score: moment.score || null,
          start_time: moment.start || 0,
          end_time: moment.end || 30,
        });

        if (insertError) {
          logger(`ERROR inserting clip: ${insertError.message} | code: ${insertError.code}`);
        } else {
          logger(`✅ Clip saved: ${clipId}`);
        }
      } catch (insertEx) {
        logger(`EXCEPTION inserting clip: ${insertEx.message}`);
      }

      clipIds.push(clipId);
      if (fs.existsSync(clipPath)) fs.unlinkSync(clipPath);
    }

    await supabase.from('processing_jobs').update({ status: 'completed' }).eq('id', job_id);
    await supabase.rpc('decrement_credits', { user_id, amount: clipIds.length });
    logger(`Job ${job_id} completed with ${clipIds.length} clips`);
    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);

  } catch (error) {
    logger(`ERROR in processVideoAsync: ${error.message}`);
    await supabase.from('processing_jobs').update({ status: 'failed', error_message: error.message }).eq('id', job_id);
  }
}

// ============================================
// DOWNLOAD VIA YTSTREAM API (CORRIGIDO)
// ============================================

async function downloadVideo(url, job_id) {
  const outputPath = `/tmp/${job_id}.mp4`;

  try {
    logger(`Iniciando download via YTStream API: ${url}`);

    // Extrair video ID do URL
    let videoId = url;
    const matchWatch = url.match(/[?&]v=([^&]+)/);
    const matchShort = url.match(/youtu\.be\/([^?&]+)/);
    const matchShorts = url.match(/shorts\/([^?&]+)/);
    if (matchWatch) videoId = matchWatch[1];
    else if (matchShort) videoId = matchShort[1];
    else if (matchShorts) videoId = matchShorts[1];

    logger(`Video ID extraído: ${videoId}`);

    // Buscar link de download via YTStream
    const response = await axios.get('https://ytstream-download-youtube-videos.p.rapidapi.com/dl', {
      params: { id: videoId },
      headers: {
        'x-rapidapi-host': 'ytstream-download-youtube-videos.p.rapidapi.com',
        'x-rapidapi-key': process.env.RAPIDAPI_KEY,
      },
      timeout: 30000,
    });

    if (!response.data || !response.data.formats) {
      throw new Error('YTStream não retornou formatos');
    }

    const formats = response.data.formats;
    logger(`Formatos disponíveis: ${Object.keys(formats).join(', ')}`);

    // Prioridade de qualidade: 360p → 480p → 720p
    let downloadUrl = null;
    const priority = ['18', '134', '135', '136', '22'];
    for (const itag of priority) {
      if (formats[itag] && formats[itag].url) {
        downloadUrl = formats[itag].url;
        logger(`Usando formato itag ${itag}`);
        break;
      }
    }

    if (!downloadUrl) {
      const firstVideo = Object.values(formats).find(f => f.url && f.mimeType?.includes('video'));
      if (firstVideo) {
        downloadUrl = firstVideo.url;
        logger(`Usando primeiro formato disponível`);
      }
    }

    if (!downloadUrl) throw new Error('Nenhum formato de vídeo encontrado');

    logger(`Baixando arquivo...`);
    const videoResponse = await axios({
      method: 'GET',
      url: downloadUrl,
      responseType: 'stream',
      timeout: 300000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });

    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(outputPath);
      videoResponse.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) {
      throw new Error('Arquivo de vídeo inválido ou vazio');
    }

    logger(`✅ Download concluído: ${outputPath} (${fs.statSync(outputPath).size} bytes)`);
    return outputPath;

  } catch (error) {
    logger(`Erro no download: ${error.message}`);
    if (fs.existsSync(outputPath)) try { fs.unlinkSync(outputPath); } catch (_) {}
    throw new Error(`Falha no download: ${error.message}`);
  }
}

// ============================================
// TRANSCRIÇÃO COM WHISPER
// ============================================

async function transcribeVideo(videoPath) {
  const audioPath = `${videoPath}_audio.mp3`;
  let filePath = videoPath;

  try {
    await execAsync(`ffmpeg -i "${videoPath}" -vn -acodec libmp3lame -q:a 4 "${audioPath}" -y`, { timeout: 120000 });
    if (fs.existsSync(audioPath)) {
      filePath = audioPath;
      logger(`Audio extracted: ${audioPath}`);
    }
  } catch (err) {
    logger(`Audio extraction failed: ${err.message}`);
    filePath = videoPath;
  }

  try {
    const FormDataLib = require('form-data');
    const form = new FormDataLib();
    form.append('file', fs.createReadStream(filePath), {
      filename: filePath.endsWith('.mp3') ? 'audio.mp3' : 'audio.mp4',
      contentType: filePath.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4',
    });
    form.append('model', 'whisper-1');
    form.append('language', 'pt');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');

    const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    logger(`Transcrição: ${response.data.text.substring(0, 100)}...`);
    return { text: response.data.text, words: response.data.words || [] };
  } catch (error) {
    const detail = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    logger(`Transcription error: ${detail}`);
    throw new Error('Failed to transcribe video');
  } finally {
    if (fs.existsSync(audioPath)) try { fs.unlinkSync(audioPath); } catch (_) {}
  }
}

// ============================================
// ANÁLISE COM CLAUDE HAIKU
// ============================================

async function analyzeWithClaude(transcript, config = {}) {
  const { objetivo = 'viralizar', tom = 'dinamico', destino = 'todos' } = config;

  const objetivoMap = {
    viralizar: 'maximizar viralização e engajamento',
    proposta: 'destacar propostas e posicionamentos políticos',
    rebater: 'encontrar os melhores argumentos de defesa e contra-ataque',
    bastidores: 'mostrar autenticidade e humanidade do candidato',
    debate: 'destacar os momentos mais fortes do debate',
    educar: 'transmitir informação de forma clara e memorável',
  };

  const tomMap = {
    dinamico: 'energético, rápido e impactante',
    serio: 'sóbrio, institucional e confiável',
    crise: 'urgente, direto e sem rodeios',
    engracado: 'leve, com humor e descontração',
    emocional: 'emotivo, inspirador e que toca o coração',
  };

  const destinoMap = {
    tiktok: 'TikTok (público jovem, 15-60s)',
    reels: 'Instagram Reels (público 25-40)',
    shorts: 'YouTube Shorts (público amplo)',
    facebook: 'Facebook (público 40+)',
    todos: 'todas as plataformas',
  };

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const prompt = `Você é um especialista em comunicação e viralização de conteúdo para redes sociais.

CONFIGURAÇÃO:
- Objetivo: ${objetivoMap[objetivo] || objetivo}
- Tom: ${tomMap[tom] || tom}
- Destino: ${destinoMap[destino] || destino}

Transcrição:
"""
${transcript}
"""

Identifique os 5-7 MELHORES momentos para cortar em clipes virais de 15-60 segundos.

Retorne APENAS JSON válido (sem markdown):
{
  "moments": [
    {
      "index": 1,
      "start": 45,
      "end": 75,
      "reason": "Motivo do corte",
      "appeal": "promessa",
      "score": 8,
      "hook_a": "Gancho versão A (máx 15 palavras)",
      "hook_b": "Gancho versão B (máx 15 palavras)"
    }
  ]
}`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    let responseText = message.content[0].text.trim();
    if (responseText.startsWith('```')) {
      responseText = responseText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(responseText);
    logger(`Claude identificou ${parsed.moments.length} momentos`);
    return parsed.moments || [];
  } catch (error) {
    logger(`Claude analysis error: ${error.message}`);
    return [{ index: 1, start: 0, end: 999, reason: 'Momento completo', appeal: 'promessa', score: 5 }];
  }
}

// ============================================
// GERAÇÃO DE CLIPES COM FFMPEG
// ============================================

async function generateClip(videoPath, startSeconds, endSeconds, reason, applyWatermark = false, words = []) {
  const clipPath = `/tmp/clip_${Date.now()}.mp4`;
  const duration = endSeconds - startSeconds;

  try {
    const ffmpegCmd = `ffmpeg -ss ${startSeconds} -i "${videoPath}" -t ${duration} -c:v libx264 -preset ultrafast -c:a aac -movflags +faststart "${clipPath}" -y`;
    await execAsync(ffmpegCmd, { timeout: 120000 });

    if (!fs.existsSync(clipPath)) throw new Error('Clip não foi gerado');
    logger(`Clip gerado: ${clipPath}`);
    return clipPath;
  } catch (error) {
    logger(`FFmpeg error: ${error.message}`);
    throw new Error(`Falha ao gerar clip: ${error.message}`);
  }
}

// ============================================
// UPLOAD PARA SUPABASE STORAGE
// ============================================

async function uploadClipToStorage(clipPath, user_id, clipId) {
  const fileBuffer = fs.readFileSync(clipPath);
  const storagePath = `${user_id}/${clipId}.mp4`;

  const { error } = await supabase.storage.from('clips').upload(storagePath, fileBuffer, {
    contentType: 'video/mp4',
    upsert: true,
  });

  if (error) throw new Error(`Storage upload error: ${error.message}`);
  logger(`✅ Upload para storage: ${storagePath}`);
  return storagePath;
}

// ============================================
// PAGAMENTOS - MERCADO PAGO
// ============================================

app.post('/api/pagamento/checkout', authenticateUser, async (req, res) => {
  try {
    const { plano } = req.body;
    const user_id = req.user.id;

    const planos = {
      starter: { valor: 4990, nome: 'InovaShot Starter', credits: 30 },
      pro: { valor: 9790, nome: 'InovaShot Pro', credits: 100 },
      elite: { valor: 19790, nome: 'InovaShot Elite', credits: 999 },
    };

    const planoSelecionado = planos[plano];
    if (!planoSelecionado) return res.status(400).json({ error: 'Plano inválido' });

    const mpRes = await axios.post('https://api.mercadopago.com/v1/preferences', {
      items: [{ title: planoSelecionado.nome, quantity: 1, unit_price: planoSelecionado.valor / 100, currency_id: 'BRL' }],
      external_reference: `${user_id}|${plano}`,
      back_urls: {
        success: `${process.env.BASE_URL || 'https://inovashot.com.br'}/app.html?pagamento=sucesso`,
        failure: `${process.env.BASE_URL || 'https://inovashot.com.br'}/app.html?pagamento=falha`,
      },
      auto_approve: true,
    }, {
      headers: { Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}` },
    });

    res.json({ checkout_url: mpRes.data.init_point });
  } catch (error) {
    logger(`Checkout error: ${error.message}`);
    res.status(500).json({ error: 'Falha ao criar checkout' });
  }
});

app.post('/api/pagamento/webhook', async (req, res) => {
  try {
    const { type, data } = req.body;
    if (type === 'payment' && data?.id) {
      const mpRes = await axios.get(`https://api.mercadopago.com/v1/payments/${data.id}`, {
        headers: { Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}` },
      });

      const payment = mpRes.data;
      if (payment.status === 'approved') {
        const [user_id, plano] = payment.external_reference.split('|');
        const creditsMap = { starter: 30, pro: 100, elite: 999 };
        const credits = creditsMap[plano] || 30;

        await supabase.from('users').update({ plan: plano, credits }).eq('id', user_id);
        logger(`✅ Pagamento aprovado: user ${user_id} → plano ${plano}`);
      }
    }
    res.sendStatus(200);
  } catch (error) {
    logger(`Webhook error: ${error.message}`);
    res.sendStatus(500);
  }
});

// ============================================
// HEALTH CHECK
// ============================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date(), uptime: process.uptime() });
});

app.get('/', (req, res) => {
  res.json({ service: 'InovaShot API', status: 'running', version: '1.0.0' });
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  logger(`InovaShot server running on port ${PORT}`);
  logger(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
