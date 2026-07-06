// comment wall posts scrape during chat messages scrape and vice versa!
// this is scd type 4 => scd type 2 + history dim table
// duckdb-cli read and nodejs write connection cannot open in parallel! (duckdb.org/docs/stable/connect/concurrency)
// do not import setTimeout from 'timers/promises' with puppeteer, to avoid noisy errors!
// drop missing, bulky fields (files, videoSources, isMarkdownDisabled) from inferred json schema for efficiency!
// multiple calls to DuckDBInstance.create(...) raises exception!
// sample data for initial schema inference: 'Chromium devtools > Filtered Fetch/XHR > Preview > 'list:' (inner) > Copy object'
// install node packages and run script from C:\Users\...\Downloads\web_scrape\node_scrape
// npm install @duckdb/node-api
// npm install dotenv
// leftmost web tab is the active one!
// chat thread url is less protected against bots than wall post and home page urls
//   , so prefer chat thread for initial login (attempt twice)!
// don't minimize web browser during scrape (restoring, backgrounding is ok)!
// manually verify and enable remote debugging at chrome://inspect/#remote-debugging
// verify full chromium command args at chrome://version/
/*
Issues, TBD:
detech an update based on json payload checksum mismatch, and store history in media_dim   x
test multiple author_id     x not needed
track message price changes relevant to a set of media_ids (extract chat msg price)   x no direct linkage to media_id
add/push total duration of vids in chat, chat media count to each media record?   x not needed
add dbt test cases  x
track deletes   x
ducklake for parallel read & write connections -- not possible with duckdb, ducklake also slower    x
sql logic to map chat media_id to its time band, based off wall post media_id   x
dedupe at elt end   x not needed
support stopping scroll after most recent watermark is reached for incremental load     x
wall post field missing before Sep 15, 2024!		x   json field trim, parse long-standing & needed fields
Table "stg_wall_posts" does not have a column with name "linkedPosts", 2023-09-12       x ignore old rare edge cases
Latest posts, messages scrape				x
Oldest chat message schema mismatch			x json field trim, parse long-standing & needed fields
Post page scrape					        x
*/

const fs1 = require('fs').promises;
async function createFolderIfNotExists(filePath) {
  const folderPath = path.dirname(filePath);
  try {
    await fs1.mkdir(folderPath, { recursive: true });
    console.log(`Directory ensured: ${folderPath}`);
  } catch (error) {
    // This catch block will only execute for actual errors, 
    // not if the directory already exists (due to recursive: true).
    console.error(`Error creating directory: ${error.message}`);
  }
}

const fs1 = require('fs').promises;
const path = require('path');
const urlCache = new Map();
homeDirectory = 'Z:\\STUDY\\web_scrape';
const browserStateDataFolder = path.join(homeDirectory, 'data\\testChromeSession');
credsPath = path.join(homeDirectory, 'data\\creds.env');
require('dotenv').config({path: credsPath});
apiOpFile = path.join(homeDirectory, 'data\\api_out.json');
const { Writable } = require('stream');
// Define the log file path with a dynamic timestamp in its name (optional)
logsFolder = path.join(homeDirectory, 'logs');
// windows filenames cannot contain ':' for below!
logFilePath = path.join(logsFolder, `error_log_${new Date().toISOString().replaceAll(":", "")}.log`);
await createFolderIfNotExists(logFilePath);
// Create a writable stream to a file
errorLogStream = fs.createWriteStream(logFilePath, { flags: 'a' });
// Overload console.error to write to file and console
// w/o the const, console.error(...) to file o/p results in infinite recursion on re-run
const originalError = console.error;
console.error = function() {
    args = Array.from(arguments);
    logMessage = args.join(' ');
    // Write to the file stream
    errorLogStream.write(logMessage);
    // Also call the original console.error to display in the console (optional)
    originalError.apply(console, arguments);
};

await createFolderIfNotExists(browserStateDataFolder);
// const puppeteer = require('puppeteer');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
// enable gui to debug (more cpu load)!

browser = await puppeteer.launch({
	headless: false,
//    args: ['--remote-debugging-port=0'],      // doesn't seem to work!
    args: ['--mute-audio'],			// Mutes all audio output from the browser instance
//    args: ['--no-sandbox'],          // use if headless
    userDataDir: browserStateDataFolder	// This directory will store the state and minimize login attempts
    });

