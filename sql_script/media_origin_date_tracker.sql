-- await instance.closeSync();
-- await connection.closeSync();
ATTACH 'P:\\all_scripts\\oyf_scrape\\data\\web.db' AS web (TYPE DUCKDB);
USE web;


with t12 as (
select id chat_id
, json_extract_string(fromUser, '$.id') author_id
, mediaCount media_count
, price msg_price
, cast(createdAt as timestamp) created_ts
, date(cast(createdAt as timestamp)) created_date
, unnest(media) media
from stg_chat_messages
)
, t1 as (
select chat_id, author_id
, cast(json_extract_string(media, '$.id') as bigint) media_id
, msg_price
, cast(json_extract_string(media, '$.duration') AS int) media_duration
, media_count
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
, unnest(media) media
from stg_wall_posts
)
, t22 as (
select author_id
, cast(json_extract_string(media, '$.id') as bigint) media_id
, posted_ts
, max(cast(json_extract_string(media, '$.id') as bigint))
    over (order by posted_ts) max_media_id_yet
, posted_date
from t21
)
, t2 as (
select *
-- construct monotonically increasing sequence of wall post media_ids and use as proxy for chat media recency
, greatest(media_id, max_media_id_yet) media_id_v2
from t22
)
, t2_intv as (
select author_id, media_id_v2
, coalesce(lead(media_id_v2, 1) over (order by media_id_v2, posted_ts), 99999999999) next_media_id_v2
, posted_date
from t2
)
, t2_intv_grpd as (
select author_id, posted_date
, min(media_id_v2) first_media_id_v2, max(next_media_id_v2) last_media_id_v2
from t2_intv
group by 1,2
)

select
--*
t1.created_date, t1.media_id, t1.media_duration, t1.msg_price
, t1.media_count, round(t1.media_duration * 1.0 / t1.tot_duration_per_msg, 2) duration_ratio
--, t1.tot_duration_per_msg tot_durtn_per_msg
, t2g.posted_date approx_origin_date
--, t2g.first_media_id_v2, t2g.last_media_id_v2
--count(1) n_rows, count(distinct row(t1.media_id, t1.created_ts)) n_messages
from t1 left join t2_intv_grpd t2g
--from t2_intv_grpd
on t1.media_id >= t2g.first_media_id_v2 and t1.media_id < t2g.last_media_id_v2
where year(t2g.posted_date) >= 2025
-- filter for videos
and t1.media_duration > 0
--and media_id = 4261547299
--where posted_date between date '2025-12-01' and date '2026-01-31'
-- One row per message (chat_id) that contains the media; re-sent media in newer messages still appears on both rows.
qualify row_number() over (partition by t1.author_id, t1.media_id, t1.chat_id order by created_date desc) = 1
order by duration_ratio desc, media_duration desc
--order by created_date desc
;
