-- GPlanSiS|PDIN · 008 · Telemetria simulada separada da real.
-- Amostras reais continuam em iot.samples (imutável, histórico completo). As simuladas vão para iot.sim_samples,
-- com retenção de 6 h, e marcam iot.tag_latest.sim = true para a interface exibir "SIMULADO".
-- Leitura real tem precedência: uma amostra simulada não sobrescreve um valor real recebido há menos de 2 min.
-- Idempotente; aplicado pela API na subida.
ALTER TABLE iot.tag_latest ADD COLUMN IF NOT EXISTS sim boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS iot.sim_samples (
  project_id uuid NOT NULL REFERENCES core.projects ON DELETE CASCADE,
  tag        text NOT NULL,
  value      numeric NOT NULL,
  at         timestamptz NOT NULL,
  PRIMARY KEY (project_id, tag, at)
);
CREATE INDEX IF NOT EXISTS sim_samples_at_idx ON iot.sim_samples (at);

CREATE OR REPLACE FUNCTION iot.ingest(p_project uuid, p_samples jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s jsonb; n integer=0; skipped integer=0; t timestamptz; v numeric; q smallint;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM core.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Projeto inexistente'; END IF;
 FOR s IN SELECT e FROM jsonb_array_elements(p_samples) e LOOP
  IF s->>'tag' IS NULL OR s->>'value' IS NULL THEN skipped=skipped+1; CONTINUE; END IF;
  v=(s->>'value')::numeric; q=coalesce((s->>'quality')::smallint,192);
  t=coalesce((s->>'at')::timestamptz,now());
  IF EXISTS(SELECT 1 FROM iot.samples WHERE project_id=p_project AND tag=s->>'tag' AND at=t) THEN skipped=skipped+1; CONTINUE; END IF;
  INSERT INTO iot.samples(project_id,tag,value,quality,at) VALUES(p_project,s->>'tag',v,q,t);
  INSERT INTO iot.tag_latest(project_id,tag,value,quality,at,sim) VALUES(p_project,s->>'tag',v,q,t,false)
   ON CONFLICT(project_id,tag) DO UPDATE SET value=EXCLUDED.value,quality=EXCLUDED.quality,at=EXCLUDED.at,sim=false
   WHERE iot.tag_latest.at<=EXCLUDED.at OR iot.tag_latest.sim;
  n=n+1;
 END LOOP;
 RETURN jsonb_build_object('ingested',n,'skipped',skipped);
END $$;

CREATE OR REPLACE FUNCTION iot.ingest_sim(p_project uuid, p_samples jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s jsonb; n integer=0; t timestamptz; v numeric;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM core.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Projeto inexistente'; END IF;
 FOR s IN SELECT e FROM jsonb_array_elements(p_samples) e LOOP
  IF s->>'tag' IS NULL OR s->>'value' IS NULL THEN CONTINUE; END IF;
  v=(s->>'value')::numeric; t=coalesce((s->>'at')::timestamptz,now());
  INSERT INTO iot.sim_samples(project_id,tag,value,at) VALUES(p_project,s->>'tag',v,t) ON CONFLICT DO NOTHING;
  INSERT INTO iot.tag_latest(project_id,tag,value,quality,at,sim) VALUES(p_project,s->>'tag',v,192,t,true)
   ON CONFLICT(project_id,tag) DO UPDATE SET value=EXCLUDED.value,quality=192,at=EXCLUDED.at,sim=true
   WHERE iot.tag_latest.sim OR iot.tag_latest.at < now() - interval '2 minutes';
  n=n+1;
 END LOOP;
 DELETE FROM iot.sim_samples WHERE at < now() - interval '6 hours';
 RETURN jsonb_build_object('ingested',n,'simulated',true);
END $$;

INSERT INTO core.schema_migrations (version) VALUES (8) ON CONFLICT DO NOTHING;
