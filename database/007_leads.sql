-- GPlanSiS|PDIN · 007 · Solicitações de demonstração vindas da página pública.
-- Idempotente; aplicado pela API na subida junto com a 006.
CREATE TABLE IF NOT EXISTS auth.leads (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  company     text NOT NULL CHECK (length(company) BETWEEN 2 AND 160),
  email       text NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 254),
  phone       text CHECK (phone IS NULL OR length(phone) <= 40),
  role        text CHECK (role IS NULL OR length(role) <= 80),
  interests   text[] NOT NULL DEFAULT '{}',
  message     text CHECK (message IS NULL OR length(message) <= 2000),
  status      text NOT NULL DEFAULT 'novo' CHECK (status IN ('novo', 'contatado', 'descartado')),
  ip          text,
  user_agent  text
);
CREATE INDEX IF NOT EXISTS leads_at_idx ON auth.leads (at DESC);
INSERT INTO core.schema_migrations (version) VALUES (7) ON CONFLICT DO NOTHING;
