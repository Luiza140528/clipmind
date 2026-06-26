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
    const { youtube_url, objetivo, tom, destino } = req.body;
    const user_id = req.user.id;
    const videoConfig = { objetivo, tom, destino };

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
    processVideoAsync(job_id, user_id, youtube_url, null, userData.plan, videoConfig);

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

    const videoConfig = {
      objetivo: req.body.objetivo || 'viralizar',
      tom: req.body.tom || 'dinamico',
      destino: req.body.destino || 'todos',
    };

    processVideoAsync(job_id, user_id, null, videoPath, userData.plan, videoConfig);

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
async function processVideoAsync(job_id, user_id, youtube_url, existingVideoPath = null, plan = 'free', config = {}) {
  try {
    logger(`Starting processing for job ${job_id}`);

    // Marca d'água "InovaShot" só no plano Free — é o incentivo pro upgrade
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
    const transcription = await transcribeVideo(videoPath);
    const transcript = transcription.text;
    const words = transcription.words || [];

    // 3. ANÁLISE (CLAUDE HAIKU) - Identificar momentos
    logger(`Analyzing moments...`);
    
    // Obter duração real do vídeo
    let videoDuration = 999;
    try {
      const { stdout } = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${videoPath}"`);
      videoDuration = parseFloat(stdout.trim());
      logger(`Video duration: ${videoDuration}s`);
    } catch (e) {
      logger(`Could not get video duration: ${e.message}`);
    }

    const moments = await analyzeWithClaude(transcript, config);
    
    // Filtrar momentos que ultrapassam a duração do vídeo
    const validMoments = moments.filter(m => m.start < videoDuration).map(m => ({
      ...m,
      start: Math.max(0, m.start),
      end: Math.min(videoDuration - 0.5, m.end),
    }));
    
    logger(`Valid moments after duration check: ${validMoments.length}/${moments.length}`);
    const finalMoments = validMoments.length > 0 ? validMoments : [
      { index: 1, start: 0, end: videoDuration - 0.5, reason: 'Clip completo', appeal: 'promessa', score: 5 }
    ];

    // 4. GERAR CORTES (FFMPEG)
    logger(`Generating clips...`);
    const clipIds = [];
    for (const moment of finalMoments) {
      const clipId = `clip_${job_id}_${moment.index}`;

      // Filtrar as palavras que caem dentro deste clip (para legendas animadas)
      const clipWords = words.filter(w => w.start >= moment.start && w.end <= moment.end)
        .map(w => ({ ...w, start: w.start - moment.start, end: w.end - moment.start }));

      const clipPath = await generateClip(
        videoPath,
        moment.start,
        moment.end,
        moment.reason,
        applyWatermark,
        clipWords
      );

      // 5. UPLOAD PARA SUPABASE STORAGE
      logger(`Uploading clip ${clipId} to storage...`);
      let storagePath = null;
      try {
        storagePath = await uploadClipToStorage(
          clipPath,
          user_id,
          clipId
        );
      } catch (storageErr) {
        logger(`Storage upload failed (continuing): ${storageErr.message}`);
        storagePath = clipPath; // usar caminho local como fallback
      }

      // Salvar clip no banco
      const clipData = {
        id: clipId,
        job_id,
        user_id,
        title: `Clip - ${moment.reason || 'Clip gerado'}`,
        reason: moment.reason || 'Clip gerado',
        duration: Math.round((moment.end || 30) - (moment.start || 0)),
        storage_url: storagePath || clipId,
        hook_a: moment.hook_a || null,
        hook_b: moment.hook_b || null,
      };
      
      logger(`Inserting clip data: ${JSON.stringify(clipData)}`);
      const { data: insertedClip, error: insertError } = await supabase.from('clips').insert(clipData).select();

      if (insertError) {
        logger(`ERROR inserting clip: ${JSON.stringify(insertError)}`);
        // Tentar insert simplificado sem campos opcionais
        const { error: simpleError } = await supabase.from('clips').insert({
          id: clipId,
          job_id,
          user_id,
          title: 'Clip gerado',
          storage_url: storagePath || clipId,
        });
        if (simpleError) {
          logger(`Simple insert also failed: ${JSON.stringify(simpleError)}`);
        } else {
          logger(`Clip saved with simple insert: ${clipId}`);
        }
      } else {
        logger(`Clip saved to DB successfully: ${clipId}`);
      }

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
    // Verificar se yt-dlp está disponível
    await execAsync('which yt-dlp || python3 -m yt_dlp --version');
    
    // Tentar com yt-dlp
    const ytdlpCmd = `yt-dlp -f "best[ext=mp4]/best" --no-playlist -o "${outputPath}" "${url}"`;
    logger(`Iniciando download: ${url}`);
    await execAsync(ytdlpCmd, { timeout: 300000 });
    
    if (!fs.existsSync(outputPath)) {
      throw new Error('Arquivo não foi criado após download');
    }
    
    logger(`Download concluído: ${outputPath}`);
    return outputPath;
  } catch (error) {
    logger(`Erro no download: ${error.message}`);
    
    // Tentar com python3 -m yt_dlp como fallback
    try {
      const fallbackCmd = `python3 -m yt_dlp -f "best[ext=mp4]/best" --no-playlist -o "${outputPath}" "${url}"`;
      await execAsync(fallbackCmd, { timeout: 300000 });
      if (fs.existsSync(outputPath)) {
        logger(`Download via fallback concluído`);
        return outputPath;
      }
    } catch (fallbackError) {
      logger(`Fallback também falhou: ${fallbackError.message}`);
    }
    
    throw new Error(`Falha no download do vídeo: ${error.message}`);
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
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');

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
    return {
      text: response.data.text,
      words: response.data.words || [],
    };
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
    crise: 'urgente, direto e sem rodeios — modo de defesa',
    engracado: 'leve, com humor e descontração',
    emocional: 'emotivo, inspirador e que toca o coração',
  };

  const destinoMap = {
    tiktok: 'TikTok (público jovem, 15-60s, trend-driven)',
    reels: 'Instagram Reels (público 25-40, estético e inspirador)',
    shorts: 'YouTube Shorts (público amplo, informativo)',
    facebook: 'Facebook (público 40+, mais tolerante a textos longos)',
    todos: 'todas as plataformas (equilibrar formato e duração)',
  };

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    const prompt = `Você é um especialista em comunicação política e viralização de conteúdo para redes sociais.

CONFIGURAÇÃO DO CLIENTE:
- Objetivo: ${objetivoMap[objetivo] || objetivo}
- Tom desejado: ${tomMap[tom] || tom}
- Destino: ${destinoMap[destino] || destino}

Transcrição do vídeo:
"""
${transcript}
"""

TAREFA: Com base na configuração acima, identifique os 5-7 MELHORES momentos para cortar.

CRITÉRIOS (adaptados ao objetivo "${objetivo}" e tom "${tom}"):
1. FORÇA E CONVICÇÃO - Tom decisivo, sem hesitação
2. RELEVÂNCIA AO OBJETIVO - Alinha com o que o cliente quer comunicar
3. DURAÇÃO IDEAL - 15-60 segundos para ${destino === 'facebook' ? 'Facebook (pode ser até 90s)' : 'redes de vídeo curto'}
4. INÍCIO IMPACTANTE - Os primeiros 3 segundos devem prender a atenção
5. UM PONTO PRINCIPAL - Cada clip com uma mensagem clara

${tom === 'crise' ? `
MODO CRISE ATIVADO:
- Priorize momentos de defesa, esclarecimento e contra-ataque
- Foco em clareza, seriedade e credibilidade
- Ignore momentos de humor ou leveza
` : ''}

${objetivo === 'rebater' ? `
MODO REBATE ATIVADO:
- Identifique os argumentos mais fortes e diretos
- Priorize momentos com dados, fatos ou lógica irrefutável
- Destaque frases que desarmam o adversário
` : ''}

Retorne APENAS JSON válido (sem markdown, sem \`\`\`):

{
  "moments": [
    {
      "index": 1,
      "start": 45,
      "end": 75,
      "reason": "Proposta sobre saúde com tom decisivo — gancho forte nos primeiros 3s",
      "appeal": "promessa",
      "score": 8,
      "hook_a": "Você sabia que 1 em cada 3 famílias não tem acesso a médico? Isso vai mudar.",
      "hook_b": "O que você faria se pudesse garantir saúde pra toda sua família? Aqui está o plano."
    }
  ]
}

Appeal pode ser: promessa, crítica, dados, piada, citação, resposta_emocional, força, defesa, bastidores
"score" é nota de 0-10 do potencial considerando o objetivo e tom escolhidos.
"hook_a" é um gancho polêmico/curiosidade para os primeiros 3 segundos (versão A do Double-Hook).
"hook_b" é um gancho focado em benefício direto ou pergunta impactante (versão B do Double-Hook).
Ambos os hooks devem ter no máximo 15 palavras e ser escritos em português brasileiro natural.`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const responseText = message.content[0].text;
    
    let cleanedText = responseText.trim();
    if (cleanedText.startsWith('```')) {
      cleanedText = cleanedText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    }
    
    const parsed = JSON.parse(cleanedText);

    logger(`Claude identified ${parsed.moments.length} moments — objetivo: ${objetivo}, tom: ${tom}`);
    return parsed.moments || [];
  } catch (error) {
    logger(`Claude analysis error: ${error.message}`);
    // Fallback: retornar o vídeo inteiro como um clip
    return [
      { index: 1, start: 0, end: 999, reason: 'Momento completo do discurso', appeal: 'promessa', score: 5 },
    ];
  }
}

