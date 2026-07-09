// Interactive REPL for web_scrape.js — browser + DuckDB bootstrapped, no auto-scrape/exit.
//
// Usage:
//   node web_scrape_repl.js
//   node web_scrape_repl.js unlocks    # login + unlocks debug helpers
//   node web_scrape.js --repl
//
// Unlocks (same workflow as wall: goto URL, scroll, intercept /posts/paid/chat):
//   Site XHR sends app-token, sign, time, user-id, x-bc, x-hash, x-of-rev — do not hand-build.
//   await du.login()
//   await du.gotoPurchases()
//   await du.run()

process.env.WEB_SCRAPE_REPL = '1';

const repl = require('node:repl');
const path = require('node:path');

// Always load latest web_scrape.js (REPL otherwise keeps a stale require cache).
function loadScrapeMain() {
    const scrapePath = require.resolve('./web_scrape.js');
    delete require.cache[scrapePath];
    return require('./web_scrape.js').main;
}

async function clickTabByIdOnPage(page, elementId) {
    console.log(`Clicking tab by id: ${elementId}`);
    try { await page.bringToFront(); } catch (_) {}
    await page.waitForFunction((id) => !!document.getElementById(id), { timeout: 30000 }, elementId);
    const ok = await page.evaluate((id) => {
        const el = document.getElementById(id);
        if (!el) return false;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.click();
        return true;
    }, elementId);
    if (!ok) throw new Error(`Tab not found: getElementById("${elementId}")`);
    console.log(`Clicked tab: #${elementId}`);
    return `#${elementId}`;
}

