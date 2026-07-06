/**
 * CHECKPOINT + VACUUM web.db after media_dim_history prune deletes.
 * Run only when web_scrape.js / duckdb-cli are not holding a write lock.
 *
 * Usage: node compact_web_db.js [path/to/web.db]
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const dbPath = (process.argv[2] || process.env.WEB_SCRAPE_DB || 'P:/all_scripts/oyf_scrape/data/web.db')
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

function sizeMb(filePath) {
    return (fs.statSync(filePath).size / 1024 / 1024).toFixed(2);
}

(async () => {
    if (!fs.existsSync(dbPath)) {
        console.error(`Database not found: ${dbPath}`);
        process.exit(1);
    }

    const walPath = `${dbPath}.wal`;
    console.log(`web.db: ${dbPath}`);
    console.log(`size before: ${sizeMb(dbPath)} MiB`);
    if (fs.existsSync(walPath)) {
        console.log(`wal before:  ${sizeMb(walPath)} MiB (${walPath})`);
    }

    const { DuckDBInstance } = await loadDuckDbApi();
    let db;
    try {
        db = await DuckDBInstance.create(dbPath);
    } catch (err) {
        console.error(
            'Cannot open database for write (is web_scrape.js or duckdb-cli using it?):\n',
            err.message
        );
        process.exit(1);
    }

    const conn = await db.connect();
    try {
        const histBefore = await conn.runAndReadAll(
            'SELECT COUNT(*), COUNT(DISTINCT extract_ts) FROM media_dim_history'
        );
        const row = histBefore.getRows()[0] || [];
        console.log(`media_dim_history: ${row[0]} rows, ${row[1]} distinct extract_ts`);

        console.log('CHECKPOINT...');
        await conn.run('CHECKPOINT');

        console.log('VACUUM...');
        await conn.run('VACUUM');

        const histAfter = await conn.runAndReadAll(
            'SELECT COUNT(*), COUNT(DISTINCT extract_ts) FROM media_dim_history'
        );
        const row2 = histAfter.getRows()[0] || [];
        console.log(`media_dim_history after: ${row2[0]} rows, ${row2[1]} distinct extract_ts`);
    } finally {
        await conn.disconnectSync();
        await db.closeSync();
    }

    console.log(`size after:  ${sizeMb(dbPath)} MiB`);
    if (fs.existsSync(walPath)) {
        console.log(`wal after:   ${sizeMb(walPath)} MiB`);
    } else {
        console.log('wal:         (none - merged or removed)');
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
