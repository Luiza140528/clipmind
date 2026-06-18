// server.js - ClipMind Backend (MVP)
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

// ============================================
// SETUP INICIAL
// ============================================

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Logger
const logger = (message) => {
  console.log(`[${new Date().toISOString()}] ${message}`);
};

// ============================================
// MIDDLEWARE DE AUTENTICAÇÃO
// ============================================

const authenticateUser = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const { data, error } = await supabase.auth.getUser(token);
    if (error) {
      return res.status(401).json({ error: 'Invalid token' });
    }

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

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    // Inserir user no banco com plano FREE
    const { error: insertError } = await supabase.from('users').insert({
      id: data.user.id,
      email,
      name: name || '',
      plan: 'free',
      credits: 3, // Free = 3 cortes/mês
    });

    if (insertError) {
      logger(`Insert user row error: ${insertError.message}`);
    }

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

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    logger(`User logged in: ${email}`);
    res.json({
      user_id: data.user.id,
      email: data.user.email,
      access_token: data.session.access_token,
    });
  } catch (error) {
    logger(`Login error: ${error.message}`);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ============================================
// ROTAS DE PROCESSAMENTO DE VÍDEO
// ============================================

app.post('/api/process', authenticateUser, async (req, res) => {
  try {
    const { youtube_url } = req.body;
    const user_id = req.user.id;

    if (!youtube_url) {
      return res.status(400).json({ error: 'YouTube URL required' });
    }

    // Verificar créditos
    const { data: userData } = await supabase
      .from('users')
      .select('credits, plan')
      .eq('id', user_id)
      .single();

    if (userData.credits <= 0) {
      return res.status(402).json({ error: 'No credits available' });
    }

    // Criar job de processamento
    const job_id = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const { data: jobData, error: jobError } = await supabase
      .from('processing_jobs')
      .insert({
        id: job_id,
        user_id,
        youtube_url,
        status: 'pending',
      })
      .select()
      .single();

    if (jobError) {
      logger(`Job creation error: ${jobError.message}`);
      return res.status(500).json({ error: 'Failed to create job' });
    }

    logger(`Job created: ${job_id} for user ${user_id}`);

    // Processar de forma assíncrona (não bloqueia a resposta)
    processVideoAsync(job_id, user_id, youtube_url, null, userData.plan);

    res.json({
      job_id,
      status: 'processing',
      message: 'Your video is being processed. Check back in a few minutes.',
    });
  } catch (error) {
    logger(`Process error: ${error.message}`);
    res.status(500).json({ error: 'Processing failed' });
  }
});

// Upload direto de vídeo (ex: discurso gravado no celular, sem precisar do YouTube)
const upload = multer({
  dest: '/tmp/uploads/',
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
});

app.post('/api/process/upload', authenticateUser, upload.single('video'), async (req, res) => {
  try {
    const user_id = req.user.id;

    if (!req.file) {
      return res.status(400).json({ error: 'Video file required' });
    }

    // Verificar créditos
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

    const { error: jobError } = await supabase
      .from('processing_jobs')
      .insert({
        id: job_id,
        user_id,
        youtube_url: `upload:${req.file.originalname}`,
        status: 'pending',
      });

    if (jobError) {
      logger(`Job creation error: ${jobError.message}`);
      return res.status(500).json({ error: 'Failed to create job' });
    }

    logger(`Upload job created: ${job_id} for user ${user_id}`);

    processVideoAsync(job_id, user_id, null, videoPath, userData.plan);

    res.json({
      job_id,
      status: 'processing',
      message: 'Seu vídeo está sendo processado. Confira em alguns minutos.',
    });
  } catch (error) {
    logger(`Upload process error: ${error.message}`);
    res.status(500).json({ error: 'Processing failed' });
  }
});

// Função assíncrona de processamento (roda em background)
async function processVideoAsync(job_id, user_id, youtube_url, existingVideoPath = null, plan = 'free') {
  try {
    logger(`Starting processing for job ${job_id}`);

    // Marca d'água "ClipMind" só no plano Free — é o incentivo pro upgrade
    const applyWatermark = plan === 'free';

    // 1. OBTER O VÍDEO: baixar do YouTube, ou usar o arquivo já enviado do celular
    let videoPath;
    if (existingVideoPath) {
      videoPath = existingVideoPath;
      logger(`Using uploaded video: ${videoPath}`);
    } else {
      logger(`Downloading video: ${youtube_url}`);
      videoPath = await downloadVideo(youtube_url, job_id);
    }

    // 2. TRANSCRIÇÃO (WHISPER)
    logger(`Transcribing video...`);
    const transcript = await transcribeVideo(videoPath);

    // 3. ANÁLISE (CLAUDE HAIKU) - Identificar momentos
    logger(`Analyzing moments...`);
    const moments = await analyzeWithClaude(transcript);

    // 4. GERAR CORTES (FFMPEG)
    logger(`Generating clips...`);
    const clipIds = [];
    for (const moment of moments) {
      const clipId = `clip_${job_id}_${moment.index}`;
      const clipPath = await generateClip(
        videoPath,
        moment.start,
        moment.end,
        moment.reason,
        applyWatermark
      );

      // 5. UPLOAD PARA SUPABASE STORAGE
      logger(`Uploading clip ${clipId} to storage...`);
      const storagePath = await uploadClipToStorage(
        clipPath,
        user_id,
        clipId
      );

      // Salvar clip no banco
      await supabase.from('clips').insert({
        id: clipId,
        job_id,
        user_id,
        title: `Clip - ${moment.reason}`,
        reason: moment.reason,
        start_time: moment.start,
        end_time: moment.end,
        duration: moment.end - moment.start,
        storage_url: storagePath,
        virality_score: moment.score ?? null,
      });

      clipIds.push(clipId);
      logger(`Clip created: ${clipId}`);

      // Limpar arquivo local
      fs.unlinkSync(clipPath);
    }

    // 6. ATUALIZAR JOB COMO COMPLETO
    await supabase
      .from('processing_jobs')
      .update({ status: 'completed' })
      .eq('id', job_id);

    // 7. DECREMENTAR CRÉDITOS
    const creditsUsed = clipIds.length;
    await supabase.rpc('decrement_credits', {
      user_id,
      amount: creditsUsed,
    });

    logger(`Job ${job_id} completed with ${clipIds.length} clips`);

    // Limpar arquivo de vídeo local
    fs.unlinkSync(videoPath);
  } catch (error) {
    logger(`ERROR in processVideoAsync: ${error.message}`);
    await supabase
      .from('processing_jobs')
      .update({ status: 'failed', error_message: error.message })
      .eq('id', job_id);
  }
}

// ============================================
// SERVIÇOS DE PROCESSAMENTO
// ============================================

// Baixar vídeo do YouTube
async function downloadVideo(url, job_id) {
  const outputPath = `/tmp/${job_id}.mp4`;

  try {
    // Usar yt-dlp pra baixar
    const command = `yt-dlp -f best -o "${outputPath}" "${url}"`;
    await execAsync(command, { timeout: 300000 }); // 5 minutos timeout
    logger(`Video downloaded: ${outputPath}`);
    return outputPath;
  } catch (error) {
    logger(`Download failed: ${error.message}`);
    throw new Error('Failed to download video');
  }
}

// Transcrever com Whisper
async function transcribeVideo(videoPath) {
  const audioPath = `${videoPath}_audio.mp3`;
  let filePath = videoPath;

  try {
    // Tenta extrair só o áudio (menor, mais aceito pelo Whisper)
    await execAsync(`ffmpeg -i "${videoPath}" -vn -acodec libmp3lame -q:a 4 "${audioPath}" -y`, { timeout: 120000 });
    if (fs.existsSync(audioPath)) {
      filePath = audioPath;
      logger(`Audio extracted: ${audioPath}`);
    }
  } catch (err) {
    logger(`Audio extraction failed, using original video: ${err.message}`);
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

    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      form,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          ...form.getHeaders(),
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );

    logger(`Transcription complete: ${response.data.text.substring(0, 100)}...`);
    return response.data.text;
  } catch (error) {
    const detail = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    logger(`Transcription error: ${detail}`);
    throw new Error('Failed to transcribe video');
  } finally {
    if (fs.existsSync(audioPath)) {
      try { fs.unlinkSync(audioPath); } catch (_) {}
    }
  }
}