function buildUnlocksDebug(ctx) {
    async function withConnection(fn) {
        const connection = await ctx.instance.connect();
        try {
            return await fn(connection);
        } finally {
            await connection.disconnectSync();
        }
    }

    async function login() {
        await ctx.ensureLoginViaChatThread('unlocks-debug');
        await ctx.attemptLoginSubmitAfterCaptchaIfNeeded();
        const url = ctx.page.url();
        console.log('logged in at:', url);
        return url;
    }

    async function gotoPurchases() {
        const purchasesUrl = ctx.getPurchasesPageUrl();
        console.log('Navigating to:', purchasesUrl);
        await ctx.page.goto(purchasesUrl, { timeout: 75000, waitUntil: ['domcontentloaded', 'networkidle2'] });
        await ctx.page.evaluate(() => new Promise(r => setTimeout(r, 10000)));
        console.log('url:', ctx.page.url());
        return ctx.page.url();
    }

    async function clickTrigger() {
        // Inline sequence so REPL never depends on a stale clickPaidChatTrigger closure.
        const purchasedId = (process.env.purchases_tab_selector || 'Purchased').replace(/^#/, '');
        const messagesId = (process.env.purchases_click_selector || 'purchased-chat').replace(/^#/, '');
        console.log(`Purchases tabs: #${purchasedId} then #${messagesId}`);
        await clickTabByIdOnPage(ctx.page, purchasedId);
        await ctx.page.evaluate(() => new Promise(r => setTimeout(r, 3000)));
        await ctx.page.waitForFunction((id) => !!document.getElementById(id), { timeout: 20000 }, messagesId);
        await clickTabByIdOnPage(ctx.page, messagesId);
        await ctx.page.evaluate(() => new Promise(r => setTimeout(r, 1500)));
        return `#${messagesId}`;
    }

    async function scroll() {
        await ctx.scrollDnWall();
    }

    async function run() {
        return ctx.scrapeChatUnlocks();
    }

    async function count() {
        return withConnection(async (connection) => {
            try {
                const reader = await connection.runAndReadAll('SELECT COUNT(1) cnt FROM stg_chat_unlocks');
                const n = reader.getRows()[0][0];
                console.log('stg_chat_unlocks rows:', n);
                return n;
            } catch (err) {
                console.log('stg_chat_unlocks not available:', err.message);
                return null;
            }
        });
    }

    async function describe() {
        return withConnection(async (connection) => {
            try {
                const reader = await connection.runAndReadAll('DESCRIBE stg_chat_unlocks');
                const rows = reader.getRows();
                console.table(rows.map(r => ({ column: r[0], type: r[1], null: r[2], key: r[3], default: r[4], extra: r[5] })));
                return rows;
            } catch (err) {
                console.log('stg_chat_unlocks not available:', err.message);
                return null;
            }
        });
    }

    async function sample(n = 3) {
        return withConnection(async (connection) => {
            try {
                const reader = await connection.runAndReadAll(`
                    SELECT id, createdAt, price, mediaCount,
                           json_extract_string(fromUser, '$.id') AS author_id
                    FROM stg_chat_unlocks
                    ORDER BY cast(createdAt AS timestamp) DESC
                    LIMIT ${Number(n) || 3}
                `);
                const rows = reader.getRowsJson ? reader.getRowsJson() : reader.getRows();
                console.log(rows);
                return rows;
            } catch (err) {
                console.log('sample failed:', err.message);
                return null;
            }
        });
    }

    async function mediaIds(limit = 20) {
        return withConnection(async (connection) => {
            try {
                const reader = await connection.runAndReadAll(`
                    SELECT DISTINCT cast(json_extract_string(m, '$.id') AS bigint) AS media_id
                    FROM stg_chat_unlocks, unnest(media) AS u(m)
                    ORDER BY media_id DESC
                    LIMIT ${Number(limit) || 20}
                `);
                const rows = reader.getRows();
                console.log(rows.map(r => r[0]));
                return rows.map(r => r[0]);
            } catch (err) {
                console.log('mediaIds failed:', err.message);
                return null;
            }
        });
    }

    function help() {
        console.log(`
stg_chat_unlocks (debugUnlocks / du) — same pattern as wall posts
  Site sends signed XHR (app-token, sign, time, user-id, x-bc, x-hash, x-of-rev).
  We only intercept /posts/paid/chat — no hand-built fetch.

  await du.login()
  await du.gotoPurchases()    # homepage (of_web)
  await du.clickTrigger()     # #Purchased then #purchased-chat (Messages; fires /posts/paid/chat)
  await du.scroll()           # further offsets (infinite)
  await du.run()              # full scrapeChatUnlocks()
  await du.count() | describe() | sample(3) | mediaIds(20)
`);
    }

    return { login, gotoPurchases, clickTrigger, scroll, run, count, describe, sample, mediaIds, help };
}

async function startWebScrapeRepl() {
    const unlocksMode = process.argv.slice(2).some(a =>
        ['unlocks', 'purchases', 'chat_unlocks', '--unlocks'].includes(a.toLowerCase())
    );

    const main = loadScrapeMain();
    const ctx = await main();
    const debugUnlocks = buildUnlocksDebug(ctx);
    // Re-bind so scrapeChatUnlocks() / du.run() use the same two-step click.
    ctx.clickPaidChatTrigger = () => debugUnlocks.clickTrigger();

    if (unlocksMode) {
        console.log('Unlocks debug mode: logging in via chat_thread...');
        await debugUnlocks.login();
    }

    console.log(`
web_scrape REPL ready (creds: ${path.join(ctx.homeDirectory, 'data', 'config.env')})
  help() | du.help()
  await scrapeChatMessages() | scrapeWallPosts() | scrapeChatUnlocks()
${unlocksMode ? `  Unlocks: await du.run()
` : `  Unlocks debug: node web_scrape_repl.js unlocks
`}  await shutdown()  |  .exit
`);

    const server = repl.start({
        prompt: unlocksMode ? 'unlocks> ' : 'web_scrape> ',
        ignoreUndefined: true,
        preview: true,
    });

    Object.assign(server.context, ctx);
    server.context.debugUnlocks = debugUnlocks;
    server.context.du = debugUnlocks;
    server.context.help = () => {
        console.log(`
General:
  await ensureLoginViaChatThread(label?)
  await scrapeChatMessages() | scrapeWallPosts() | scrapeChatUnlocks()
  page | browser | instance | of_web | apiOpFile
  await shutdown()
`);
        debugUnlocks.help();
    };

    if (unlocksMode) debugUnlocks.help();

    let shuttingDown = false;
    const cleanup = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        try {
            await ctx.shutdown({ exit: false, message: 'REPL exit; shutting down...' });
        } catch (err) {
            console.error(err);
        }
        process.exit(0);
    };

    server.on('exit', cleanup);
    process.on('SIGINT', () => { server.close(); });
}

if (require.main === module) {
    startWebScrapeRepl().catch(err => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { startWebScrapeRepl, buildUnlocksDebug };