// Retrieve the WebSocket endpoint URL
wsEndpointUrl = browser.wsEndpoint();
console.log(`WebSocket Endpoint URL: ${wsEndpointUrl}`);
// Connect Puppeteer to the existing browser instance
browser = await puppeteer.connect({
    browserWSEndpoint: wsEndpointUrl,
    defaultViewport: null // Optional: use the browser's current viewport
});

async function clearOldTabs(browser) {
    let pages = await browser.pages();
    while (pages.length > 1) {
        await pages[pages.length - 1].close();
        pages = await browser.pages();
    }
    page = pages[0] || await browser.newPage();
    await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
    console.log('Cleared old tabs; using a single fresh page.');
    return page;
}

// no-gui browser (default)
// browser = await puppeteer.launch({ userDataDir: browserStateDataFolder });
// const page = await browser.newPage();
// Retrieve the default blank page
page = await clearOldTabs(browser);

// automated login to generate cookies
async function attemptLogin() {
    try {
        await page.waitForSelector('input[type="email"]', { timeout: 15000 });
        await page.type('input[type="email"]', process.env.of_usern);
        await page.type('input[name="password"]', process.env.of_paswd);
        await page.click('button[type="submit"]');
    } catch (error) {
      console.log('One or more login inputs not loaded. Assuming an active session and skipping login!');
    }
}

// await attemptLogin();

async function attemptLoginSubmit() {
    try {
	    await page.waitForSelector('button[type="submit"]', { timeout: 15000 });
        // add delay??
        await page.click('button[type="submit"]');
    } catch (error) {
      console.log('One or more login inputs not loaded. Assuming an active session and skipping login!');
    }
}

// await attemptLoginSubmit();

// Create an in-memory database instance (or provide a file path for persistence)
dbPath = path.join(homeDirectory, 'data\\web.db');
let { DuckDB } = await import('@duckdb/node-api');
let { DuckDBInstance } = await import("@duckdb/node-api");
// instance = await DuckDBInstance.create(dbPath);
// instance = await DuckDBInstance.fromCache(dbPath);

	/* duckdb DDL and debug
	const path = require('path');
	tableName = 'stg_chat_messages';
	// homeDirectory = 'C:\\Users\\dsouzaankit\\Downloads\\duckdb_cli-windows-amd64';
	homeDirectory = 'Z:\\STUDY\\of_scrape';
	apiOpFile = path.join(homeDirectory, 'data\\api_out.json');
	filePath = apiOpFile;

	dbPath = path.join(homeDirectory, 'data\\of.db');
	let { DuckDB } = await import('@duckdb/node-api');
	let { DuckDBInstance } = await import("@duckdb/node-api");
	instance = await DuckDBInstance.create(dbPath);
	connection = await instance.connect();
	
	// sql0 = `CREATE TABLE IF NOT EXISTS stg_chat_messages AS SELECT * FROM read_json_auto('${filePath}');`
    // await connection.run(sql0);

    // reader = await connection.runAndReadAll(`SELECT COUNT(1) cnt FROM ${tableName}`);
	// rows = reader.getRowsJson();
    // console.log(`Table "${tableName}" has ${rows[0][0]} rows.`);

	// await connection.run(`CHECKPOINT`);
	
	schemaResult = await connection.runAndReadAll(`DESCRIBE ${tableName}`);
    tgtColsStr = schemaResult.getRowsJson().map(col => col[0]).join(', ');
	reader = await connection.runAndReadAll(`SELECT ${tgtColsStr} FROM ${tableName} limit 1`);
	rows = reader.getRowsJson();
	console.log(`${rows}`);
	*/

async function getTgtColsStr(tableName) {
    schemaResult = await connection.runAndReadAll(`DESCRIBE ${tableName}`);
    tgtColsStr = schemaResult.getRows().map(col => col[0]).join(', ');
    return tgtColsStr;
}

async function getJsonCols(connection, filePath) {
    schemaResult = await connection.runAndReadAll(
        `DESCRIBE SELECT * FROM read_json_auto('${filePath}', union_by_name=true) LIMIT 0`
    );
    return new Set(schemaResult.getRows().map(col => col[0]));
}