// Gerar corte com FFmpeg (OTIMIZADO PARA POLÍTICO - Dark Navy + Gold)
async function generateClip(videoPath, startSeconds, endSeconds, reason, applyWatermark = false, words = []) {
  const clipPath = `/tmp/clip_${Date.now()}.mp4`;
  const duration = endSeconds - startSeconds;
  let watermarkPath = null;

  try {
    // Gerar SRT com legendas palavra por palavra (animadas) ou legenda simples como fallback
    const srtPath = `/tmp/subtitle_${Date.now()}.srt`;
    let srtContent = '';

    if (words && words.length > 0) {
      // Agrupar palavras em blocos de 3-4 palavras pra legenda não ficar longa
      const WORDS_PER_BLOCK = 4;
      for (let i = 0; i < words.length; i += WORDS_PER_BLOCK) {
        const block = words.slice(i, i + WORDS_PER_BLOCK);
        const blockStart = block[0].start;
        const blockEnd = block[block.length - 1].end;
        const text = block.map(w => w.word).join(' ').toUpperCase();

        const toSrtTime = (s) => {
          const h = Math.floor(s / 3600);
          const m = Math.floor((s % 3600) / 60);
          const sec = Math.floor(s % 60);
          const ms = Math.round((s % 1) * 1000);
          return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
        };

        srtContent += `${Math.floor(i / WORDS_PER_BLOCK) + 1}\n${toSrtTime(blockStart)} --> ${toSrtTime(blockEnd)}\n${text}\n\n`;
      }
    } else {
      // Fallback: legenda simples com o motivo do corte
      srtContent = `1\n00:00:00,000 --> 00:00:${Math.ceil(duration)},000\n${reason}\n\n`;
    }

    fs.writeFileSync(srtPath, srtContent);

    // FFmpeg OTIMIZADO: corte simples e rápido (sem legendas pesadas)
    // Legendas removidas do pipeline principal para evitar timeout
    let ffmpegCommand;

    if (applyWatermark) {
      // Plano Free: corte simples com texto de watermark
      ffmpegCommand = `ffmpeg -i "${videoPath}" -ss ${startSeconds} -to ${endSeconds} \
        -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,drawtext=text='InovaShot':fontcolor=white:fontsize=24:x=20:y=H-th-20" \
        -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 96k \
        "${clipPath}" -y`;
    } else {
      // Planos pagos: corte simples e rápido
      ffmpegCommand = `ffmpeg -i "${videoPath}" -ss ${startSeconds} -to ${endSeconds} \
        -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" \
        -c:v libx264 -preset ultrafast -crf 26 -c:a aac -b:a 128k \
        "${clipPath}" -y`;
    }

    await execAsync(ffmpegCommand, { timeout: 60000 });
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
      .from('clips')
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
    await supabase.storage.from('clips').remove([storagePath]);

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
      .from('clips')
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
// MERCADO PAGO
// ============================================

const PLANOS = {
    starter: { nome: 'InovaShot Starter', preco: 49.90, clips: 30 },
    pro:     { nome: 'InovaShot Pro',     preco: 97.90, clips: 100 },
    elite:   { nome: 'InovaShot Elite',   preco: 197.90, clips: 999999 },
};

// Criar preferência de pagamento
app.post('/api/pagamento/checkout', authenticateUser, async (req, res) => {
    try {
        const { plano } = req.body;
        const userId = req.user.id;
        const userEmail = req.user.email;

        if (!PLANOS[plano]) {
            return res.status(400).json({ error: 'Plano inválido' });
        }

        const p = PLANOS[plano];

        const response = await axios.post(
            'https://api.mercadopago.com/checkout/preferences',
            {
                items: [{
                    title: p.nome,
                    quantity: 1,
                    currency_id: 'BRL',
                    unit_price: p.preco,
                }],
                payer: { email: userEmail },
                back_urls: {
                    success: `https://inovashot.com.br/app.html#sucesso`,
                    failure: `https://inovashot.com.br/app.html#falha`,
                    pending: `https://inovashot.com.br/app.html#pendente`,
                },
                auto_return: 'approved',
                external_reference: `${userId}|${plano}`,
                notification_url: `https://inovashot.onrender.com/api/pagamento/webhook`,
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json',
                }
            }
        );

        res.json({ 
            init_point: response.data.init_point,
            preferencia_id: response.data.id 
        });

    } catch (err) {
        console.error('Erro checkout MP:', err.response?.data || err.message);
        res.status(500).json({ error: 'Erro ao criar pagamento' });
    }
});

// Webhook do Mercado Pago
app.post('/api/pagamento/webhook', async (req, res) => {
    try {
        const { type, data } = req.body;

        if (type === 'payment') {
            const paymentId = data?.id;
            if (!paymentId) return res.sendStatus(200);

            // Buscar detalhes do pagamento
            const paymentRes = await axios.get(
                `https://api.mercadopago.com/v1/payments/${paymentId}`,
                { headers: { Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}` } }
            );

            const payment = paymentRes.data;

            if (payment.status === 'approved') {
                const [userId, plano] = (payment.external_reference || '').split('|');
                
                if (userId && plano && PLANOS[plano]) {
                    // Atualizar plano do usuário no Supabase
                    await supabase
                        .from('users')
                        .update({ plan: plano, credits_used: 0 })
                        .eq('id', userId);

                    // Registrar transação
                    await supabase
                        .from('transactions')
                        .insert({
                            user_id: userId,
                            amount: PLANOS[plano].preco,
                            plan: plano,
                            mercado_pago_id: String(paymentId),
                            status: 'approved'
                        });

                    console.log(`✅ Plano ${plano} ativado para user ${userId}`);
                }
            }
        }

        res.sendStatus(200);
    } catch (err) {
        console.error('Erro webhook MP:', err.message);
        res.sendStatus(200);
    }
});

// ============================================
// HEALTH CHECK
// ============================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// AGENTE INOVASHOT
// ============================================

app.post('/api/agente', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages obrigatório' });
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: `Você é o Agente InovaShot, assistente especializado da plataforma InovaShot (inovashot.com.br).

Sua missão é ajudar usuários com:
1. SUPORTE AO APP: Como gerar clips, usar o Módulo Político, entender os planos, resolver dúvidas técnicas
2. DICAS DE CAMPANHA POLÍTICA: Estratégias de conteúdo, melhores horários para postar, como viralizar discursos, uso das redes sociais

SOBRE O INOVASHOT:
- Plataforma de geração automática de clips virais com IA
- Funcionalidades: upload de vídeo/YouTube, transcrição com Whisper, cortes automáticos com IA, legendas animadas, remoção de silêncios, formato 9:16
- Módulo Político: Botão S.O.S. (emergência em 60min), Perfil do Candidato, Guia Jurídico-Eleitoral, Banco de Memória por Tema, Tendências da Semana, Modo Rascunho
- Planos: Free (3 clips/mês), Starter (R$49,90 - 30 clips), Pro (R$97,90 - 100 clips), Elite (R$197,90 - ilimitado)
- Slogan: "Não é sorte, é o corte certo."

ESTILO: Seja direto, amigável, use emojis com moderação. Respostas curtas e objetivas. Sempre em português brasileiro.`,
      messages: messages
    });

    res.json({ resposta: response.content[0].text });
  } catch (err) {
    console.error('Erro agente:', err);
    res.status(500).json({ error: 'Erro ao processar mensagem' });
  }
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  logger(`InovaShot server running on port ${PORT}`);
  logger(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
