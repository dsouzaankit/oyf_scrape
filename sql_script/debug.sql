ATTACH 'P:\\all_scripts\\oyf_scrape\\data\\web.db' AS web (TYPE DUCKDB);
USE web;

INSERT INTO stg_chat_messages (responseType, text, giphyId, lockedText, isFree, price, isMediaReady, mediaCount, media, previews, isTip, isReportedByMe, isCouplePeopleMedia, queueId, isMarkdownDisabled, fromUser, isFromQueue, canUnsendQueue, unsendSecondsQueue, id, isOpened, isNew, createdAt, changedAt, cancelSeconds, isLiked, canPurchase, canPurchaseReason, canReport, canBePinned, isPinned)

SELECT cm.responseType AS responseType, cm.text AS text, cm.giphyId AS giphyId, cm.lockedText AS lockedText, cm.isFree AS isFree, cm.price AS price, cm.isMediaReady AS isMediaReady, cm.mediaCount AS mediaCount, list_transform(cm.media, m -> struct_pack(
                id := CAST(json_extract(to_json(m), '$.id') AS BIGINT),
                "type" := json_extract_string(to_json(m), '$.type'),
                convertedToVideo := COALESCE(CAST(json_extract(to_json(m), '$.convertedToVideo') AS BOOLEAN), false),
                canView := COALESCE(CAST(json_extract(to_json(m), '$.canView') AS BOOLEAN), false),
                hasError := COALESCE(CAST(json_extract(to_json(m), '$.hasError') AS BOOLEAN), false),
                createdAt := json_extract(to_json(m), '$.createdAt'),
                isReady := COALESCE(CAST(json_extract(to_json(m), '$.isReady') AS BOOLEAN), false),
                duration := COALESCE(CAST(json_extract(to_json(m), '$.duration') AS BIGINT), 0),
                hasCustomPreview := COALESCE(CAST(json_extract(to_json(m), '$.hasCustomPreview') AS BOOLEAN), false)
            )) AS media, cm.previews AS previews, cm.isTip AS isTip, cm.isReportedByMe AS isReportedByMe, cm.isCouplePeopleMedia AS isCouplePeopleMedia, cm.queueId AS queueId, cm.isMarkdownDisabled AS isMarkdownDisabled, cm.fromUser AS fromUser, cm.isFromQueue AS isFromQueue, cm.canUnsendQueue AS canUnsendQueue, cm.unsendSecondsQueue AS unsendSecondsQueue, cm.id AS id, cm.isOpened AS isOpened, cm.isNew AS isNew, cm.createdAt AS createdAt, cm.changedAt AS changedAt, cm.cancelSeconds AS cancelSeconds, cm.isLiked AS isLiked, cm.canPurchase AS canPurchase, cm.canPurchaseReason AS canPurchaseReason, cm.canReport AS canReport, cm.canBePinned AS canBePinned, cm.isPinned AS isPinned
        FROM read_json_auto('P:\all_scripts\oyf_scrape\data\api_out.json', union_by_name=true) cm

                WHERE false
                or cast(cm.createdAt as timestamp) < (
                        select coalesce(min(cast(createdAt as timestamp)), current_localtimestamp() + interval '1' day)
                                from stg_chat_messages where json_extract_string(fromUser, '$.id') = json_extract_string(cm.fromUser, '$.id'))
                or cast(cm.createdAt as timestamp) > (
                        select coalesce(max(cast(createdAt as timestamp)), current_localtimestamp() - interval '99' year)
                                from stg_chat_messages where json_extract_string(fromUser, '$.id') = json_extract_string(cm.fromUser, '$.id'))
                RETURNING 1
                ;


select count(1) 
FROM read_json_auto('P:\all_scripts\oyf_scrape\data\api_out.json', union_by_name=true) cm
where cast(cm.createdAt as timestamp) > (
select coalesce(max(cast(createdAt as timestamp)), current_localtimestamp() - interval '99' year)
from stg_chat_messages where json_extract_string(fromUser, '$.id') = json_extract_string(cm.fromUser, '$.id')
)
;

select count(1) 
FROM read_json_auto('P:\all_scripts\oyf_scrape\data\api_out.json', union_by_name=true)
where json_extract_string(fromUser, '$.id') = '253745725'
;

select 
id, text, createdAt
-- coalesce(max(cast(createdAt as timestamp)), current_localtimestamp() - interval '99' year)
from stg_chat_messages
where json_extract_string(fromUser, '$.id') = '253745725'
and date(createdAt) >= '2026-07-04'
and id = '10280119325375'
;

WITH keep_ts AS (
    SELECT DISTINCT extract_ts FROM media_dim_history
    ORDER BY extract_ts DESC LIMIT 5
)
DELETE FROM media_dim_history
WHERE extract_ts NOT IN (SELECT extract_ts FROM keep_ts);
select count(1) from media_dim_history;

SELECT 
    table_name, 
    estimated_size AS row_count, 
    column_count, 
    index_count 
FROM duckdb_tables();
