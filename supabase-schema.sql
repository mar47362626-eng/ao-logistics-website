CREATE TABLE IF NOT EXISTS public.app_records (
  collection text NOT NULL
    CHECK (collection IN ('users', 'riders', 'orders', 'notifications', 'sessions')),
  record_id text NOT NULL,
  email text,
  reference text,
  token_hash text,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  PRIMARY KEY (collection, record_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS app_records_users_email_key
  ON public.app_records (lower(email))
  WHERE collection = 'users' AND email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS app_records_riders_email_key
  ON public.app_records (lower(email))
  WHERE collection = 'riders' AND email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS app_records_orders_reference_key
  ON public.app_records (reference)
  WHERE collection = 'orders' AND reference IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS app_records_riders_reference_key
  ON public.app_records (reference)
  WHERE collection = 'riders' AND reference IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS app_records_sessions_token_hash_key
  ON public.app_records (token_hash)
  WHERE collection = 'sessions' AND token_hash IS NOT NULL;

ALTER TABLE public.app_records ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.app_records FROM anon, authenticated;
GRANT ALL ON TABLE public.app_records TO service_role;