function buildMediaSelectExpr(jsonAlias) {
    return `list_transform(${jsonAlias}.media, m -> struct_pack(
                id := CAST(json_extract(to_json(m), '$.id') AS BIGINT),
                "type" := json_extract_string(to_json(m), '$.type'),
                convertedToVideo := COALESCE(CAST(json_extract(to_json(m), '$.convertedToVideo') AS BOOLEAN), false),
                canView := COALESCE(CAST(json_extract(to_json(m), '$.canView') AS BOOLEAN), false),
                hasError := COALESCE(CAST(json_extract(to_json(m), '$.hasError') AS BOOLEAN), false),
                createdAt := json_extract(to_json(m), '$.createdAt'),
                isReady := COALESCE(CAST(json_extract(to_json(m), '$.isReady') AS BOOLEAN), false),
                duration := COALESCE(CAST(json_extract(to_json(m), '$.duration') AS BIGINT), 0),
                hasCustomPreview := COALESCE(CAST(json_extract(to_json(m), '$.hasCustomPreview') AS BOOLEAN), false)
            )) AS media`;
}

async function getTgtInsertParts(connection, tableName, jsonAlias, filePath) {
    schemaResult = await connection.runAndReadAll(`DESCRIBE ${tableName}`);
    tableRows = schemaResult.getRows();
    colList = tableRows.map(col => col[0]).join(', ');
    jsonCols = filePath ? await getJsonCols(connection, filePath) : null;
    selectStr = tableRows.map(col => {
        const colName = col[0];
        if (colName === 'media') {
            if (jsonCols && !jsonCols.has('media')) {
                return `NULL AS ${colName}`;
            }
            return buildMediaSelectExpr(jsonAlias);
        }
        if (jsonCols && !jsonCols.has(colName)) {
            return `NULL AS ${colName}`;
        }
        return `${jsonAlias}.${colName} AS ${colName}`;
    }).join(', ');
    return { colList, selectStr };
}

async function getTgtSelectExpr(connection, tableName, jsonAlias, filePath) {
    parts = await getTgtInsertParts(connection, tableName, jsonAlias, filePath);
    return parts.selectStr;
}

function trimMediaBlob(mediaItem) {
    const {
        id, type, convertedToVideo, canView, hasError, createdAt, isReady, duration, hasCustomPreview
    } = mediaItem;
    return {
        id, type, convertedToVideo, canView, hasError, createdAt, isReady, duration, hasCustomPreview
    };
}

function trimChatListForDb(list) {
    return list.map(msg => ({
        ...msg,
        media: (msg.media || []).map(trimMediaBlob),
    }));
}

function trimWallPostListForDb(list) {
    return list.map(post => {
        const { isMarkdownDisabled, fundRaising, linkedPosts, ...rest } = post;
        return {
            ...rest,
            media: (post.media || []).map(trimMediaBlob),
        };
    });
}

async function queryRows(connection, tableName) {
    // Query rows in the updated table
    reader = await connection.runAndReadAll(`SELECT COUNT(1) cnt FROM ${tableName}`);
    rows = reader.getRows();
    console.log(`Table "${tableName}" has ${rows[0][0]} rows.`);
}

/**
 * Converts a JavaScript Date object to a MySQL DATETIME format string (UTC).
 * Format: "YYYY-MM-DD HH:mm:ss"
 * @param {Date} dateObj The JavaScript Date object to convert.
 * @returns {string} The formatted date string.
 */
function jsDateToSqlDatetime(dateObj) {
  // Use toISOString() to get UTC time in ISO format ("YYYY-MM-DDTHH:mm:ss.sssZ")
  const isoString = dateObj.toISOString();
  // Slice the string to remove milliseconds and the 'Z' (UTC indicator)
  // The first 19 characters cover "YYYY-MM-DDTHH:mm:ss"
  const dateWithoutT = isoString.slice(0, 19);
  // Replace the 'T' separator with a space ' '
  const sqlDatetime = dateWithoutT.replace('T', ' ');
  return sqlDatetime;
}

