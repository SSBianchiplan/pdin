-- GPlanSiS|PDIN · 006 · Autenticação e gestão de usuários.
-- Idempotente: a API aplica este arquivo na subida (o banco de produção nasce do dump da migração).
-- Senhas: scrypt calculado na API (hashlib), nunca em texto. Sessões: só o SHA-256 do token fica no banco.

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id             bigserial PRIMARY KEY,
  email          text NOT NULL CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  name           text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  role           text NOT NULL DEFAULT 'operador' CHECK (role IN ('admin', 'operador', 'leitor')),
  password_hash  text NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  is_master      boolean NOT NULL DEFAULT false,
  must_change    boolean NOT NULL DEFAULT true,
  failed_logins  integer NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz,
  -- O master é sempre administrador ativo.
  CONSTRAINT master_is_active_admin CHECK (NOT is_master OR (role = 'admin' AND active))
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON auth.users (email);
CREATE UNIQUE INDEX IF NOT EXISTS users_single_master ON auth.users (is_master) WHERE is_master;

CREATE TABLE IF NOT EXISTS auth.sessions (
  token_hash    bytea PRIMARY KEY,
  user_id       bigint NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  ip            text,
  user_agent    text
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON auth.sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON auth.sessions (expires_at);

CREATE TABLE IF NOT EXISTS auth.events (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  actor_id  bigint REFERENCES auth.users (id) ON DELETE SET NULL,
  action    text NOT NULL,
  target    text,
  ip        text,
  detail    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS events_at_idx ON auth.events (at DESC);

-- O master não pode ser apagado nem perder o posto, nem por SQL direto.
CREATE OR REPLACE FUNCTION auth.protect_master() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.is_master THEN
    RAISE EXCEPTION 'O administrador master não pode ser removido';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_master AND NOT NEW.is_master THEN
    RAISE EXCEPTION 'O administrador master não pode perder o posto';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS users_protect_master ON auth.users;
CREATE TRIGGER users_protect_master BEFORE UPDATE OR DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION auth.protect_master();

INSERT INTO core.schema_migrations (version) VALUES (6) ON CONFLICT DO NOTHING;
