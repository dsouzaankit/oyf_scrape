-- await instance.closeSync();
-- await connection.closeSync();
-- ATTACH 'Z:\\STUDY\\web_scrape\\data\\web.db';
ATTACH 'C:/Users/dsouzaankit/Downloads/web_scrape/dbt/data/web.db';
USE web;
-- .cd Z:\\STUDY\\web_scrape\\data
-- ATTACH 'ducklake:my_ducklake.ducklake' AS my_ducklake (DATA_PATH 'Z:\\STUDY\\web_scrape\\data');
-- USE my_ducklake;

-- INSTALL ducklake;
-- LOAD ducklake;
-- .open Z:\\STUDY\\web_scrape\\data\\web.db
-- ATTACH 'Z:\\STUDY\\web_scrape\\data\\web.db';
-- USE web;
-- ATTACH 'ducklake:my_ducklake.ducklake' AS my_ducklake (DATA_PATH 'Z:\\STUDY\\web_scrape\\data');
-- USE my_ducklake;
-- CREATE TABLE my_ducklake.media_dim AS SELECT * FROM web.media_dim_v2;
-- CREATE TABLE my_ducklake.stg_chat_messages AS SELECT * FROM web.stg_chat_messages;
-- CREATE TABLE my_ducklake.stg_wall_posts AS SELECT * FROM web.stg_wall_posts;
-- DETACH web;
.tables


SET file_search_path = 'Z:/STUDY/web_scrape';

CREATE TABLE IF NOT EXISTS stg_chat_messages AS SELECT * FROM read_json_auto('data/samples/api_chat_messages.json');
-- TRUNCATE stg_chat_messages;
desc stg_chat_messages;

-- DROP TABLE stg_wall_posts;
CREATE TABLE IF NOT EXISTS stg_wall_posts AS SELECT * FROM read_json_auto('data/samples/api_wall_posts.json');
-- TRUNCATE stg_wall_posts;
-- ALTER TABLE stg_wall_posts RENAME TO stg_wall_posts_old1;
-- CREATE TABLE stg_wall_posts AS SELECT * FROM stg_wall_posts_old1;
desc stg_wall_posts;


-- DROP TABLE IF EXISTS media_dim;
CREATE TABLE IF NOT EXISTS media_dim (
    -- Surrogate Key: Unique identifier for each record version
    -- author_media_scd_key BIGINT PRIMARY KEY,

    -- Natural Key: The business identifier (e.g., from the source system)
    author_id VARCHAR NOT NULL,
    media_id VARCHAR NOT NULL,
    media_duration int,
    media_blob VARCHAR NOT NULL,
    -- Dimension Attributes: Columns that may change over time
    seen_count integer,

    -- SCD Type 2 Tracking Columns
    valid_from_ts TIMESTAMP NOT NULL, -- Start date when this version was valid
    valid_to_ts TIMESTAMP,           -- End date when this version was valid (NULL for current)
    is_current BOOLEAN NOT NULL,   -- Flag for the active/current record

    -- , UNIQUE (media_id, author_id, valid_from_ts)
    extract_ts TIMESTAMP
);

-- DROP TABLE IF EXISTS dbt_media_dim;
CREATE TABLE IF NOT EXISTS dbt_media_dim (
    -- Surrogate Key: Unique identifier for each record version
    -- author_media_scd_key BIGINT PRIMARY KEY,

    -- Natural Key: The business identifier (e.g., from the source system)
    author_id VARCHAR NOT NULL,
    media_id VARCHAR NOT NULL,
    media_duration int,
    media_blob VARCHAR NOT NULL,
    -- Dimension Attributes: Columns that may change over time
    seen_count integer,

    -- SCD Type 2 Tracking Columns
    valid_from_ts TIMESTAMP NOT NULL, -- Start date when this version was valid
    valid_to_ts TIMESTAMP,           -- End date when this version was valid (NULL for current)
    is_deleted BOOLEAN NOT NULL,    -- Flags records deleted from source
    is_current BOOLEAN NOT NULL,   -- Flag for the active/current record

    -- , UNIQUE (media_id, author_id, valid_from_ts)
    extract_ts TIMESTAMP,
    checksum VARCHAR
);

-- DROP TABLE IF EXISTS media_dim_history;
CREATE TABLE IF NOT EXISTS media_dim_history (
    -- Surrogate Key: Unique identifier for each record version
    -- author_media_scd_key BIGINT PRIMARY KEY,
    
    -- Natural Key: The business identifier (e.g., from the source system)
    author_id VARCHAR NOT NULL,
    media_id VARCHAR NOT NULL,
    media_duration int,
    media_blob VARCHAR NOT NULL,
    -- Dimension Attributes: Columns that may change over time
    seen_count integer,

    -- SCD Type 2 Tracking Columns
    valid_from_ts TIMESTAMP NOT NULL, -- Start date when this version was valid
    valid_to_ts TIMESTAMP,           -- End date when this version was valid (NULL for current)
    is_current BOOLEAN NOT NULL,   -- Flag for the active/current record

    -- , UNIQUE (media_id, author_id, valid_from_ts)
    extract_ts TIMESTAMP
);

-- DROP TABLE IF EXISTS dbt_media_dim_history;
CREATE TABLE IF NOT EXISTS dbt_media_dim_history (
    -- Surrogate Key: Unique identifier for each record version
    -- author_media_scd_key BIGINT PRIMARY KEY,

    -- Natural Key: The business identifier (e.g., from the source system)
    author_id VARCHAR NOT NULL,
    media_id VARCHAR NOT NULL,
    media_duration int,
    media_blob VARCHAR NOT NULL,
    -- Dimension Attributes: Columns that may change over time
    seen_count integer,

    -- SCD Type 2 Tracking Columns
    valid_from_ts TIMESTAMP NOT NULL, -- Start date when this version was valid
    valid_to_ts TIMESTAMP,           -- End date when this version was valid (NULL for current)
    is_deleted BOOLEAN NOT NULL,    -- Flags records deleted from source
    is_current BOOLEAN NOT NULL,   -- Flag for the active/current record

    -- , UNIQUE (media_id, author_id, valid_from_ts)
    extract_ts TIMESTAMP,
    checksum VARCHAR
);

-- ALTER TABLE media_dim RENAME TO media_dim_old1;
-- CREATE TABLE media_dim AS SELECT * FROM media_dim_old1;
-- ALTER TABLE media_dim RENAME TO media_dim_old2;
-- CREATE TABLE media_dim AS SELECT * FROM media_dim_old2;
-- ALTER TABLE media_dim RENAME TO media_dim_scd_v1;
-- CREATE TABLE media_dim AS SELECT * FROM media_dim_scd_v1;
-- SELECT COUNT(1) FROM media_dim;
-- TRUNCATE TABLE media_dim;

-- CREATE OR REPLACE TABLE dbt_media_dim AS (select * from media_dim);
-- TRUNCATE dbt_media_dim;
-- CREATE OR REPLACE TABLE dbt_media_dim_history AS (select * from media_dim_history);
-- TRUNCATE dbt_media_dim_history;

-- ALTER TABLE src_media_dim RENAME TO src1;
-- CREATE TABLE src_media_dim AS SELECT * FROM src1;
-- TRUNCATE TABLE src1;




-- use below as proxy to unlock web.db!
ATTACH 'Z:\\STUDY\\web_scrape\\data\\web_test.db';
USE web_test;
DETACH web;
-- instance = await DuckDBInstance.create(dbPath);
