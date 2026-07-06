/**
 * Read-only report on web.db size, row counts, and (optionally) on-disk storage.
 *
 * Usage:
 *   node analyze_web_db.js [path/to/web.db]
 *   node analyze_web_db.js --deep [path/to/web.db]
 *
 * Default path: P:/all_scripts/oyf_scrape/data/web.db
 * Safe to run while the scraper holds a write lock (opens read-only).
 */
const { pathToFileURL } = require('url');

const dbPathArg = process.argv.filter((a) => !a.startsWith('-'));
const deep = process.argv.includes('--deep') || process.argv.includes('-d');
const dbPath = (dbPathArg[2] || process.env.WEB_SCRAPE_DB || 'P:/all_scripts/oyf_scrape/data/web.db')
    .replace(/\\/g, '/');

// @duckdb/node-api is installed on a local disk (pCloud/network drives lock/slow
// node_modules), by default under %LOCALAPPDATA%\oyf_scrape\node_modules. This script
// may be run from anywhere (e.g. data/scripts), where default module resolution can't
// find it, so resolve it from that folder (dir containing node_modules) explicitly.
const NODE_HOME = (process.env.WEB_SCRAPE_NODE_HOME || ((process.env.LOCALAPPDATA || 'C:') + '/oyf_scrape'))
    .replace(/\\/g, '/');

async function loadDuckDbApi() {
    try {
        return await import('@duckdb/node-api');
    } catch (err) {
        if (err && err.code !== 'ERR_MODULE_NOT_FOUND') throw err;
        const resolved = require.resolve('@duckdb/node-api', { paths: [NODE_HOME] });
        return import(pathToFileURL(resolved).href);
    }
}

function mb(bytes) {
    return (Number(bytes || 0) / 1024 / 1024).toFixed(2);
}