async function refreshSrcMediaDim(connection, runDatetime) {
    try {
        runDtUtcSql = jsDateToSqlDatetime(runDatetime);
        refreshSrcMediaDimSql = `
        CREATE OR REPLACE TABLE src_media_dim AS
        WITH src0 as (
        --  SELECT json_extract_string(fromUser, '$.id') author_id
        SELECT fromUser.id author_id
        , unnest(media) media_blob
        , 1 as seen_count
        , cast(createdAt as timestamp) valid_from_ts
        , null as valid_to_ts
        , true as is_current
        , timestamp '${runDtUtcSql}' AT TIME ZONE 'UTC' AT TIME ZONE 'US/Eastern' extract_ts
        -- FROM read_json_auto('\${filePath}')
        FROM stg_chat_messages
		WHERE cast(createdAt as timestamp) <= timestamp '${runDtUtcSql}' + interval '1' day
		and (
		cast(createdAt as timestamp) < (
			select coalesce(min(valid_from_ts), timestamp '${runDtUtcSql}' + interval '1' day)
				from media_dim where author_id = json_extract_string(stg_chat_messages.fromUser, '$.id'))
		or cast(createdAt as timestamp) > (
			select coalesce(max(valid_from_ts), timestamp '${runDtUtcSql}' - interval '99' year)
				from media_dim where author_id = json_extract_string(stg_chat_messages.fromUser, '$.id'))
        )
        )
        , src1 as (
        SELECT author_id
        -- extract all fields in the same json parse
        , json_extract(media_blob, ['id', 'duration']) needed_fields
        , media_blob
        , seen_count, valid_from_ts, valid_to_ts, is_current
        , extract_ts
        FROM src0
        )
        SELECT distinct author_id
        , needed_fields[1] media_id
        , needed_fields[2] media_duration
        , media_blob
        , seen_count, valid_from_ts, valid_to_ts, is_current
        , extract_ts
        FROM src1
        `;
        await connection.run(refreshSrcMediaDimSql);
        console.log(`Refreshed incremental media_dim source!`);
        await queryRows(connection, 'src_media_dim');
    } catch(error) {
        console.error("\nError refreshing src_media_dim:", error);
    }
}

async function updateMediaDimHist(connection) {
    try {
        refreshMediaDimSql = `
        BEGIN TRANSACTION;

        -- 1. Create a temporary table holding the PERFECTLY recalculated history
        -- ONLY for the media_ids you just scraped.
        CREATE TEMP TABLE recalculated_history AS
        WITH combined_data AS (
            -- A. Get all EXISTING history for the items in our current scrape batch
            SELECT md.author_id, md.media_id, md.media_duration, md.media_blob, md.valid_from_ts, md.extract_ts
            FROM media_dim md
            INNER JOIN (SELECT DISTINCT author_id, media_id FROM src_media_dim) s
                ON md.author_id = s.author_id AND md.media_id = s.media_id
            UNION
            -- B. Combine it with the NEW/BACKFILLED data we just scraped
            SELECT author_id, media_id, media_duration, media_blob, valid_from_ts, extract_ts
            FROM src_media_dim
        ),
        windowed_logic AS (
            SELECT
                author_id,
                media_id,
                media_duration,
                media_blob,
                valid_from_ts,
                -- Automatically count how many times we've seen this historically
                ROW_NUMBER() OVER(PARTITION BY author_id, media_id ORDER BY valid_from_ts ASC) AS seen_count,
                -- LEAD perfectly finds the next chronological date, regardless of insertion order
                LEAD(valid_from_ts) OVER (PARTITION BY author_id, media_id ORDER BY valid_from_ts ASC) AS valid_to_ts,
                extract_ts
            FROM combined_data
        )
        SELECT
            *,
            -- If there is no "next" date, it is the current record
            CASE WHEN valid_to_ts IS NULL THEN true ELSE false END AS is_current
        FROM windowed_logic;

        -- 2. Delete the old, messy history for these specific items from your target table
        DELETE FROM media_dim
        WHERE EXISTS (
            SELECT 1 FROM src_media_dim src
            WHERE src.author_id = media_dim.author_id
              AND src.media_id = media_dim.media_id
        );

        -- 3. Insert the cleanly recalculated history
        INSERT INTO media_dim BY NAME
        SELECT * FROM recalculated_history;

        -- 4. Append to history table
        INSERT INTO media_dim_history BY NAME
        SELECT * FROM media_dim;

        -- 5. Clean up
        DROP TABLE recalculated_history;

        COMMIT;
        `;
        await connection.run(refreshMediaDimSql);
        console.log(`Refreshed media_dim!`);
        await queryRows(connection, 'media_dim');
        await queryRows(connection, 'media_dim_history');
    } catch(error) {
        console.error("\nError refreshing media_dim:", error);
        await connection.run(`ROLLBACK;`);
    }
}

