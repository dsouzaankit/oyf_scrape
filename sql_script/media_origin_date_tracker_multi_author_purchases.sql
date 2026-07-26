-- Track approximate wall-post origin date for unlocked (purchased) media, per author.
-- Sources stg_all_unlocks (posts/paid/all: post + message unlocks), not stg_chat_messages.
-- Optional author filter: empty list = all authors; add IDs to restrict.
-- Optional msg text filter: empty list = all unlock messages; add substrings to match (case-insensitive).
-- Optional media_id filter: empty list = all media; add bigint IDs to restrict.
-- Optional origin days filter: null last_n_days = all dates; else approx_origin_date within last N days.

-- await instance.closeSync();
-- await connection.closeSync();
ATTACH 'P:\\all_scripts\\oyf_scrape\\data\\web.db' AS web (TYPE DUCKDB);
USE web;

-- Optional author filter: empty list = all authors; add IDs to restrict.
with author_filter as (
	-- select unnest([]::varchar[]) as author_id
	select unnest(['253745725']) as author_id
	-- select unnest(['180951488']) as author_id
	-- select unnest(['author_id_1', 'author_id_2']) as author_id
)
, msg_text_filter as (
	select unnest([]::varchar[]) as filter_text
	-- select unnest(['bundle', 'sale', 'custom']) as filter_text
)
, media_id_filter as (
	select unnest([]::bigint[]) as media_id
	-- select unnest([4261531034::bigint]) as media_id
)
, origin_days_filter as (
	select null::integer as last_n_days
	-- select 90 as last_n_days
)
, t12 as (
select id unlock_id
, cast(author.id as varchar) author_id
, unlockSource ulk_src
, "text" msg_text
, mediaCount n_media
, price msg_price
, cast(unlockAt as timestamp) unlock_ts
, date(cast(unlockAt as timestamp)) unlock_date
, unnest(media) media
from stg_all_unlocks
where author.id is not null
)
, t1 as (
select unlock_id, author_id, ulk_src, msg_text
, media.id media_id
, msg_price
, cast(media.duration AS int) duration
, n_media
, sum(coalesce(cast(media.duration AS int), 0)) over (
    partition by unlock_id
    rows between unbounded preceding and unbounded following) tot_duration_per_msg
, unlock_ts, unlock_date
from t12
)
, t21 as (
select json_extract_string(author, '$.id') author_id
, cast(postedAt as timestamp) posted_ts
, date(cast(postedAt as timestamp)) posted_date
, id wall_post_id
, "text" wall_text
, price wall_price
, unnest(media) media
from stg_wall_posts
where json_extract_string(author, '$.id') is not null
and expired_ts is null
)
, t22 as (
select author_id
, cast(json_extract_string(media, '$.id') as bigint) media_id
, posted_ts
, max(cast(json_extract_string(media, '$.id') as bigint))
    over (partition by author_id order by posted_ts) max_media_id_yet
, posted_date
from t21
)
, t2 as (
select *
, greatest(media_id, max_media_id_yet) media_id_v2
from t22
)
, t2_intv as (
select author_id, media_id_v2
, coalesce(
	lead(media_id_v2, 1) over (partition by author_id order by media_id_v2, posted_ts),
	99999999999
) next_media_id_v2
, posted_date
from t2
)
, t2_intv_grpd as (
select author_id, posted_date
, min(media_id_v2) first_media_id_v2
, max(next_media_id_v2) last_media_id_v2
from t2_intv
group by author_id, posted_date
)
, wall_media_exact as (
select author_id
, cast(json_extract_string(media, '$.id') as bigint) media_id
, posted_date wall_date
, wall_post_id
, wall_text
, wall_price
from t21
qualify row_number() over (
	partition by author_id, cast(json_extract_string(media, '$.id') as bigint)
	order by posted_ts desc
) = 1
)

select
t1.msg_text
, t1.unlock_date
, t1.ulk_src
, t1.media_id
, t1.duration
, t1.msg_price
, t1.n_media
, round(t1.duration * 1.0 / t1.tot_duration_per_msg, 2) duration_ratio
, coalesce(t2g.posted_date, date '1900-01-01') approx_origin_date
, w.wall_date
, w.wall_price
, w.wall_text
from t1
left join t2_intv_grpd t2g
	on t1.author_id = t2g.author_id
	and t1.media_id >= t2g.first_media_id_v2
	and t1.media_id < t2g.last_media_id_v2
left join wall_media_exact w
	on t1.author_id = w.author_id
	and t1.media_id = w.media_id
where t1.duration > 0
and (
	(select count(*) from author_filter) = 0
	or t1.author_id in (select author_id from author_filter)
)
and (
	(select count(*) from msg_text_filter) = 0
	or exists (
		select 1
		from msg_text_filter f
		where coalesce(t1.msg_text, '') ilike '%' || f.filter_text || '%'
	)
)
and (
	(select count(*) from media_id_filter) = 0
	or t1.media_id in (select media_id from media_id_filter)
)
and (
	(select last_n_days from origin_days_filter) is null
	or coalesce(t2g.posted_date, current_date) >= current_date - (select last_n_days from origin_days_filter)
)
-- One row per unlock message (unlock_id) that contains the media.
qualify row_number() over (partition by t1.author_id, t1.media_id, t1.unlock_id order by unlock_date desc) = 1
order by duration_ratio desc, duration desc
;
