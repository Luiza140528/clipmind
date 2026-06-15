-- ============================================
-- CLIPMIND DATABASE SCHEMA (Supabase/PostgreSQL)
-- ============================================

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgvector";

-- ============================================
-- TABELA: USERS
-- ============================================

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR UNIQUE NOT NULL,
  name VARCHAR,
  plan VARCHAR DEFAULT 'free' CHECK (plan IN ('free', 'starter', 'pro', 'agency')),
  credits INT DEFAULT 3,
  subscription_id VARCHAR,
  subscription_status VARCHAR DEFAULT 'inactive',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);

-- ============================================
-- TABELA: PROCESSING_JOBS
-- ============================================

CREATE TABLE IF NOT EXISTS processing_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  youtube_url TEXT NOT NULL,
  status VARCHAR DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_jobs_user_id ON processing_jobs(user_id);
CREATE INDEX idx_jobs_status ON processing_jobs(status);
CREATE INDEX idx_jobs_created_at ON processing_jobs(created_at);

-- ============================================
-- TABELA: CLIPS
-- ============================================

CREATE TABLE IF NOT EXISTS clips (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id UUID NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR,
  reason TEXT,
  appeal VARCHAR, -- promessa, crítica, dados, piada, citação, resposta_emocional, força
  start_time INT,
  end_time INT,
  duration INT,
  storage_url TEXT,
  file_size INT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_clips_user_id ON clips(user_id);
CREATE INDEX idx_clips_job_id ON clips(job_id);
CREATE INDEX idx_clips_created_at ON clips(created_at);

-- ============================================
-- TABELA: SUBSCRIPTIONS
-- ============================================

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan VARCHAR NOT NULL CHECK (plan IN ('free', 'starter', 'pro', 'agency')),
  mercado_pago_id VARCHAR UNIQUE,
  status VARCHAR DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'pending')),
  price DECIMAL(10, 2),
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  renews_at TIMESTAMP WITH TIME ZONE,
  cancelled_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);

-- ============================================
-- TABELA: AUDIT_LOG
-- ============================================

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id),
  action VARCHAR,
  resource VARCHAR,
  details JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_audit_user_id ON audit_log(user_id);
CREATE INDEX idx_audit_created_at ON audit_log(created_at);

-- ============================================
-- FUNÇÃO: Decrementar créditos
-- ============================================

CREATE OR REPLACE FUNCTION decrement_credits(user_id UUID, amount INT)
RETURNS void AS $$
BEGIN
  UPDATE users
  SET credits = GREATEST(0, credits - amount),
      updated_at = NOW()
  WHERE id = user_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- FUNÇÃO: Auto-update updated_at
-- ============================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers para updated_at
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER processing_jobs_updated_at BEFORE UPDATE ON processing_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER clips_updated_at BEFORE UPDATE ON clips
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER subscriptions_updated_at BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- RLS (ROW LEVEL SECURITY)
-- ============================================

-- Enable RLS
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE processing_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE clips ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

-- Users can only see their own data
CREATE POLICY "Users can view own data" ON users
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own data" ON users
  FOR UPDATE USING (auth.uid() = id);

-- Users can only see their own jobs
CREATE POLICY "Users can view own jobs" ON processing_jobs
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create jobs" ON processing_jobs
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can only see their own clips
CREATE POLICY "Users can view own clips" ON clips
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own clips" ON clips
  FOR DELETE USING (auth.uid() = user_id);

-- Users can only see their own subscriptions
CREATE POLICY "Users can view own subscriptions" ON subscriptions
  FOR SELECT USING (auth.uid() = user_id);

-- ============================================
-- STORAGE BUCKETS
-- ============================================

-- Criar bucket de vídeos (via console Supabase depois)
-- Nome: clipmind-videos
-- Público: Não (acesso via signed URLs)
-- Tipos: video/mp4, video/quicktime

-- ============================================
-- DADOS INICIAIS (OPCIONAL)
-- ============================================

-- Planos pré-definidos (para referência)
-- Free: 3 cortes/mês, marca ClipMind, sem analytics
-- Starter: 30 cortes/mês, sem marca, analytics básico (R$47)
-- Pro: ilimitado, sem marca, analytics completo, agendamento (R$97)
-- Agency: ilimitado, múltiplos usuários, API acesso, suporte prioritário (R$297)

-- ============================================
-- VIEWS (Para simplificar queries)
-- ============================================

-- View: Clips com info do job
CREATE OR REPLACE VIEW clips_with_job_info AS
SELECT 
  c.id,
  c.user_id,
  c.title,
  c.reason,
  c.appeal,
  c.duration,
  c.storage_url,
  c.created_at,
  pj.youtube_url,
  pj.status as job_status
FROM clips c
LEFT JOIN processing_jobs pj ON c.job_id = pj.id;

-- View: User stats
CREATE OR REPLACE VIEW user_stats AS
SELECT 
  u.id,
  u.email,
  u.plan,
  u.credits,
  COUNT(DISTINCT c.id) as total_clips,
  COUNT(DISTINCT pj.id) as total_jobs,
  COUNT(DISTINCT CASE WHEN c.created_at > NOW() - INTERVAL '30 days' THEN c.id END) as clips_this_month
FROM users u
LEFT JOIN clips c ON u.id = c.user_id
LEFT JOIN processing_jobs pj ON u.id = pj.user_id
GROUP BY u.id, u.email, u.plan, u.credits;

-- ============================================
-- NOTAS
-- ============================================
-- 1. RLS está habilitado - precisa de token de autenticação
-- 2. Bucket clipmind-videos precisa ser criado via console Supabase
-- 3. Funções como decrement_credits podem ser chamadas via RPC
-- 4. Views podem ser consultadas diretamente
-- 5. Triggers mantêm updated_at automaticamente