// doesn't dedupe and process src data during backfill!
async function refreshMediaDimOld(filePath, connection, runDate) {
    try {
        createSrcViewSql = `
        -- DROP Table IF EXISTS src;
        CREATE OR REPLACE TABLE src_media_dim AS
        with src0 as (
        --  SELECT json_extract_string(fromUser, '$.id') author_id
        SELECT fromUser.id author_id
        , unnest(media) media_blob
        , 1 as seen_count
        , cast(createdAt as timestamp) valid_from_ts
        , null as valid_to_ts
        , true as is_current
        -- FROM read_json_auto('${filePath}')
        FROM stg_chat_messages
		WHERE cast(createdAt as timestamp) <= date '${runDate}' + interval '1' day
		and (
		cast(createdAt as timestamp) < (
			select coalesce(min(valid_from_ts), date '${runDate}' + interval '1' day)
				from media_dim)
		or cast(createdAt as timestamp) > (
			select coalesce(max(valid_from_ts), date '${runDate}' - interval '99' year)
				from media_dim)
        )
        )
        , src1 as (
        SELECT author_id
        -- extract all fields in the same json parse
        , json_extract(media_blob, ['id', 'duration']) needed_fields
        , media_blob
        , seen_count, valid_from_ts, valid_to_ts, is_current
        FROM src0
        )
        SELECT distinct author_id
        , needed_fields[1] media_id
        , needed_fields[2] media_duration
        , media_blob
        , seen_count, valid_from_ts, valid_to_ts, is_current
        FROM src1
        `;
        await connection.run(createSrcViewSql);
        console.log(`Loaded incremental source table!`);
        await queryRows(connection, 'src_media_dim');

//        await connection.run(`BEGIN TRANSACTION;`);
        mergeDimSql = `
        MERGE INTO media_dim tgt
        USING src_media_dim src
        ON tgt.author_id = src.author_id and tgt.media_id = src.media_id

        WHEN MATCHED AND (
            -- below is future use case
            -- tgt.media_duration <> src.media_duration
            src.valid_from_ts > tgt.valid_from_ts
            and tgt.is_current
        ) THEN UPDATE SET
            valid_to_ts = src.valid_from_ts,
            is_current = false
        WHEN MATCHED AND (
            src.valid_from_ts <= tgt.valid_from_ts
        ) THEN UPDATE SET
            seen_count = tgt.seen_count + 1

        WHEN NOT MATCHED BY TARGET THEN INSERT (
            author_id, media_id, media_duration, media_blob
            , seen_count
            , valid_from_ts, valid_to_ts
            , is_current)
        VALUES (
        --    src.*
        src.author_id, src.media_id, src.media_duration, src.media_blob
        , src.seen_count
        , src.valid_from_ts, src.valid_to_ts
        , src.is_current
        )
        RETURNING merge_action;
        -- TRUNCATE media_dim;
        `;
        reader = await connection.runAndReadAll(mergeDimSql);
        insertedOnMerge = reader.getRows().map(elt => elt[0]).includes('INSERT');

        postMergeMatchInsertDimSql = `
        -- insert new current versions for matched src rows, in tgt
        -- needed when matched with tgt, irrespective of src having newer or older data!
        INSERT INTO media_dim
        SELECT author_id, media_id
            , media_duration, media_blob
            , seen_count
            , valid_from_ts
            , valid_to_ts
            , is_current
        FROM (
            SELECT src.author_id, src.media_id
            , src.media_duration, src.media_blob
            -- src can either be the newest (daily) or oldest (backfill using recent-first api) of all record updates
            , case when src.valid_from_ts > tgt.valid_from_ts then (tgt.seen_count + 1) else 1 end seen_count
            , src.valid_from_ts
            , case when src.valid_from_ts > tgt.valid_from_ts then null
                else last_value(tgt.valid_from_ts) over (partition by tgt.media_id, tgt.author_id
                                                    ORDER BY tgt.valid_from_ts desc)
                end valid_to_ts
            , case when src.valid_from_ts > tgt.valid_from_ts then true else false end is_current
            , tgt.valid_from_ts tgt_valid_from_ts
            FROM src_media_dim src inner join media_dim tgt
            ON tgt.author_id = src.author_id and tgt.media_id = src.media_id
        ) QUALIFY row_number() OVER (PARTITION BY media_id, author_id ORDER BY tgt_valid_from_ts desc) = 1;
        `;

        if (!insertedOnMerge) {
            console.log(`Updated media_dim on match! Attempting insertion shortly`);
            await connection.run(postMergeMatchInsertDimSql);
            await queryRows(connection, 'media_dim');
        } else {
            console.log(`Inserted fresh rows in media_dim during initial merge!`);
            await queryRows(connection, 'media_dim');
        }
//        await connection.run(`COMMIT;`);
    } catch(error) {
        console.error("\nError refreshing media_dim:", error);
        await connection.run(`ROLLBACK;`);
    }
}

