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
// AUTENTICAÇÃO
// ============================================

const authenticateUser = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: 'Invalid token' });
    req.user = data.user;
    next();
  } catch (error) {
    res.status(500).json({ error: 'Authentication failed' });
  }
};

// ============================================
// AUTH ROUTES
// ============================================

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return res.status(400).json({ error: error.message });

    await supabase.from('users').insert({
      id: data.user.id,
      email,
      name: name || '',
      plan: 'free',
      credits: 3,
    });

    res.status(201).json({ user_id: data.user.id, email });
  } catch (error) {
    res.status(500).json({ error: 'Signup failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(400).json({ error: error.message });

    res.json({
      user_id: data.user.id,
      email: data.user.email,
      access_token: data.session.access_token,
    });
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// ============================================
// USER ME
// ============================================

app.get('/api/user/me', authenticateUser, async (req, res) => {
  try {
    const user_id = req.user.id;

    const { data: userData, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', user_id)
      .single();

    if (error || !userData) {
      return res.status(404).json({ error: 'User not found' });
    }

    const planLimits = { free: 3, starter: 30, pro: 100, elite: null };
    const clips_limit = planLimits[userData.plan] ?? 3;
    const credits_used = userData.credits_used || 0;
    const credits = userData.credits || 0;

    res.json({
      id: user_id,
      email: userData.email || req.user.email,
      plan: userData.plan || 'free',
      credits_used,
      credits_remaining: credits,
      clips_limit,
    });
  } catch (error) {
    logger(`User me error: ${error.message}`);
    res.status(500).json({ error: 'Failed to get user data' });
  }
});

// ============================================
// CLIPS - retorna DIRETO o array
// ============================================

app.get('/api/clips', authenticateUser, async (req, res) => {
  try {
    const user_id = req.user.id;

    const { data, error } = await supabase
      .from('clips')
      .select('*')
      .eq('user_id', user_id)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    // Monta share_url completo para cada clip
    const STORAGE_BASE = `${process.env.SUPABASE_URL}/storage/v1/object/public/clips/`;
    const clips = (data || []).map(clip => ({
      ...clip,
      share_url: clip.storage_url
        ? (clip.storage_url.startsWith('http') ? clip.storage_url : STORAGE_BASE + clip.storage_url)
        : null,
    }));

    // Retorna DIRETO o array
    res.json(clips);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get clips' });
  }
});

// ============================================
// JOB STATUS
// ============================================

app.get('/api/process/:job_id', authenticateUser, async (req, res) => {
  try {
    const { job_id } = req.params;
    const { data, error } = await supabase
      .from('processing_jobs')
      .select('*')
      .eq('id', job_id)
      .single();

    if (error) return res.status(404).json({ error: 'Job not found' });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get job status' });
  }
});

// ============================================
// PROCESS YOUTUBE
// ============================================

app.post('/api/process', authenticateUser, async (req, res) => {
  try {
    const { youtube_url, objetivo, tom, destino } = req.body;
    const user_id = req.user.id;

    if (!youtube_url) return res.status(400).json({ error: 'YouTube URL required' });

    const { data: userData } = await supabase
      .from('users')
      .select('credits, plan')
      .eq('id', user_id)
      .single();

    if (!userData || userData.credits <= 0) {
      return res.status(402).json({ error: 'No credits available' });
    }

    const job_id = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const { error: jobError } = await supabase.from('processing_jobs').insert({
      id: job_id,
      user_id,
      youtube_url,
      status: 'pending',
    });

    if (jobError) {
      logger(`Job creation error: ${jobError.message}`);
      return res.status(500).json({ error: 'Failed to create job' });
    }

    processVideoAsync(job_id, user_id, youtube_url, null, userData.plan, { objetivo, tom, destino });

    res.json({ job_id, status: 'processing', message: 'Processando...' });
  } catch (error) {
    logger(`Process error: ${error.message}`);
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ============================================
// PROCESS UPLOAD
// ============================================

const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 500 * 1024 * 1024 } });

app.post('/api/process/upload', authenticateUser, upload.single('video'), async (req, res) => {
  try {
    const user_id = req.user.id;
    if (!req.file) return res.status(400).json({ error: 'Video file required' });

    const { data: userData } = await supabase
      .from('users')
      .select('credits, plan')
      .eq('id', user_id)
      .single();

    if (!userData || userData.credits <= 0) {
      fs.unlink(req.file.path, () => {});
      return res.status(402).json({ error: 'No credits available' });
    }

    const job_id = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const ext = path.extname(req.file.originalname) || '.mp4';
    const videoPath = `/tmp/${job_id}${ext}`;
    fs.renameSync(req.file.path, videoPath);

    await supabase.from('processing_jobs').insert({
      id: job_id,
      user_id,
      youtube_url: `upload:${req.file.originalname}`,
      status: 'pending',
    });

    const videoConfig = {
      objetivo: req.body.objetivo || 'viralizar',
      tom: req.body.tom || 'dinamico',
      destino: req.body.destino || 'todos',
    };

    processVideoAsync(job_id, user_id, null, videoPath, userData.plan, videoConfig);

    res.json({ job_id, status: 'processing', message: 'Processando...' });
  } catch (error) {
    logger(`Upload error: ${error.message}`);
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ============================================
// PROCESSAMENTO ASSÍNCRONO
// ============================================

async function processVideoAsync(job_id, user_id, youtube_url, existingVideoPath, plan, config) {
  try {
    logger(`Starting job ${job_id}`);
    const applyWatermark = plan === 'free';

    let videoPath;
    if (existingVideoPath) {
      videoPath = existingVideoPath;
    } else {
      videoPath = await downloadVideo(youtube_url, job_id);
    }

    const transcription = await transcribeVideo(videoPath);
    const transcript = transcription.text;
    const words = transcription.words || [];

    let videoDuration = 999;
    try {
      const { stdout } = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${videoPath}"`);
      videoDuration = parseFloat(stdout.trim());
    } catch (e) {
      logger(`Duration error: ${e.message}`);
    }

    const moments = await analyzeWithClaude(transcript, config);
    const validMoments = moments
      .filter(m => m.start < videoDuration)
      .map(m => ({ ...m, start: Math.max(0, m.start), end: Math.min(videoDuration - 0.5, m.end) }));

    const finalMoments = validMoments.length > 0 ? validMoments : [
      { index: 1, start: 0, end: videoDuration - 0.5, reason: 'Clip completo', appeal: 'promessa', score: 5 }
    ];

    const clipIds = [];
    for (const moment of finalMoments) {
      const clipId = `clip_${job_id}_${moment.index}`;
      const clipWords = words
        .filter(w => w.start >= moment.start && w.end <= moment.end)
        .map(w => ({ ...w, start: w.start - moment.start, end: w.end - moment.start }));

      const clipPath = await generateClip(videoPath, moment.start, moment.end, moment.reason, applyWatermark, clipWords);

      let storagePath = `${user_id}/${clipId}.mp4`;
      try {
        storagePath = await uploadClipToStorage(clipPath, user_id, clipId);
      } catch (e) {
        logger(`Storage error: ${e.message}`);
      }

      const { error: insertError } = await supabase.from('clips').insert({
        id: clipId,
        job_id,
        user_id,
        title: `Clip - ${moment.reason || 'Clip gerado'}`,
        reason: moment.reason || 'Clip gerado',
        duration: Math.round((moment.end || 30) - (moment.start || 0)),
        storage_url: storagePath,
        hook_a: moment.hook_a || null,
        hook_b: moment.hook_b || null,
        virality_score: moment.score || null,
        start_time: moment.start || 0,
        end_time: moment.end || 30,
      });

      if (insertError) {
        logger(`Insert error: ${insertError.message}`);
      } else {
        logger(`✅ Clip saved: ${clipId}`);
        clipIds.push(clipId);
      }

      if (fs.existsSync(clipPath)) fs.unlinkSync(clipPath);
    }

    await supabase.from('processing_jobs').update({ status: 'completed' }).eq('id', job_id);

    try {
      await supabase.rpc('decrement_credits', { user_id, amount: clipIds.length });
    } catch (e) {
      await supabase.from('users').update({ credits: supabase.rpc('greatest', { a: 0, b: supabase.literal(`credits - ${clipIds.length}`) }) }).eq('id', user_id);
    }

    logger(`Job ${job_id} done: ${clipIds.length} clips`);
    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);

  } catch (error) {
    logger(`processVideoAsync error: ${error.message}`);
    await supabase.from('processing_jobs').update({ status: 'failed', error_message: error.message }).eq('id', job_id);
  }
}

// ============================================
// DOWNLOAD VIA YTSTREAM
// ============================================

async function downloadVideo(url, job_id) {
  const outputPath = `/tmp/${job_id}.mp4`;

  try {
    logger(`Downloading: ${url}`);

    let videoId = url;
    const matchWatch = url.match(/[?&]v=([^&]+)/);
    const matchShort = url.match(/youtu\.be\/([^?&]+)/);
    const matchShorts = url.match(/shorts\/([^?&]+)/);
    if (matchWatch) videoId = matchWatch[1];
    else if (matchShort) videoId = matchShort[1];
    else if (matchShorts) videoId = matchShorts[1];

    logger(`Video ID: ${videoId}`);

    const response = await axios.get('https://ytstream-download-youtube-videos.p.rapidapi.com/dl', {
      params: { id: videoId },
      headers: {
        'x-rapidapi-host': 'ytstream-download-youtube-videos.p.rapidapi.com',
        'x-rapidapi-key': process.env.RAPIDAPI_KEY,
      },
      timeout: 30000,
    });

    if (!response.data || !response.data.formats) {
      throw new Error('YTStream sem formatos');
    }

    const formats = response.data.formats;
    let downloadUrl = null;
    for (const itag of ['18', '134', '135', '136', '22']) {
      if (formats[itag]?.url) {
        downloadUrl = formats[itag].url;
        logger(`Usando itag ${itag}`);
        break;
      }
    }

    if (!downloadUrl) {
      const first = Object.values(formats).find(f => f.url && f.mimeType?.includes('video'));
      if (first) downloadUrl = first.url;
    }

    if (!downloadUrl) throw new Error('Nenhum formato encontrado');

    const videoRes = await axios({
      method: 'GET',
      url: downloadUrl,
      responseType: 'stream',
      timeout: 300000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(outputPath);
      videoRes.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) {
      throw new Error('Arquivo inválido');
    }

    logger(`✅ Download OK: ${outputPath}`);
    return outputPath;

  } catch (error) {
    if (fs.existsSync(outputPath)) try { fs.unlinkSync(outputPath); } catch (_) {}
    throw new Error(`Download failed: ${error.message}`);
  }
}

// ============================================
// TRANSCRIÇÃO
// ============================================

async function transcribeVideo(videoPath) {
  const audioPath = `${videoPath}_audio.mp3`;
  let filePath = videoPath;

  try {
    await execAsync(`ffmpeg -i "${videoPath}" -vn -acodec libmp3lame -q:a 4 "${audioPath}" -y`, { timeout: 120000 });
    if (fs.existsSync(audioPath)) filePath = audioPath;
  } catch (e) {
    logger(`Audio extract failed: ${e.message}`);
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

    return { text: response.data.text, words: response.data.words || [] };
  } catch (error) {
    throw new Error('Transcription failed');
  } finally {
    if (fs.existsSync(audioPath)) try { fs.unlinkSync(audioPath); } catch (_) {}
  }
}

// ============================================
// ANÁLISE CLAUDE
// ============================================

async function analyzeWithClaude(transcript, config = {}) {
  const { objetivo = 'viralizar', tom = 'dinamico', destino = 'todos' } = config;

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Você é especialista em viralização de conteúdo para redes sociais.

Objetivo: ${objetivo} | Tom: ${tom} | Destino: ${destino}

Transcrição:
"""
${transcript}
"""

Identifique os 5-7 melhores momentos para cortar em clipes de 15-60 segundos.

Retorne APENAS JSON válido (sem markdown):
{"moments":[{"index":1,"start":45,"end":75,"reason":"motivo","appeal":"promessa","score":8,"hook_a":"gancho A (máx 15 palavras)","hook_b":"gancho B (máx 15 palavras)"}]}`
      }],
    });

    let text = message.content[0].text.trim();
    if (text.startsWith('```')) text = text.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    return JSON.parse(text).moments || [];
  } catch (e) {
    logger(`Claude error: ${e.message}`);
    return [{ index: 1, start: 0, end: 999, reason: 'Clip completo', appeal: 'promessa', score: 5 }];
  }
}

// ============================================
// FFMPEG
// ============================================

async function generateClip(videoPath, startSeconds, endSeconds, reason, applyWatermark, words) {
  const clipPath = `/tmp/clip_${Date.now()}.mp4`;
  const duration = endSeconds - startSeconds;

  await execAsync(
    `ffmpeg -ss ${startSeconds} -i "${videoPath}" -t ${duration} -c:v libx264 -preset ultrafast -c:a aac -movflags +faststart "${clipPath}" -y`,
    { timeout: 120000 }
  );

  if (!fs.existsSync(clipPath)) throw new Error('Clip não gerado');
  return clipPath;
}

// ============================================
// STORAGE
// ============================================

async function uploadClipToStorage(clipPath, user_id, clipId) {
  const fileBuffer = fs.readFileSync(clipPath);
  const storagePath = `${user_id}/${clipId}.mp4`;

  const { error } = await supabase.storage.from('clips').upload(storagePath, fileBuffer, {
    contentType: 'video/mp4',
    upsert: true,
  });

  if (error) throw new Error(`Storage: ${error.message}`);
  return storagePath;
}

// ============================================
// PAGAMENTOS
// ============================================

app.post('/api/pagamento/checkout', authenticateUser, async (req, res) => {
  try {
    const { plano } = req.body;
    const planos = {
      starter: { valor: 49.90, nome: 'InovaShot Starter' },
      pro: { valor: 97.90, nome: 'InovaShot Pro' },
      elite: { valor: 197.90, nome: 'InovaShot Elite' },
    };
    if (!planos[plano]) return res.status(400).json({ error: 'Plano inválido' });

    const mpRes = await axios.post('https://api.mercadopago.com/checkout/preferences', {
      items: [{ title: planos[plano].nome, quantity: 1, unit_price: planos[plano].valor, currency_id: 'BRL' }],
      external_reference: `${req.user.id}|${plano}`,
      back_urls: {
        success: 'https://inovashot.com.br/app.html#sucesso',
        failure: 'https://inovashot.com.br/app.html#falha',
      },
    }, { headers: { Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}` } });

    res.json({ init_point: mpRes.data.init_point });
  } catch (e) {
    res.status(500).json({ error: 'Checkout failed' });
  }
});

app.post('/api/pagamento/webhook', async (req, res) => {
  try {
    const { type, data } = req.body;
    if (type === 'payment' && data?.id) {
      const mpRes = await axios.get(`https://api.mercadopago.com/v1/payments/${data.id}`, {
        headers: { Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}` },
      });
      if (mpRes.data.status === 'approved') {
        const [user_id, plano] = mpRes.data.external_reference.split('|');
        const credits = { starter: 30, pro: 100, elite: 999 }[plano] || 30;
        await supabase.from('users').update({ plan: plano, credits }).eq('id', user_id);
      }
    }
    res.sendStatus(200);
  } catch (e) {
    res.sendStatus(500);
  }
});

// ============================================
// HEALTH
// ============================================

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));
app.get('/', (req, res) => res.json({ service: 'InovaShot API', status: 'running' }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  logger(`InovaShot server running on port ${PORT}`);
  logger(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