(async () => {
    const fs = await import('fs');
    if (!fs.existsSync(dbPath)) {
        console.error(`Database not found: ${dbPath}`);
        process.exit(1);
    }

    const { DuckDBInstance } = await loadDuckDbApi();
    let db;
    try {
        db = await DuckDBInstance.create(dbPath, { access_mode: 'READ_ONLY' });
    } catch (e) {
        console.error('Read-only open failed (is another process writing?):', e.message.split('\n')[0]);
        process.exit(1);
    }
    const conn = await db.connect();

    const stat = fs.statSync(dbPath);
    const walPath = `${dbPath}.wal`;
    console.log('=== web.db file ===');
    console.log(`path: ${dbPath}`);
    console.log(`size: ${mb(stat.size)} MiB (${stat.size} bytes)`);
    console.log(`modified: ${stat.mtime.toISOString()}`);
    if (fs.existsSync(walPath)) {
        const walStat = fs.statSync(walPath);
        console.log(`wal:  ${mb(walStat.size)} MiB (${walPath})`);
    }

    const tables = await conn.runAndReadAll(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'main' AND table_type = 'BASE TABLE'
        ORDER BY 1
    `);
    const tableNames = tables.getRows().map((r) => r[0]);
    console.log('\n=== tables ===');
    console.log(tableNames.join(', '));

    console.log('\n=== row counts ===');
    for (const t of tableNames) {
        const r = await conn.runAndReadAll(`SELECT COUNT(*) FROM "${t}"`);
        console.log(`${t}: ${Number(r.getRows()[0][0]).toLocaleString()}`);
    }

    const statProbes = [
        ['stg_chat_messages', `SELECT COUNT(*) total, COUNT(DISTINCT id) distinct_ids,
            min(cast(createdAt as timestamp)) min_ts, max(cast(createdAt as timestamp)) max_ts
            FROM stg_chat_messages`],
        ['stg_wall_posts', `SELECT COUNT(*) total, COUNT(DISTINCT id) distinct_ids,
            min(cast(postedAt as timestamp)) min_ts, max(cast(postedAt as timestamp)) max_ts
            FROM stg_wall_posts`],
        ['stg_chat_unlocks', 'SELECT COUNT(*) total FROM stg_chat_unlocks'],
        ['media_dim', `SELECT COUNT(*) total, COUNT(DISTINCT media_id) distinct_media,
            COUNT(*) FILTER (WHERE is_current) current_rows FROM media_dim`],
        ['media_dim_history', `SELECT COUNT(*) total, COUNT(DISTINCT extract_ts) distinct_extract_ts,
            COUNT(DISTINCT media_id) distinct_media FROM media_dim_history`],
    ];
    console.log('\n=== table stats ===');
    for (const [name, sql] of statProbes) {
        if (!tableNames.includes(name)) continue;
        try {
            const r = await conn.runAndReadAll(sql);
            console.log(name, JSON.stringify(r.getRowsJson()[0]));
        } catch (e) {
            console.log(name, 'ERR', e.message.split('\n')[0]);
        }
    }

    if (tableNames.includes('media_dim_history')) {
        const runs = await conn.runAndReadAll(`
            SELECT extract_ts, COUNT(*) AS n
            FROM media_dim_history
            GROUP BY 1
            ORDER BY 1 DESC
            LIMIT 15
        `);
        console.log('\n=== media_dim_history by extract_ts (latest 15) ===');
        for (const row of runs.getRows()) {
            console.log(`${row[0]}  ${Number(row[1]).toLocaleString()} rows`);
        }
    }

    const payloadProbes = [
        ['stg_chat_messages (full row json)', 'stg_chat_messages', 'SELECT SUM(length(to_json(stg_chat_messages))) FROM stg_chat_messages'],
        ['stg_wall_posts (full row json)', 'stg_wall_posts', 'SELECT SUM(length(to_json(stg_wall_posts))) FROM stg_wall_posts'],
        ['stg_chat_messages.media', 'stg_chat_messages', 'SELECT SUM(length(to_json(media))) FROM stg_chat_messages'],
        ['stg_wall_posts.media', 'stg_wall_posts', 'SELECT SUM(length(to_json(media))) FROM stg_wall_posts'],
        ['media_dim.media_blob', 'media_dim', 'SELECT SUM(length(to_json(media_blob))) FROM media_dim'],
        ['media_dim_history.media_blob', 'media_dim_history', 'SELECT SUM(length(to_json(media_blob))) FROM media_dim_history'],
    ];
    console.log('\n=== approx JSON payload (logical data, not on-disk blocks) ===');
    for (const [label, table, sql] of payloadProbes) {
        if (!tableNames.includes(table)) continue;
        try {
            const r = await conn.runAndReadAll(sql);
            console.log(`${label}: ${mb(r.getRows()[0][0])} MiB`);
        } catch (e) {
            console.log(`${label}: ERR ${e.message.split('\n')[0]}`);
        }
    }

    try {
        const storage = await conn.runAndReadAll('PRAGMA database_size');
        console.log('\n=== PRAGMA database_size ===');
        console.log(storage.getRowsJson());
    } catch (e) {
        console.log('\nPRAGMA database_size unavailable:', e.message.split('\n')[0]);
    }

    if (deep) {
        console.log('\n=== --deep: duckdb_tables (estimated_size) ===');
        try {
            const r = await conn.runAndReadAll(`
                SELECT table_name, estimated_size, column_count
                FROM duckdb_tables()
                WHERE schema_name = 'main'
                ORDER BY estimated_size DESC NULLS LAST
            `);
            for (const row of r.getRowsJson()) console.log(row);
        } catch (e) {
            console.log('ERR', e.message.split('\n')[0]);
        }

        const colProbes = [
            ['stg_chat_messages.text', 'SELECT SUM(length(COALESCE(CAST(text AS VARCHAR), \'\'))) FROM stg_chat_messages'],
            ['stg_chat_messages.media', 'SELECT SUM(length(COALESCE(CAST(media AS VARCHAR), \'\'))) FROM stg_chat_messages'],
            ['stg_wall_posts.text', 'SELECT SUM(length(COALESCE(CAST(text AS VARCHAR), \'\'))) FROM stg_wall_posts'],
            ['stg_wall_posts.media', 'SELECT SUM(length(COALESCE(CAST(media AS VARCHAR), \'\'))) FROM stg_wall_posts'],
        ];
        console.log('\n=== --deep: column VARCHAR sizes ===');
        for (const [label, sql] of colProbes) {
            const table = label.split('.')[0];
            if (!tableNames.includes(table)) continue;
            try {
                const r = await conn.runAndReadAll(sql);
                console.log(`${label}: ${mb(r.getRows()[0][0])} MiB`);
            } catch (e) {
                console.log(`${label}: ERR ${e.message.split('\n')[0]}`);
            }
        }

        for (const table of ['stg_chat_messages', 'stg_wall_posts', 'media_dim_history', 'media_dim']) {
            if (!tableNames.includes(table)) continue;
            console.log(`\n=== --deep: pragma_storage_info (first 20 segments): ${table} ===`);
            try {
                const r = await conn.runAndReadAll(`FROM pragma_storage_info('${table}') LIMIT 20`);
                for (const row of r.getRowsJson()) console.log(row);
            } catch (e) {
                console.log('ERR', e.message.split('\n')[0]);
            }
        }
    } else {
        console.log('\nTip: pass --deep for column sizes and pragma_storage_info (on-disk segment detail).');
    }

    await conn.disconnectSync();
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