async function loadChatToDb(filePath, tableName, runDatetime) {
    connection = await instance.connect();
    try {
	    insertParts = await getTgtInsertParts(connection, tableName, 'cm', filePath);
        // Read json file and insert into pre-existing table
        insertTableSql = `INSERT INTO ${tableName} (${insertParts.colList}) SELECT ${insertParts.selectStr}
        FROM read_json_auto('${filePath}', union_by_name=true) cm
		-- QUALIFY row_number() OVER (PARTITION BY id) = 1
		WHERE false
		or cast(cm.createdAt as timestamp) < (
			select coalesce(min(cast(createdAt as timestamp)), current_localtimestamp() + interval '1' day)
				from ${tableName} where json_extract_string(fromUser, '$.id') = json_extract_string(cm.fromUser, '$.id'))
		or cast(cm.createdAt as timestamp) > (
			select coalesce(max(cast(createdAt as timestamp)), current_localtimestamp() - interval '99' year) 
				from ${tableName} where json_extract_string(fromUser, '$.id') = json_extract_string(cm.fromUser, '$.id'))
		RETURNING 1
		;`;
        reader = await connection.runAndReadAll(insertTableSql);
        let insertCount = 0;
        insertCount = reader.getRows().length;
        // await connection.run(createTableSql);
        console.log(`Successfully loaded ${insertCount} rows into table "${tableName}"`);
        await queryRows(connection, tableName);
//        if (insertCount > 0) {
//            console.log('Refreshing media_dim with new data!')
//        }
//        else {
//            console.log('No new data received from API. Skipping media_dim refresh and requesting auto-scroll termination!')
//        }
        await refreshSrcMediaDim(connection, runDatetime);
        await updateMediaDimHist(connection);
        return insertCount;
    } catch (error) {
        console.error("\nError loading chat JSON into DuckDB:", error);
        // console.error('\nFull json response on error:\n', jsonResp);
        return 0;
    } finally {
        // Close the connection and database
        await connection.disconnectSync();
        // returning here gives: Uncaught TypeError: Chaining cycle detected for promise
        // return insertCount;
    }
}

async function scrollUpChat() {
    scrollableSelector = '.b-chats__scrollbar'; // Replace with your element's selector

    // Wait for the element to be present
    await page.waitForSelector(scrollableSelector);

    // Scroll the element up by 100 pixels using page.evaluate()
    await page.evaluate((selector, pixelsToScrollUp) => {
        const element = document.querySelector(selector);
        if (element) {
            // To scroll up, subtract from the current scrollTop position
            element.scrollTop -= pixelsToScrollUp;
        } else {
            console.error(`Cannot find selector ${selector}`);
        }
    }, scrollableSelector, 2000); // Pass the selector and pixels amount as arguments

    // add a wait here to observe the scroll action if headless: false
    // let { setTimeout } = require('node:'); // Do not use with puppeteer!
    await page.evaluate(() => new Promise(r => setTimeout(r, 2000)));
}
// await scrollUpChat();

