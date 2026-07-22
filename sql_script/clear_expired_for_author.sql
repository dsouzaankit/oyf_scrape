-- Clear expired_ts soft-deletes for one author (chat + wall).
-- Run via local_run/local_setup/clear_expired_for_active_author.ps1 (injects author_id).
-- Open web.db directly (writable); do not ATTACH when piping through the PS1.

ALTER TABLE stg_chat_messages ADD COLUMN IF NOT EXISTS expired_ts TIMESTAMP;
ALTER TABLE stg_wall_posts ADD COLUMN IF NOT EXISTS expired_ts TIMESTAMP;

CREATE OR REPLACE TEMP TABLE author_filter AS
	-- select unnest([]::varchar[]) as author_id
	select unnest(['000000000']) as author_id
	-- select unnest(['180951488']) as author_id
;

SELECT 'chat before' AS step,
	count(*) FILTER (WHERE expired_ts IS NULL)::BIGINT AS active,
	count(*) FILTER (WHERE expired_ts IS NOT NULL)::BIGINT AS expired
FROM stg_chat_messages
WHERE cast("fromUser".id AS varchar) IN (SELECT author_id FROM author_filter);

SELECT 'wall before' AS step,
	count(*) FILTER (WHERE expired_ts IS NULL)::BIGINT AS active,
	count(*) FILTER (WHERE expired_ts IS NOT NULL)::BIGINT AS expired
FROM stg_wall_posts
WHERE cast("author".id AS varchar) IN (SELECT author_id FROM author_filter);

UPDATE stg_chat_messages
SET expired_ts = NULL
WHERE expired_ts IS NOT NULL
  AND cast("fromUser".id AS varchar) IN (SELECT author_id FROM author_filter)
RETURNING cast(id AS varchar) AS cleared_chat_id;

UPDATE stg_wall_posts
SET expired_ts = NULL
WHERE expired_ts IS NOT NULL
  AND cast("author".id AS varchar) IN (SELECT author_id FROM author_filter)
RETURNING cast(id AS varchar) AS cleared_wall_id;

SELECT 'chat after' AS step,
	count(*) FILTER (WHERE expired_ts IS NULL)::BIGINT AS active,
	count(*) FILTER (WHERE expired_ts IS NOT NULL)::BIGINT AS expired
FROM stg_chat_messages
WHERE cast("fromUser".id AS varchar) IN (SELECT author_id FROM author_filter);

SELECT 'wall after' AS step,
	count(*) FILTER (WHERE expired_ts IS NULL)::BIGINT AS active,
	count(*) FILTER (WHERE expired_ts IS NOT NULL)::BIGINT AS expired
FROM stg_wall_posts
WHERE cast("author".id AS varchar) IN (SELECT author_id FROM author_filter);
