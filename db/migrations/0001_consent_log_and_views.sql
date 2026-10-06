-- Hand-written: things Drizzle's schema can't express.

-- The consent log is append-only proof of consent (DATA-03, CASL). UPDATE is never allowed.
-- DELETE and TRUNCATE are allowed only when the transaction says so, which the retention job
-- (DATA-06) and admin player deletion (DATA-07) do with:
--   SET LOCAL boustan.allow_consent_purge = 'on';
CREATE FUNCTION consents_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE')
     AND current_setting('boustan.allow_consent_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'consents is append-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER consents_append_only
  BEFORE UPDATE OR DELETE ON consents
  FOR EACH ROW EXECUTE FUNCTION consents_append_only();
--> statement-breakpoint
CREATE TRIGGER consents_no_truncate
  BEFORE TRUNCATE ON consents
  FOR EACH STATEMENT EXECUTE FUNCTION consents_append_only();
--> statement-breakpoint

-- The single settings row. Claims stay off until someone sets dates and turns them on.
INSERT INTO campaign_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Code stock per reward (RWD-04), for SQL users until the admin dashboard exists.
CREATE VIEW v_code_stock AS
SELECT
  r.id AS reward_id,
  r.active,
  count(c.id) AS total,
  count(c.id) FILTER (
    WHERE c.status = 'available' AND (c.expires_at IS NULL OR c.expires_at > now())
  ) AS available,
  count(c.id) FILTER (WHERE c.status = 'assigned') AS assigned,
  count(c.id) FILTER (WHERE c.status = 'redeemed') AS redeemed,
  count(c.id) FILTER (WHERE c.status = 'void') AS void
FROM rewards r
LEFT JOIN codes c ON c.reward_id = r.id
GROUP BY r.id, r.active;
--> statement-breakpoint

-- Daily funnel (ADM-02): loads → starts → 100 m → 10 garlic → claim views → claims → opt-ins,
-- split by src, language and device. Reads the rollup that /api/cron/rollup refreshes.
CREATE VIEW v_funnel_daily AS
SELECT
  day,
  src,
  lang,
  device,
  coalesce(sum(sessions) FILTER (WHERE name = 'load'), 0) AS loads,
  coalesce(sum(events) FILTER (WHERE name = 'start'), 0) AS starts,
  coalesce(sum(events) FILTER (WHERE name = 'milestone' AND detail = '100'), 0) AS reached_100m,
  coalesce(
    sum(events) FILTER (WHERE name = 'reward_unlocked' AND detail = 'free_garlic_sauce'), 0
  ) AS garlic_10,
  coalesce(sum(events) FILTER (WHERE name = 'claim_view'), 0) AS claim_views,
  coalesce(sum(events) FILTER (WHERE name = 'claim_success'), 0) AS claims,
  coalesce(sum(events) FILTER (WHERE name = 'opt_in'), 0) AS opt_ins
FROM events_daily
GROUP BY day, src, lang, device;