async function loadWallPostsToDb(filePath, tableName, jsonResp) {
    connection = await instance.connect();
    try {
    	insertParts = await getTgtInsertParts(connection, tableName, 'wp', filePath);
        // Read json file and insert into pre-existing table
        insertTableSql = `INSERT INTO ${tableName} (${insertParts.colList}) SELECT ${insertParts.selectStr} FROM read_json_auto('${filePath}', union_by_name=true) wp
        WHERE false
        or cast(wp.postedAt as timestamp) < (
            select coalesce(min(cast(postedAt as timestamp)), current_localtimestamp() + interval '1' day)
                from ${tableName} where json_extract_string(author, '$.id') = json_extract_string(wp.author, '$.id'))
        or cast(wp.postedAt as timestamp) > (
            select coalesce(max(cast(postedAt as timestamp)), current_localtimestamp() - interval '99' year)
                from ${tableName} where json_extract_string(author, '$.id') = json_extract_string(wp.author, '$.id'))
		RETURNING 1
        ;`;
        reader = await connection.runAndReadAll(insertTableSql);
        let insertCount = 0;
        insertCount = reader.getRows().length;
        console.log(`Successfully loaded ${insertCount} rows into table "${tableName}"`);
        await queryRows(connection, tableName);
        return insertCount;
    } catch (error) {
        console.error("\nError loading wall post json into DuckDB:", error);
//        console.error('\nFull json response on error:\n', jsonResp);
        return 0;
    } finally {
        // Close the connection and database
        await connection.disconnectSync();
    }
}

async function scrollDnWall() {
    // Scroll down by 500 pixels from the current position
    await page.evaluate(() => {
      window.scrollBy(0, 20000);
    });
    // add a wait here to observe the scroll action if headless: false
    // let { setTimeout } = require('node:'); // Do not use with puppeteer!
    await page.evaluate(() => new Promise(r => setTimeout(r, 3000)));
}

const fs = require('fs');
instance = await DuckDBInstance.create(dbPath);     // run while switching from duckdb cli!

async function scrapeChatMessages() {
    let needToScrollUp = true;
    runDatetime = new Date();

    const onChatResponse = async (response) => {
        if (response.url().includes('api2/v2/chats/')) {
            try {
                const jsonResponse = await response.json();
                console.log('API Response JSON:', jsonResponse['list']);
                jsonResp = JSON.stringify(trimChatListForDb(jsonResponse['list']), null, 2);
                fs.writeFileSync(apiOpFile, jsonResp, 'utf-8');
                console.log(`Successfully saved JSON to ${apiOpFile}`);
                insertCount = await loadChatToDb(apiOpFile, 'stg_chat_messages', runDatetime);
                if (!jsonResponse['hasMore'] || insertCount == 0) {
                    needToScrollUp = false;
                }
            } catch (error) {
                console.error('Error parsing JSON from response:', error);
            }
        }
    };

    page.on('response', onChatResponse);
    try {
        targetUrl = process.env.chat_thread;
        await page.goto(targetUrl, { timeout: 75000, waitUntil: ['domcontentloaded', 'networkidle2'] });
        await attemptLogin();
        await page.evaluate(() => new Promise(r => setTimeout(r, 10000)));
        await attemptLoginSubmit();

        needToScrollUp = true;
        while (needToScrollUp) {
            await scrollUpChat();
        }
        console.log('Chat messages scrape complete.');
    } finally {
        page.off('response', onChatResponse);
    }
}

async function scrapeWallPosts() {
    let needToScrollDn = true;

    const onWallResponse = async (response) => {
        if (response.url().includes('/posts?limit=10&order=publish_date_desc')) {
            try {
                const jsonResponse = await response.json();
                console.log('API Response JSON:', jsonResponse['list']);
                jsonResp = JSON.stringify(trimWallPostListForDb(jsonResponse['list']), null, 2);
                fs.writeFileSync(apiOpFile, jsonResp, 'utf-8');
                console.log(`Successfully saved JSON to ${apiOpFile}`);
                insertCount = await loadWallPostsToDb(apiOpFile, 'stg_wall_posts', jsonResp);
                if (!jsonResponse['hasMore'] || insertCount == 0) {
                    needToScrollDn = false;
                }
            } catch (error) {
                console.error('Error parsing JSON from response:', error);
            }
        }
    };

    page.on('response', onWallResponse);
    try {
        targetUrl = process.env.wall_profile;
        await page.goto(targetUrl, { timeout: 75000, waitUntil: ['domcontentloaded', 'networkidle2'] });
        await attemptLogin();
        await page.evaluate(() => new Promise(r => setTimeout(r, 10000)));
        await attemptLoginSubmit();

        needToScrollDn = true;
        while (needToScrollDn) {
            await scrollDnWall();
        }
        console.log('Wall posts scrape complete.');
    } finally {
        page.off('response', onWallResponse);
    }
}

await scrapeChatMessages();
console.log('Starting wall posts scrape...');
await scrapeWallPosts();
//await instance.closeSync();		// unlocks db file for duckdb cli!


// await browser.close();