// Analisar com Claude Haiku (OTIMIZADO PARA POLÍTICO)
async function analyzeWithClaude(transcript) {
  try {
    const { Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    const prompt = `Você é um especialista em política e viralização de conteúdo para redes sociais.

Transcrição de vídeo político:
"""
${transcript}
"""

TAREFA: Identifique os 5-7 MELHORES momentos que VÃO VIRALIZAR em TikTok/Reels/Shorts.

CRITÉRIOS DE VIRALIZAÇÃO (em ordem de importância):
1. FORÇA E CONVICÇÃO - Tom decisivo, sem hesitação. "Eu vou fazer", não "vou tentar"
2. PROMESSAS ESPECÍFICAS - Fala sobre o que vai fazer (saúde, educação, economia, etc)
3. CRÍTICAS BEM COLOCADAS - Responde adversário com dados ou lógica
4. DADOS IMPACTANTES - Números que chocam ("1 em cada 3", "duplicou", etc)
5. PIADAS/DESCONTRAÇÕES - Momentos onde ri ou é engraçado
6. CITAÇÕES MEMORÁVEIS - Frases que definem o posicionamento
7. RESPOSTA EMOCIONAL - Toca em sentimentos (esperança, raiva justa, indignação)

MUITO IMPORTANTE:
- Ignore momentos genéricos ("muito obrigado", "é um privilégio")
- Priorize clipes de 15-60 segundos
- Cada clipe deve ter UM ponto principal (não misturado)
- Ignora introduções e encerramento

Retorne APENAS JSON válido (sem markdown, sem \`\`\`):

{
  "moments": [
    {
      "index": 1,
      "start": 45,
      "end": 75,
      "reason": "Promessa sobre saúde com tom decisivo",
      "appeal": "promessa",
      "score": 8
    },
    {
      "index": 2,
      "start": 120,
      "end": 150,
      "reason": "Crítica ao adversário com dados específicos",
      "appeal": "crítica",
      "score": 6
    }
  ]
}

Appeal pode ser: promessa, crítica, dados, piada, citação, resposta_emocional, força
"score" é uma nota de 0 a 10 do potencial de viralização desse momento específico, considerando os critérios acima.`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const responseText = message.content[0].text;
    
    // Limpar resposta se tiver ```json
    let cleanedText = responseText.trim();
    if (cleanedText.startsWith('```')) {
      cleanedText = cleanedText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    }
    
    const parsed = JSON.parse(cleanedText);

    logger(`Claude identified ${parsed.moments.length} moments for politician`);
    return parsed.moments || [];
  } catch (error) {
    logger(`Claude analysis error: ${error.message}`);
    // Fallback: retornar momentos básicos se Claude falhar
    return [
      { index: 1, start: 30, end: 60, reason: 'Momento político importante', appeal: 'promessa', score: 5 },
      { index: 2, start: 120, end: 150, reason: 'Posicionamento claro', appeal: 'força', score: 5 },
      { index: 3, start: 200, end: 230, reason: 'Crítica bem colocada', appeal: 'crítica', score: 5 },
    ];
  }
}

// Gerar corte com FFmpeg (OTIMIZADO PARA POLÍTICO - Dark Navy + Gold)
async function generateClip(videoPath, startSeconds, endSeconds, reason, applyWatermark = false) {
  const clipPath = `/tmp/clip_${Date.now()}.mp4`;
  const duration = endSeconds - startSeconds;
  let watermarkPath = null;

  try {
    // Criar SRT file com legenda estilizada
    const srtPath = `/tmp/subtitle_${Date.now()}.srt`;
    const srtContent = `1
00:00:00,000 --> 00:00:${Math.ceil(duration)},000
${reason}`;
    fs.writeFileSync(srtPath, srtContent);

    const reframeFilter = `scale=-2:1920,crop=1080:1920`;
    const subtitleFilter = `subtitles='${srtPath}':force_style='FontName=Arial,FontSize=22,PrimaryColour=&HC9A84C&,SecondaryColour=&H0D1B2A&,OutlineColour=&H000000&,Outline=3,Shadow=2,Spacing=1,Alignment=2'`;
    const baseFilter = `${reframeFilter},${subtitleFilter}`;

    let ffmpegCommand;

    if (applyWatermark) {
      // Criar imagem de watermark ClipMind (texto simples com logo) - só plano Free
      watermarkPath = `/tmp/watermark_${Date.now()}.png`;
      const watermarkCommand = `convert -size 200x40 xc:transparent \
        -font Arial -pointsize 14 -fill "#C9A84C" \
        -gravity Center -annotate +0+0 "ClipMind" \
        "${watermarkPath}"`;

      try {
        await execAsync(watermarkCommand, { timeout: 10000 });
      } catch (e) {
        logger(`Watermark creation skipped: ${e.message}`);
        watermarkPath = null;
      }
    }

    if (watermarkPath && fs.existsSync(watermarkPath)) {
      // Corte + reformatação vertical + legenda + marca d'água no canto inferior direito
      ffmpegCommand = `ffmpeg -i "${videoPath}" -ss ${startSeconds} -to ${endSeconds} -i "${watermarkPath}" \
        -filter_complex "[0:v]${baseFilter}[base];[base][1:v]overlay=W-w-20:H-h-20[outv]" \
        -map "[outv]" -map 0:a? \
        -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 128k \
        "${clipPath}" -y`;
    } else {
      // FFmpeg command: cortar + reformatar vertical + legenda estilizada, sem marca d'água (planos pagos)
      ffmpegCommand = `ffmpeg -i "${videoPath}" \
        -ss ${startSeconds} -to ${endSeconds} \
        -vf "${baseFilter}" \
        -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 128k \
        "${clipPath}" -y`;
    }

    await execAsync(ffmpegCommand, { timeout: 120000 });
    logger(`Clip generated (watermark: ${!!watermarkPath}): ${clipPath}`);

    // Limpar SRT
    fs.unlinkSync(srtPath);

    // Limpar watermark se foi criado
    if (watermarkPath && fs.existsSync(watermarkPath)) {
      fs.unlinkSync(watermarkPath);
    }

    return clipPath;
  } catch (error) {
    logger(`FFmpeg error: ${error.message}`);
    throw new Error('Failed to generate clip');
  }
}

// Upload para Supabase Storage
async function uploadClipToStorage(clipPath, user_id, clipId) {
  try {
    const fileData = fs.readFileSync(clipPath);
    const storagePath = `${user_id}/${clipId}.mp4`;

    const { error } = await supabase.storage
      .from('clipmind-videos')
      .upload(storagePath, fileData, {
        contentType: 'video/mp4',
        upsert: true,
      });

    if (error) {
      throw error;
    }

    logger(`Clip uploaded to storage: ${storagePath}`);
    return storagePath;
  } catch (error) {
    logger(`Storage upload error: ${error.message}`);
    throw new Error('Failed to upload clip');
  }
}

// ============================================
// ROTAS DE CLIPS
// ============================================

app.get('/api/clips', authenticateUser, async (req, res) => {
  try {
    const user_id = req.user.id;
    const { limit = 20, offset = 0 } = req.query;

    const { data, error } = await supabase
      .from('clips')
      .select('*')
      .eq('user_id', user_id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const clips = data.map((clip) => ({
      ...clip,
      share_url: `${baseUrl}/c/${clip.id}`,
    }));

    res.json({ clips, total: clips.length });
  } catch (error) {
    logger(`Get clips error: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch clips' });
  }
});

app.get('/api/clips/:clip_id', authenticateUser, async (req, res) => {
  try {
    const { clip_id } = req.params;
    const user_id = req.user.id;

    const { data, error } = await supabase
      .from('clips')
      .select('*')
      .eq('id', clip_id)
      .eq('user_id', user_id)
      .single();

    if (error) {
      return res.status(404).json({ error: 'Clip not found' });
    }

    res.json(data);
  } catch (error) {
    logger(`Get clip error: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch clip' });
  }
});

app.delete('/api/clips/:clip_id', authenticateUser, async (req, res) => {
  try {
    const { clip_id } = req.params;
    const user_id = req.user.id;

    // Verificar se é do usuário
    const { data: clipData } = await supabase
      .from('clips')
      .select('storage_url')
      .eq('id', clip_id)
      .eq('user_id', user_id)
      .single();

    if (!clipData) {
      return res.status(404).json({ error: 'Clip not found' });
    }

    // Deletar do storage
    const storagePath = clipData.storage_url.split('/').slice(-2).join('/');
    await supabase.storage.from('clipmind-videos').remove([storagePath]);

    // Deletar do banco
    await supabase.from('clips').delete().eq('id', clip_id);

    logger(`Clip deleted: ${clip_id}`);
    res.json({ success: true });
  } catch (error) {
    logger(`Delete clip error: ${error.message}`);
    res.status(500).json({ error: 'Failed to delete clip' });
  }
});

// ============================================
// ROTAS DE STATUS
// ============================================

app.get('/api/process/:job_id', authenticateUser, async (req, res) => {
  try {
    const { job_id } = req.params;
    const user_id = req.user.id;

    const { data, error } = await supabase
      .from('processing_jobs')
      .select('*')
      .eq('id', job_id)
      .eq('user_id', user_id)
      .single();

    if (error) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Se completo, retornar clips também
    if (data.status === 'completed') {
      const { data: clips } = await supabase
        .from('clips')
        .select('*')
        .eq('job_id', job_id);
      return res.json({ ...data, clips });
    }

    res.json(data);
  } catch (error) {
    logger(`Get job error: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

// ============================================
// USUÁRIO (plano e créditos reais)
// ============================================

const PLAN_LIMITS = { free: 3, starter: 30, pro: 100, elite: Infinity };

app.get('/api/user/me', authenticateUser, async (req, res) => {
  try {
    const user_id = req.user.id;

    let { data, error } = await supabase
      .from('users')
      .select('email, name, plan, credits')
      .eq('id', user_id)
      .maybeSingle();

    if (error) {
      logger(`Get user error: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }

    // Se a conta de autenticação existe mas não tem linha na tabela users
    // (ex: o insert do signup falhou silenciosamente), cria agora com plano free.
    if (!data) {
      const { data: created, error: createError } = await supabase
        .from('users')
        .insert({
          id: user_id,
          email: req.user.email,
          name: '',
          plan: 'free',
          credits: 3,
        })
        .select('email, name, plan, credits')
        .single();

      if (createError) {
        logger(`Auto-create user row error: ${createError.message}`);
        return res.status(500).json({ error: createError.message });
      }

      data = created;
    }

    const limit = PLAN_LIMITS[data.plan] ?? PLAN_LIMITS.free;
    const used = limit === Infinity ? null : Math.max(0, limit - data.credits);

    res.json({
      email: data.email,
      name: data.name,
      plan: data.plan,
      credits_remaining: data.credits,
      clips_used: used,
      clips_limit: limit === Infinity ? null : limit,
    });
  } catch (error) {
    logger(`Get user error: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch user data' });
  }
});

// ============================================
// LINK CURTO / QR CODE (acesso público ao clip)
// ============================================

app.get('/c/:clip_id', async (req, res) => {
  try {
    const { clip_id } = req.params;

    const { data: clip, error } = await supabase
      .from('clips')
      .select('storage_url')
      .eq('id', clip_id)
      .single();

    if (error || !clip) {
      return res.status(404).send('Clip não encontrado');
    }

    const { data: signed, error: signError } = await supabase.storage
      .from('clipmind-videos')
      .createSignedUrl(clip.storage_url, 60 * 60 * 24 * 7); // 7 dias

    if (signError || !signed) {
      logger(`Sign URL error: ${signError?.message}`);
      return res.status(500).send('Não foi possível gerar o link do vídeo');
    }

    res.redirect(signed.signedUrl);
  } catch (error) {
    logger(`Short link error: ${error.message}`);
    res.status(500).send('Erro ao acessar o clip');
  }
});

// ============================================
// HEALTH CHECK
// ============================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  logger(`ClipMind server running on port ${PORT}`);
  logger(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
