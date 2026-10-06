-- Least-privilege database role for the app (NFR-06). Not a migration: run it once per
-- Supabase project (SQL editor, as postgres) after `npm run db:migrate`, with a real password
-- from a password manager. Then point DATABASE_URL at the transaction pooler with the user
-- "boustan_app.<project-ref>". DATABASE_URL_MIGRATIONS keeps the postgres user, which owns the
-- schema and runs migrations.
--
-- A migration that adds a table must grant it to boustan_app in the same migration.

create role boustan_app login password 'CHANGE-ME' noinherit;
grant usage on schema public to boustan_app;

-- What the API reads and writes. No DDL, no TRUNCATE.
grant select, insert, update on players, player_tokens, runs, best_runs, email_outbox, crm_outbox,
  events_daily to boustan_app;
grant select, insert, update, delete on claims to boustan_app;
grant select, insert, update on codes to boustan_app;
grant select, insert on events to boustan_app;
grant select on v_code_stock, v_funnel_daily to boustan_app;
-- The admin (Stage 3) edits settings, imports codes and erases players, from the same app role.
-- The consent log's trigger still refuses a DELETE unless the transaction says it is a purge
-- (erasing a player, the retention job), and nothing here can UPDATE a consent row.
grant select, update on campaign_settings, rewards to boustan_app;
grant delete on player_tokens, best_runs to boustan_app;

-- Consent log: insert and read always; delete only inside a purge (see above). Audit log:
-- insert and read, never changed.
grant select, insert, delete on consents to boustan_app;
grant select, insert on admin_audit to boustan_app;

grant usage, select on sequence consents_id_seq, events_id_seq, crm_outbox_id_seq,
  admin_audit_id_seq, codes_id_seq to boustan_app;

-- Supabase's Data API roles get nothing (the Data API should be off too: INFRA.md 4.3).
revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
