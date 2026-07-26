-- Track approximate wall-post origin date for chat media, per author.
-- Supports multiple author_id values: windows and joins are partitioned by author_id.
-- author name can be tracked from config.env
-- Optional author filter: empty list = all authors; add IDs to restrict.
-- Optional msg text filter: empty list = all messages; add substrings to match (case-insensitive).
-- Optional media_id filter: empty list = all media; add bigint IDs to restrict.
-- Optional origin days filter: null last_n_days = all dates; else approx_origin_date within last N days.
-- Excludes media_id values present in stg_chat_unlocks (paid chat purchases).

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
	-- select unnest(['2 free SVIP'
	--     , 'FREE VIP LIVE PASS'
	-- 	, 'BESTSELLERS OF ALL TIME'
	--     , 'if you want the full'
	-- 	, 'ever gotten this nasty'
	--   ]) as filter_text
	-- select unnest(['bundle', 'sale', 'custom']) as filter_text
)
, media_id_filter as (
	select unnest([]::bigint[]) as media_id
	-- select unnest([4243934481::bigint]) as media_id
	-- select unnest([4261547299::bigint, 1234567890::bigint]) as media_id
)
, origin_days_filter as (
	select null::integer as last_n_days
	-- select 90 as last_n_days
)
, unlocked_media as (
	select distinct cast(json_extract_string(media, '$.id') as bigint) as media_id
	from (
		select unnest(media) media
		from stg_chat_unlocks
	)
	where media is not null
)
, t12 as (
select id chat_id
, json_extract_string(fromUser, '$.id') author_id
, "text" msg_text
, mediaCount n_media
, price msg_price
, cast(createdAt as timestamp) created_ts
, date(cast(createdAt as timestamp)) created_date
, unnest(media) media
from stg_chat_messages
where json_extract_string(fromUser, '$.id') is not null
and expired_ts is null
)
, t1 as (
select chat_id, author_id, msg_text
, cast(json_extract_string(media, '$.id') as bigint) media_id
, msg_price
, cast(json_extract_string(media, '$.duration') AS int) duration
, n_media
, sum(coalesce(cast(json_extract_string(media, '$.duration') AS int), 0)) over (
    partition by chat_id
    rows between unbounded preceding and unbounded following) tot_duration_per_msg
, created_ts, created_date
from t12
)
, t21 as (
select json_extract_string(author, '$.id') author_id
, cast(postedAt as timestamp) posted_ts
, date(cast(postedAt as timestamp)) posted_date
, id wall_post_id
, "text" wall_text
, tipsAmount wall_price
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
-- Exact wall post for this media_id (if the clip also appears on the wall). Latest post wins.
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
, t1.created_date, t1.media_id, t1.duration, t1.msg_price
, t1.n_media, round(t1.duration * 1.0 / t1.tot_duration_per_msg, 2) duration_ratio
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
and not exists (
	select 1 from unlocked_media u where u.media_id = t1.media_id
)
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
-- One row per message (chat_id) that contains the media; re-sent media in newer messages still appears on both rows.
qualify row_number() over (partition by t1.author_id, t1.media_id, t1.chat_id order by created_date desc) = 1
order by duration_ratio desc, duration desc
;

