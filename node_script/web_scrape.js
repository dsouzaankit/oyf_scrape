// control author selection via config.env (one at a time)!
// run one scrape mode per invocation: node web_scrape.js chat | wall | purchases
// interactive REPL: node web_scrape_repl.js  (or WEB_SCRAPE_REPL=1 / --repl)
// this is scd type 4 => scd type 2 + history dim table
// duckdb-cli read and nodejs write connection cannot open in parallel! (duckdb.org/docs/stable/connect/concurrency)
// do not import setTimeout from 'timers/promises' with puppeteer, to avoid noisy errors!
// drop missing, bulky fields (files, videoSources, isMarkdownDisabled) from inferred json schema for efficiency!
// multiple calls to DuckDBInstance.create(...) raises exception!
// sample data for initial schema inference: 'Chromium devtools > Filtered Fetch/XHR > Preview > 'list:' (inner) > Copy object'
// install node packages (npm install) in this node_script folder, then run web_scrape.js from here
// npm install @duckdb/node-api
// npm install dotenv
// leftmost web tab is the active one!
// Login: two passes via ensureLoginViaChatThread — see README "Per-run flow".
//   initial       — before DuckDB; full chat_thread nav + attemptLogin()
//   before scrape — captcha submit if needed; skips re-nav only when .b-chats__scrollbar visible (loginSessionReady)
// don't minimize web browser during scrape (restoring, backgrounding is ok)!
// manually verify and enable remote debugging at chrome://inspect/#remote-debugging
// verify full chromium command args at chrome://version/
/*
Issues, TBD:
latest messages not being scraped from chat thread?
get unlocked media_ids from posts/paid/chat (purchases mode → stg_chat_unlocks)   x
  exclude unlocks from media_origin_date_tracker_multi_author.sql output   x
detech an update based on json payload checksum mismatch, and store history in media_dim   x
test multiple author_id     x not needed
track message price changes relevant to a set of media_ids (extract chat msg price)   x no direct linkage to media_id
add/push total duration of vids in chat, chat media count to each media record?   x not needed
add dbt test cases  x
track deletes   x
ducklake for parallel read & write connections -- not possible with duckdb, ducklake also slower    x
sql logic to map chat media_id to its time band, based off wall post media_id   x
dedupe at elt end   x not needed
support stopping scroll after most recent watermark is reached for incremental load     wall x
wall post field missing before Sep 15, 2024!		x   json field trim, parse long-standing & needed fields
Table "stg_wall_posts" does not have a column with name "linkedPosts", 2023-09-12       x ignore old rare edge cases
Latest posts, messages scrape				x
Oldest chat message schema mismatch			x json field trim, parse long-standing & needed fields
Post page scrape					        x
*/

const fs = require('fs');
const fs1 = require('fs').promises;
const path = require('path');
const os = require('os');

const bootStartMs = Date.now();
console.log('Loading Puppeteer (first run can be slow on network drives)...');

let puppeteerLauncher;

function initPuppeteerLauncher() {
    const puppeteerLoadStart = Date.now();
    if (process.env.puppeteer_stealth === '0') {
        puppeteerLauncher = require('puppeteer');
        console.log(`Puppeteer ready (plain) in ${((Date.now() - puppeteerLoadStart) / 1000).toFixed(1)}s`);
    } else {
        puppeteerLauncher = require('puppeteer-extra');
        puppeteerLauncher.use(require('puppeteer-extra-plugin-stealth')());
        console.log(`Puppeteer ready (stealth) in ${((Date.now() - puppeteerLoadStart) / 1000).toFixed(1)}s`);
    }
}

// One-time cleanup: a shared --disk-cache-dir here got corrupted by concurrent Chromes and
// crashed Chromium ~1s after navigation. We no longer set a custom cache dir (Chrome uses the
// profile's default), but wipe the old shared dir if present.
const legacyChromeCacheDir = path.join(os.tmpdir(), 'web_scrape_chrome_cache');
try { fs.rmSync(legacyChromeCacheDir, { recursive: true, force: true }); } catch (_) {}

function buildBrowserLaunchOptions() {
    const opts = {
        headless: false,
        defaultViewport: null,
        args: [
            '--mute-audio',
            '--no-first-run',
            '--no-default-browser-check',
            // Stability: the authenticated oyf app crashes Chromium (browser-level
            // WebSocket drop ~1s after load) on this machine without these. Disabling the
            // GPU/software-raster compositing path and shared-memory transport prevents it.
            '--disable-dev-shm-usage',
            '--disable-software-rasterizer',
            '--disable-gpu-compositing',
            '--disable-background-media-suspend',
        ],
    };
    if (process.env.puppeteer_stealth === '0') {
        opts.args.push('--disable-blink-features=AutomationControlled');
    }
    if (process.env.chrome_launch_full_flags === '1') {
        opts.args.push(
            '--disable-session-crashed-bubble',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-extensions',
            '--disable-sync',
        );
    }
    if (process.platform === 'win32' && process.env.chrome_launch_disable_gpu !== '0') {
        opts.args.push('--disable-gpu');
    }
    return opts;
}

let launchedBrowser;
let browser;
let weLaunched;
let page;
let browserLaunchOptions;

const isReplMode = process.env.WEB_SCRAPE_REPL === '1' || process.argv.includes('--repl');

function parseScrapeMode() {
    const raw = (process.argv.slice(2).find(a => !a.startsWith('-')) || '').toLowerCase();
    if (['chat', 'chat_thread', 'messages'].includes(raw)) return 'chat';
    if (['wall', 'wall_posts', 'posts'].includes(raw)) return 'wall';
    if (['purchases', 'unlocks', 'chat_unlocks', 'paid_chat'].includes(raw)) return 'purchases';
    if (isReplMode) return null;
    console.error('Usage: node web_scrape.js <chat|wall|purchases>');
    console.error('  chat       — scrape chat thread messages (stg_chat_messages + media_dim)');
    console.error('  wall       — scrape wall posts (stg_wall_posts)');
    console.error('  purchases  — scrape paid chat unlocks (stg_chat_unlocks)');
    console.error('Interactive: node web_scrape_repl.js');
    process.exit(1);
}

const scrapeMode = parseScrapeMode();

function isAuthOnlyLoginMode() {
    return scrapeMode === 'wall' || scrapeMode === 'purchases';
}

let runStartMs = Date.now();

function logStep(msg) {
    const elapsed = ((Date.now() - runStartMs) / 1000).toFixed(1);
    console.log(`[+${elapsed}s] ${msg}`);
}

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

function readDevToolsActivePort(userDataDir) {
    const portFile = path.join(userDataDir, 'DevToolsActivePort');
    if (!fs.existsSync(portFile)) return null;
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
    return port || null;
}

function removeProfileLockFile(userDataDir, name) {
    const filePath = path.join(userDataDir, name);
    if (!fs.existsSync(filePath)) return false;
    try {
        fs.unlinkSync(filePath);
        console.log(`Removed ${name}.`);
        return true;
    } catch (err) {
        if (err.code === 'EBUSY' || err.code === 'EPERM') {
            console.log(`${name} is in use by a running Chromium process.`);
            return false;
        }
        throw err;
    }
}

function readSingletonLockPid(userDataDir) {
    const lockPath = path.join(userDataDir, 'SingletonLock');
    if (!fs.existsSync(lockPath)) return null;
    try {
        let target;
        try {
            target = fs.readlinkSync(lockPath);
        } catch {
            target = fs.readFileSync(lockPath, 'utf8').trim();
        }
        const match = String(target).match(/-(\d+)\s*$/);
        return match ? parseInt(match[1], 10) : null;
    } catch {
        return null;
    }
}

function isProcessAlive(pid) {
    if (!pid || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function clearStaleSingletonLocks(userDataDir) {
    const pid = readSingletonLockPid(userDataDir);
    if (pid && isProcessAlive(pid)) {
        console.log(`SingletonLock held by live process ${pid}; leaving singleton files intact.`);
        return false;
    }
    let removed = false;
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        if (removeProfileLockFile(userDataDir, name)) removed = true;
    }
    return removed;
}

function clearProfileSessionLock(userDataDir) {
    let removed = false;
    for (const name of ['DevToolsActivePort', 'lockfile']) {
        if (removeProfileLockFile(userDataDir, name)) removed = true;
    }
    return removed;
}

function killStalePuppeteerChrome() {
    if (process.platform !== 'win32') return;
    const { execFileSync } = require('child_process');
    try {
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            "Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*\\.cache\\puppeteer\\*' -and $_.Path -notlike '*\\Google\\Chrome\\Application\\*' } | Stop-Process -Force -ErrorAction SilentlyContinue"
        ], { stdio: 'ignore', windowsHide: true });
        console.log('Stopped orphan Puppeteer Chromium process(es).');
    } catch (_) {}
}

function killChromeProcessesUsingProfile(userDataDir) {
    if (process.platform !== 'win32' || !userDataDir) return;
    const { execFileSync } = require('child_process');
    const normalized = path.resolve(userDataDir).replace(/\//g, '\\');
    const escaped = normalized.replace(/'/g, "''");
    const forward = normalized.replace(/\\/g, '/').replace(/'/g, "''");
    try {
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `$p = '${escaped}'; $pf = '${forward}'; Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and (($_.CommandLine -like "*--user-data-dir=*$p*") -or ($_.CommandLine -like "*--user-data-dir=*$pf*")) -and $_.CommandLine -notlike "*\\Google\\Chrome\\User Data*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
        ], { stdio: 'ignore', windowsHide: true });
        console.log('Stopped Chrome process(es) using this profile.');
    } catch (_) {}
}

function prepareChromeProfileForLaunch(userDataDir) {
    const prefsPath = path.join(userDataDir, 'Default', 'Preferences');
    if (fs.existsSync(prefsPath)) {
        try {
            const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
            prefs.session = prefs.session || {};
            prefs.session.restore_on_startup = 4;
            prefs.session.startup_urls = [];
            if (prefs.profile) prefs.profile.exit_type = 'Normal';
            fs.writeFileSync(prefsPath, JSON.stringify(prefs));
            console.log('Chrome restore_on_startup=4 (new tab only).');
        } catch (err) {
            console.log(`Could not update Chrome Preferences: ${err.message}`);
        }
    }

    for (const rel of [
        'Default/Current Session',
        'Default/Current Tabs',
        'Default/Last Session',
        'Default/Last Tabs',
    ]) {
        const fp = path.join(userDataDir, rel);
        if (!fs.existsSync(fp)) continue;
        try {
            fs.unlinkSync(fp);
            console.log(`Removed ${rel}.`);
        } catch (err) {
            console.log(`Could not remove ${rel}: ${err.message}`);
        }
    }
    const sessionsDir = path.join(userDataDir, 'Default', 'Sessions');
    if (fs.existsSync(sessionsDir)) {
        try {
            fs.rmSync(sessionsDir, { recursive: true, force: true });
            console.log('Removed Default/Sessions/.');
        } catch (err) {
            console.log(`Could not remove Default/Sessions: ${err.message}`);
        }
    }
}

async function repairChromeProfile(userDataDir) {
    console.log('Repairing Chromium profile locks...');
    await prepareBrowserProfileForScrape(userDataDir);
    prepareChromeProfileForLaunch(userDataDir);
}

function forceClearProfileLocks(userDataDir) {
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort', 'lockfile']) {
        removeProfileLockFile(userDataDir, name);
    }
}

async function resolveLaunchExecutable(puppeteer) {
    const explicit = (process.env.chrome_executable_path || '').trim();
    if (explicit && fs.existsSync(explicit)) return explicit;
    if (process.env.use_system_chrome === '1') {
        const candidates = [
            path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
            path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
            path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
        ];
        for (const c of candidates) {
            if (c && fs.existsSync(c)) return c;
        }
    }
    // Newer Puppeteer (>=23) returns a Promise from executablePath(); older versions return a string.
    // Promise.resolve() normalizes both so fs.existsSync() gets a real path.
    for (const mod of ['puppeteer', 'puppeteer-core']) {
        try {
            const pp = require(mod);
            if (typeof pp.executablePath === 'function') {
                const p = await Promise.resolve(pp.executablePath());
                if (p && fs.existsSync(p)) return p;
            }
        } catch (_) {}
    }
    try {
        if (typeof puppeteer.executablePath === 'function') {
            const p = await Promise.resolve(puppeteer.executablePath());
            if (p && fs.existsSync(p)) return p;
        }
    } catch (_) {}
    return null;
}

function assertProfileUnlocked(userDataDir) {
    const lockPath = path.join(userDataDir, 'lockfile');
    if (!fs.existsSync(lockPath)) return;
    console.log('Profile lockfile still present; removing before launch...');
    removeProfileLockFile(userDataDir, 'lockfile');
    if (fs.existsSync(lockPath)) {
        throw new Error(
            `Chromium profile still locked at ${userDataDir}. ` +
            'Close all Chrome windows using this profile, then rerun.'
        );
    }
}

function isDevToolsPortReachable(port) {
    return new Promise((resolve) => {
        const req = require('http').get(`http://127.0.0.1:${port}/json/version`, (res) => {
            resolve(res.statusCode === 200);
            res.resume();
        });
        req.on('error', () => resolve(false));
        req.setTimeout(2000, () => {
            req.destroy();
            resolve(false);
        });
    });
}

async function connectToExistingBrowser(puppeteer, userDataDir) {
    const port = readDevToolsActivePort(userDataDir);
    if (!port || !(await isDevToolsPortReachable(port))) {
        return null;
    }
    console.log(`Reusing existing Chromium on port ${port}...`);
    const browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${port}`,
        defaultViewport: null,
        protocolTimeout: 180000,
    });
    console.log(`WebSocket Endpoint URL: ${browser.wsEndpoint()}`);
    return { launchedBrowser: null, browser, weLaunched: false };
}

async function reconnectLiveChromium() {
    if (launchedBrowser?.connected) {
        browser = launchedBrowser;
        try {
            if (page && !page.isClosed()) {
                page.mainFrame();
                return page;
            }
        } catch (_) {}
        const pages = (await browser.pages()).filter(p => !p.isClosed());
        if (pages.length) {
            page = pages[pages.length - 1];
            return page;
        }
    }
    if (browser?.connected) {
        try {
            if (page && !page.isClosed()) {
                page.mainFrame();
                return page;
            }
        } catch (_) {}
        const pages = (await browser.pages()).filter(p => !p.isClosed());
        if (pages.length) {
            page = pages[pages.length - 1];
            return page;
        }
    }
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
        const existing = await connectToExistingBrowser(puppeteerLauncher, browserStateDataFolder);
        if (existing) {
            console.log('Re-attached to live Chromium via DevTools port.');
            if (launchedBrowser && !launchedBrowser.connected) launchedBrowser = null;
            browser = existing.browser;
            weLaunched = false;
            try {
                page = await pickScrapePageForUrl(process.env.chat_thread || '');
            } catch (_) {
                const pages = (await browser.pages()).filter(p => !p.isClosed());
                page = pages.length ? pages[pages.length - 1] : await browser.newPage();
            }
            return page;
        }
        await sleepMs(500);
    }
    throw new Error('Connection closed');
}

let scrapeOsFocusUses = 0;

function getScrapeOsFocusBudget() {
    const raw = parseInt(process.env.scrape_os_focus_budget || '1', 10);
    if (!Number.isFinite(raw) || raw < 0) return 1;
    return raw;
}

function resetScrapeOsFocusBudget() {
    scrapeOsFocusUses = 0;
}

function sleepMs(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function shouldReuseChromiumSession() {
    return process.env.reuse_chromium_session === '1';
}

async function prepareBrowserProfileForScrape(userDataDir) {
    // Reuse mode: attach to the live session; never kill it.
    if (shouldReuseChromiumSession()) {
        const port = readDevToolsActivePort(userDataDir);
        if (port && (await isDevToolsPortReachable(port))) return;
    }
    // Otherwise always kill any Chrome holding this profile. A leftover Chrome keeps the
    // profile SingletonLock, so a fresh launch hands its URL off to the orphan and exits
    // (~seconds later) — the "disconnected after nav" relaunch storm. Killing first makes
    // our launch the sole owner of the profile.
    killChromeProcessesUsingProfile(userDataDir);
    killStalePuppeteerChrome();
    forceClearProfileLocks(userDataDir);
    clearStaleSingletonLocks(userDataDir);
    forceClearProfileLocks(userDataDir);
}

async function puppeteerLaunchWithRetry(puppeteer, userDataDir, launchOptions) {
    const maxAttempts = 3;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await prepareBrowserProfileForScrape(userDataDir);
        if (attempt === 1 || process.env.chrome_clear_sessions === '1') {
            prepareChromeProfileForLaunch(userDataDir);
        } else {
            clearProfileSessionLock(userDataDir);
        }
        assertProfileUnlocked(userDataDir);
        await sleepMs(attempt === 1 ? 2000 : 8000);

        const executablePath = await resolveLaunchExecutable(puppeteer);
        if (!executablePath) {
            throw new Error(
                'Chromium executable not found. Install bundled browser with: npx puppeteer browsers install chrome'
            );
        }

        const launchOpts = {
            ...launchOptions,
            userDataDir,
            executablePath,
            timeout: attempt === 1 ? 60000 : 90000,
            protocolTimeout: 180000,
            handleSIGINT: false,
            handleSIGHUP: false,
            handleSIGTERM: false,
        };
        if (attempt === 1) {
            console.log(`Chromium executable: ${executablePath}`);
        } else {
            console.log(`Chromium launch retry ${attempt}/${maxAttempts}...`);
        }
        console.log('Launching Chromium...');

        try {
            const launchedBrowser = await puppeteer.launch(launchOpts);
            launchedBrowser.on('disconnected', () => {
                if (process.env.chromium_disconnect_debug === '1') {
                    console.log('Chromium disconnected.');
                }
            });
            return launchedBrowser;
        } catch (err) {
            lastErr = err;
            const msg = String(err.message || err);
            console.log(`Chromium launch failed: ${msg}`);
            await prepareBrowserProfileForScrape(userDataDir);
            forceClearProfileLocks(userDataDir);
            if (attempt === maxAttempts) throw err;
            await sleepMs(8000);
        }
    }
    throw lastErr;
}

async function launchAndConnectBrowser(puppeteer, userDataDir, launchOptions) {
    // Only reattach to an existing Chromium when explicitly reusing; otherwise a stale
    // orphan would be adopted and later hand off / die. Default path launches a clean, sole-owner Chrome.
    if (shouldReuseChromiumSession()) {
        console.log('Checking for existing Chromium session...');
        const existing = await connectToExistingBrowser(puppeteer, userDataDir);
        if (existing) {
            console.log('Reusing live Chromium on DevTools port.');
            return existing;
        }
        console.log('reuse_chromium_session=1 but no live DevTools port; launching fresh.');
    }

    resetScrapeOsFocusBudget();
    const launchedBrowser = await puppeteerLaunchWithRetry(puppeteer, userDataDir, launchOptions);

    const wsEndpointUrl = launchedBrowser.wsEndpoint();
    console.log(`WebSocket Endpoint URL: ${wsEndpointUrl}`);
    // Single connection via launch handle — a second connect() often drops mid-navigation.
    return { launchedBrowser, browser: launchedBrowser, weLaunched: true };
}

const urlCache = new Map();
homeDirectory = (process.env.WEB_SCRAPE_HOME || 'P:\\all_scripts\\oyf_scrape').replace(/\//g, '\\');
configPath = path.join(homeDirectory, 'data', 'config.env');

function loadConfigEnv(filePath) {
    const configText = fs.readFileSync(filePath, 'utf8');
    const activeLines = configText
        .split(/\r?\n/)
        .filter(line => {
            const trimmed = line.trim();
            return trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('//');
        })
        .join('\n');
    const parsed = require('dotenv').parse(activeLines);
    for (const [key, value] of Object.entries(parsed)) {
        process.env[key] = value;
    }
}

loadConfigEnv(configPath);
initPuppeteerLauncher();
browserLaunchOptions = buildBrowserLaunchOptions();

function isNetworkDrivePath(dirPath) {
    if (process.platform !== 'win32') return false;
    const resolved = path.resolve(dirPath);
    const root = path.parse(resolved).root || '';
    const letter = root.replace(/[:\\]/g, '').toUpperCase();
    if (!letter) return false;
    // Koofr / scrape data mount — always treat as network (DisplayType is often empty).
    if (letter === 'Z') return true;
    try {
        const { execFileSync } = require('child_process');
        const script = [
            `$d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${letter}:'" -ErrorAction SilentlyContinue`,
            'if ($d -and $d.DriveType -eq 4) { "network" }',
            'else {',
            `  $p = Get-PSDrive -Name '${letter}' -ErrorAction SilentlyContinue`,
            '  if ($p -and $p.DisplayRoot -match "^\\\\\\\\") { "unc" }',
            '}',
        ].join("\n");
        const out = execFileSync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command', script,
        ], { encoding: 'utf8', windowsHide: true }).trim();
        return /network|unc/i.test(out);
    } catch {
        return false;
    }
}

function remoteChromeProfileDir() {
    return path.join(homeDirectory, 'data', 'testChromeSession');
}

function localChromeProfileDir() {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'web_scrape', 'testChromeSession');
}

const CHROME_PROFILE_SEED_PATHS = [
    'Local State',
    'Default/Cookies',
    'Default/Cookies-journal',
    'Default/Preferences',
    'Default/Login Data',
    'Default/Login Data-journal',
    'Default/Web Data',
    'Default/Web Data-journal',
    'Default/Secure Preferences',
    'Default/Local Storage',
    'Default/Session Storage',
    'Default/Network',
];

const CHROME_PROFILE_SYNC_PATHS = [
    ...CHROME_PROFILE_SEED_PATHS,
    'Default/IndexedDB',
];

const LOCAL_PROFILE_EPHEMERAL_DIRS = [
    'Default/Cache',
    'Default/Code Cache',
];

const LOCAL_PROFILE_GPU_DIRS = [
    'Default/GPUCache',
    'Default/DawnGraphiteCache',
    'Default/DawnWebGPUCache',
    'GrShaderCache',
    'ShaderCache',
];

const PROFILE_SEED_MARKER = '.web_scrape_selective_seed';

function removePathIfExists(filePath, logLabel) {
    if (!fs.existsSync(filePath)) return false;
    try {
        fs.rmSync(filePath, { recursive: true, force: true });
        if (logLabel) console.log(`Removed local profile ${logLabel}.`);
        return true;
    } catch (err) {
        console.log(`Could not remove local profile ${logLabel}: ${err.message}`);
        return false;
    }
}

function sanitizeLocalChromeProfile(localDir, options = {}) {
    const wipeGpu = options.wipeGpu === true;
    for (const rel of LOCAL_PROFILE_EPHEMERAL_DIRS) {
        removePathIfExists(path.join(localDir, rel), rel);
    }
    if (wipeGpu) {
        for (const rel of LOCAL_PROFILE_GPU_DIRS) {
            removePathIfExists(path.join(localDir, rel), rel);
        }
    }
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort', 'lockfile']) {
        removeProfileLockFile(localDir, name);
    }
}

function seedLocalChromeProfile(localDir, remoteDir) {
    const marker = path.join(localDir, PROFILE_SEED_MARKER);
    const hasDefault = fs.existsSync(path.join(localDir, 'Default'));
    if (hasDefault && fs.existsSync(marker)) {
        sanitizeLocalChromeProfile(localDir);
        return;
    }
    if (hasDefault && !fs.existsSync(marker)) {
        console.log('Local Chrome profile exists (legacy full copy); sanitizing caches/extensions...');
        sanitizeLocalChromeProfile(localDir, { wipeGpu: true });
        fs.writeFileSync(marker, new Date().toISOString());
        console.log('Local Chrome profile sanitized (auth data kept).');
        return;
    }

    fs.mkdirSync(localDir, { recursive: true });
    fs.mkdirSync(path.join(localDir, 'Default'), { recursive: true });
    if (!fs.existsSync(remoteDir)) {
        fs.writeFileSync(marker, 'empty');
        return;
    }

    const t0 = Date.now();
    console.log('Seeding local Chrome profile (auth files only from P:)...');
    console.log(`  from: ${remoteDir}`);
    console.log(`  to:   ${localDir}`);
    let copied = 0;
    for (const rel of CHROME_PROFILE_SEED_PATHS) {
        const src = path.join(remoteDir, rel);
        const dest = path.join(localDir, rel);
        if (copyChromeProfilePath(src, dest)) {
            copied += 1;
            console.log(`  copied ${rel}`);
        }
    }
    sanitizeLocalChromeProfile(localDir);
    fs.writeFileSync(marker, new Date().toISOString());
    console.log(`Local Chrome profile ready (${copied} path(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

function copyChromeProfilePath(src, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(src)) return false;
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
        
        fs.cpSync(src, dest, { recursive: true, force: true });
    } else {
        fs.copyFileSync(src, dest);
    }
    return true;
}

function syncLocalChromeProfileToRemote() {
    if (!chromeProfileUsesLocalDisk || !chromeProfileLocalDir || !chromeProfileRemoteDir) return;
    if (process.env.sync_chrome_profile_to_p === '0') {
        console.log('Chrome profile sync to P: disabled (sync_chrome_profile_to_p=0).');
        return;
    }
    if (!fs.existsSync(path.join(chromeProfileLocalDir, 'Default'))) {
        console.log('Chrome profile sync skipped (local Default/ missing).');
        return;
    }
    const t0 = Date.now();
    console.log('Syncing local Chrome profile back to P:...');
    console.log(`  from: ${chromeProfileLocalDir}`);
    console.log(`  to:   ${chromeProfileRemoteDir}`);
    fs.mkdirSync(chromeProfileRemoteDir, { recursive: true });
    let copied = 0;
    for (const rel of CHROME_PROFILE_SYNC_PATHS) {
        const src = path.join(chromeProfileLocalDir, rel);
        const dest = path.join(chromeProfileRemoteDir, rel);
        if (copyChromeProfilePath(src, dest)) copied += 1;
    }
    console.log(`Chrome profile sync complete (${copied} path(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s).`);

    // Delete the local profile after a successful sync so each run starts from a clean
    // re-seed of P:. Opt out with keep_local_chrome_profile=1.
    if (process.env.keep_local_chrome_profile === '1') {
        console.log('Local Chrome profile kept (keep_local_chrome_profile=1).');
        return;
    }
    if (copied === 0) {
        console.log('Local Chrome profile kept (nothing synced to P:).');
        return;
    }
    try {
        fs.rmSync(chromeProfileLocalDir, { recursive: true, force: true });
        console.log(`Deleted local Chrome profile after sync: ${chromeProfileLocalDir}`);
    } catch (err) {
        console.log(`Could not delete local Chrome profile: ${err.message}`);
    }
}

function resolveBrowserStateDataFolder() {
    const explicit = (process.env.chrome_user_data_dir || '').trim();
    if (explicit) {
        chromeProfileUsesLocalDisk = false;
        chromeProfileLocalDir = null;
        chromeProfileRemoteDir = null;
        console.log(`Chrome profile (chrome_user_data_dir): ${path.resolve(explicit)}`);
        return path.resolve(explicit);
    }
    const remote = remoteChromeProfileDir();
    const onNetwork = isNetworkDrivePath(remote) || isNetworkDrivePath(homeDirectory);
    const forceLocal = process.env.use_local_chrome_profile === '1';
    const forceRemote = process.env.use_local_chrome_profile === '0';
    const useLocal = forceLocal || (!forceRemote && onNetwork);
    if (!useLocal) {
        chromeProfileUsesLocalDisk = false;
        chromeProfileLocalDir = null;
        chromeProfileRemoteDir = null;
        console.log(`Chrome profile: ${remote}`);
        return remote;
    }
    const local = localChromeProfileDir();
    chromeProfileUsesLocalDisk = true;
    chromeProfileLocalDir = local;
    chromeProfileRemoteDir = remote;
    if (process.env.refresh_local_chrome_profile === '1') {
        console.log('refresh_local_chrome_profile=1: removing local Chrome profile for clean re-seed.');
        removePathIfExists(local, 'profile tree');
    }
    seedLocalChromeProfile(local, remote);
    console.log(`Chrome profile (local disk; avoids network-drive crashes): ${local}`);
    console.log(`Chrome profile remote backup: ${remote}`);
    return local;
}

let chromeProfileUsesLocalDisk = false;
let chromeProfileLocalDir = null;
let chromeProfileRemoteDir = null;
let browserStateDataFolder = resolveBrowserStateDataFolder();

// Derive the oyf site base URL (protocol+host) from config.env. Prefer of_web, then
// fall back to other configured URLs so chat/wall modes work when of_web is unset.
function getOyfBaseUrl() {
    for (const raw of [process.env.of_web, process.env.chat_thread, process.env.wall_profile, process.env.purchases_page]) {
        const val = String(raw || '').trim();
        if (!val) continue;
        try {
            const u = new URL(val);
            return `${u.protocol}//${u.host}`;
        } catch { /* not a full URL; keep looking */ }
    }
    return '';
}

function getOyfHost() {
    const base = getOyfBaseUrl();
    if (!base) return '';
    try {
        return new URL(base).hostname.replace(/^www\./, '');
    } catch {
        return '';
    }
}

function urlIsOyfSite(url) {
    const host = getOyfHost();
    if (!host) return false;
    return String(url || '').includes(host);
}

function isOyfHomeUrl(url) {
    const host = getOyfHost();
    if (!host) return false;
    try {
        const u = new URL(String(url || '').trim());
        return u.hostname.replace(/^www\./, '') === host
            && (u.pathname === '/' || u.pathname === '');
    } catch {
        return false;
    }
}

function assertSafeNavigationUrl(url, envHint = 'URL') {
    const trimmed = String(url || '').trim();
    if (isOyfHomeUrl(trimmed)) {
        throw new Error(
            `Refusing oyf home URL for login entry (anti-bot): ${trimmed}. ` +
            `Set ${envHint} to a /my/chats/chat/<id>/ URL. Post-login of_web/home is ok for purchases.`
        );
    }
}

function getPurchasesPageUrl() {
    if (process.env.purchases_page) {
        return process.env.purchases_page.trim().replace(/\/$/, '');
    }
    const ofWeb = (process.env.of_web || '').trim().replace(/\/$/, '');
    if (ofWeb) {
        if (isOyfHomeUrl(ofWeb)) {
            console.log('Purchases navigation: of_web home (after chat_thread login).');
        }
        return ofWeb;
    }
    const wall = (process.env.wall_profile || '').trim().replace(/\/$/, '');
    if (wall) return wall;
    throw new Error('Set of_web or purchases_page in config.env for purchases scrape.');
}

function getPurchasesEnvHint() {
    if (process.env.purchases_page) return 'purchases_page';
    if ((process.env.of_web || '').trim()) return 'of_web';
    if ((process.env.wall_profile || '').trim()) return 'wall_profile';
    return 'of_web or purchases_page';
}

function getMediaDimHistoryRetainRuns() {
    const raw = parseInt(process.env.media_dim_history_retain_runs || '5', 10);
    if (!Number.isFinite(raw) || raw < 1) return 5;
    return raw;
}

function validateCredsAtStartup() {
    process.env.chat_thread = (process.env.chat_thread || '').trim();
    if (!process.env.chat_thread) {
        console.error('chat_thread is required in config.env (used for login in all scrape modes)');
        process.exit(1);
    }
    if (isOyfHomeUrl(process.env.chat_thread)) {
        const base = getOyfBaseUrl() || 'https://<of_web-host>';
        console.error(
            `chat_thread must not be ${base}/ (anti-bot). Got: ${process.env.chat_thread}\n` +
            `Use e.g. chat_thread=${base}/my/chats/chat/<id>/`
        );
        process.exit(1);
    }
    if (!/\/my\/chats\/chat\/\d+/i.test(process.env.chat_thread)) {
        console.log(`Note: chat_thread should look like .../my/chats/chat/<id>/ — got: ${process.env.chat_thread}`);
    }
    for (const key of ['wall_profile', 'purchases_page']) {
        if (!process.env[key]) continue;
        process.env[key] = process.env[key].trim();
        if (isOyfHomeUrl(process.env[key])) {
            const base = getOyfBaseUrl() || 'https://<of_web-host>';
            console.error(
                `${key} must not be ${base}/ (anti-bot). Got: ${process.env[key]}\n` +
                `Use the creator profile URL, e.g. ${base}/u/<name>`
            );
            process.exit(1);
        }
    }
    if (process.env.of_web) {
        process.env.of_web = process.env.of_web.trim();
    }
    if (scrapeMode === 'wall' && !(process.env.wall_profile || '').trim()) {
        console.error('wall_profile is required in config.env for wall scrape');
        process.exit(1);
    }
    if (scrapeMode === 'purchases' && !(process.env.of_web || '').trim() && !(process.env.purchases_page || '').trim()) {
        console.error('of_web or purchases_page is required in config.env for purchases scrape');
        process.exit(1);
    }
    if (scrapeMode === 'purchases') {
        console.log(`Purchases navigation URL: ${getPurchasesPageUrl()}`);
    }
    if (scrapeMode === 'chat') {
        console.log(`media_dim_history_retain_runs: ${getMediaDimHistoryRetainRuns()}`);
    }
}

validateCredsAtStartup();
apiOpFile = path.join(homeDirectory, 'data\\api_out.json');
const { Writable } = require('stream');
// Define the log file path with a dynamic timestamp in its name (optional)
logsFolder = path.join(homeDirectory, 'logs');
// windows filenames cannot contain ':' for below!
logFilePath = path.join(logsFolder, `error_log_${new Date().toISOString().replaceAll(":", "")}.log`);

async function main() {
runStartMs = Date.now();
await createFolderIfNotExists(logFilePath);

await createFolderIfNotExists(browserStateDataFolder);
logStep('Starting Chromium (profile repair + launch)...');

function isMainFrameTooEarlyError(err) {
    return /main frame too early|Requesting main frame too early/i.test(String(err?.message || err));
}

function isTransientPageError(err) {
    const msg = String(err?.message || err);
    return isMainFrameTooEarlyError(err)
        || /detached Frame|frame was detached|Execution context was destroyed|Connection closed|Target closed|Protocol error|LifecycleWatcher/i.test(msg);
}

async function waitForPageMainFrame(targetPage, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!targetPage || targetPage.isClosed()) {
            throw new Error('Page closed while waiting for main frame.');
        }
        try {
            targetPage.mainFrame();
            return targetPage;
        } catch (err) {
            if (!isMainFrameTooEarlyError(err)) throw err;
        }
        await new Promise(r => setTimeout(r, 150));
    }
    throw new Error('Page main frame not ready in time.');
}

async function acquireScrapePage(browser) {
    await new Promise(r => setTimeout(r, 1500));
    for (let round = 0; round < 20; round++) {
        if (!browser.connected) throw new Error('Connection closed');
        const pages = (await browser.pages()).filter(p => !p.isClosed());
        if (!pages.length) {
            await new Promise(r => setTimeout(r, 400));
            continue;
        }
        if (round === 0) console.log(`${pages.length} tab(s) at startup.`);
        for (let i = 0; i < pages.length; i++) {
            const candidate = pages[i];
            try {
                await waitForPageMainFrame(candidate, 8000);
                console.log(`Using startup tab ${i + 1}/${pages.length}.`);
                return candidate;
            } catch (err) {
                if (round === 0) console.log(`Startup tab ${i + 1} not ready: ${err.message}`);
            }
        }
        await new Promise(r => setTimeout(r, 400));
    }
    throw new Error('No stable Chromium tab available after launch.');
}

function isNavigationDetachedError(err) {
    return /frame was detached|detached Frame|Navigating frame was detached|LifecycleWatcher/i.test(String(err?.message || err));
}

function urlHostMatches(currentUrl, targetUrl) {
    try {
        return new URL(currentUrl).hostname === new URL(targetUrl).hostname;
    } catch {
        return false;
    }
}

async function ensureBrowserConnected() {
    if (browser?.connected) return true;
    if (launchedBrowser?.connected) {
        console.log('Using launch browser handle after connect drop.');
        browser = launchedBrowser;
        return true;
    }
    try {
        await recoverBrowserConnection();
        return true;
    } catch {
        return false;
    }
}

async function pickOpenTab() {
    if (!(await ensureBrowserConnected())) throw new Error('Connection closed');
    const pages = (await browser.pages()).filter(p => !p.isClosed());
    if (!pages.length) throw new Error('No open tabs');
    const picked = pages[pages.length - 1];
    await waitForPageMainFrame(picked, 8000);
    return picked;
}

async function recoverBrowserConnection() {
    if (browser?.connected && page && !page.isClosed()) {
        try {
            page.mainFrame();
            return page;
        } catch (_) {}
    }
    if (launchedBrowser?.connected) {
        browser = launchedBrowser;
        page = await clearOldTabs(browser);
        return page;
    }
    const existing = await connectToExistingBrowser(puppeteerLauncher, browserStateDataFolder);
    if (existing) {
        console.log('Reconnected to existing Chromium.');
        if (launchedBrowser && !launchedBrowser.connected) launchedBrowser = null;
        browser = existing.browser;
        weLaunched = false;
        try {
            page = await pickScrapePageForUrl(process.env.chat_thread || '');
        } catch (_) {
            page = await clearOldTabs(browser);
        }
        return page;
    }
    if (shouldReuseChromiumSession()) {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            const retry = await connectToExistingBrowser(puppeteerLauncher, browserStateDataFolder);
            if (retry) {
                console.log('Reconnected to existing Chromium.');
                if (launchedBrowser && !launchedBrowser.connected) launchedBrowser = null;
                browser = retry.browser;
                weLaunched = false;
                page = await clearOldTabs(browser);
                return page;
            }
            await sleepMs(1000);
        }
    }
    throw new Error('Connection closed');
}

function isConnectionLostError(err) {
    const msg = String(err?.message || err);
    return /Connection closed|Target closed|Protocol error.*(Target|Connection)|Browser has disconnected/i.test(msg);
}

function logResponseParseError(error) {
    if (!isTransientPageError(error) && !isConnectionLostError(error)) {
        console.error('Error parsing JSON from response:', error);
    }
}

async function waitInFlightHandlers(getCount, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (getCount() > 0 && Date.now() < deadline) {
        await sleepMs(25);
    }
}

async function pickScrapePageForUrl(targetUrl) {
    if (!(await ensureBrowserConnected())) throw new Error('Connection closed');
    const pages = (await browser.pages()).filter(p => !p.isClosed());
    if (!pages.length) throw new Error('No open tabs');

    for (const candidate of pages) {
        try {
            const current = candidate.url();
            if (urlHostMatches(current, targetUrl) || urlIsOyfSite(current)) {
                await waitForPageMainFrame(candidate, 10000);
                return candidate;
            }
        } catch (_) {}
    }

    const fallback = pages[pages.length - 1];
    await waitForPageMainFrame(fallback, 10000);
    return fallback;
}

async function refreshPageIfDetached(fallbackUrl) {
    const targetUrl = fallbackUrl || process.env.chat_thread;
    if (await ensureBrowserConnected() && page && !page.isClosed()) {
        try {
            page.mainFrame();
            page.url();
            return page;
        } catch (err) {
            if (!isNavigationDetachedError(err) && !isTransientPageError(err)) throw err;
        }
    }
    if (!(await ensureBrowserConnected())) {
        page = await reconnectLiveChromium();
        return page;
    }
    console.log('Re-binding scrape tab after detached frame...');
    page = await pickScrapePageForUrl(targetUrl);
    console.log(`Scrape tab ready at ${page.url()}`);
    return page;
}

async function recoverPageAfterNavigationError(targetUrl) {
    await sleepMs(3000);
    if (!(await ensureBrowserConnected())) throw new Error('Connection closed');

    const recovered = await pickScrapePageForUrl(targetUrl);
    console.log(`Navigation recovered at ${recovered.url()}`);
    return recovered;
}

let totalRelaunches = 0;
const MAX_TOTAL_RELAUNCHES = 4;

async function relaunchBrowserForNavigation(options = {}) {
    // Prefer reconnecting to a live Chromium (WS dropped but browser alive).
    try {
        page = await reconnectLiveChromium();
        console.log('Reconnected to live Chromium (skipped relaunch).');
        return page;
    } catch (_) {}

    if (totalRelaunches >= MAX_TOTAL_RELAUNCHES) {
        throw new Error(`Aborting: exceeded ${MAX_TOTAL_RELAUNCHES} browser relaunches (Chromium keeps disconnecting).`);
    }
    totalRelaunches += 1;
    console.log(`Relaunching Chromium after connection loss (${totalRelaunches}/${MAX_TOTAL_RELAUNCHES})...`);
    resetScrapeOsFocusBudget();
    try {
        if (weLaunched && launchedBrowser) await launchedBrowser.close();
        else if (browser?.connected) await browser.disconnect();
    } catch (err) {
        console.log(`Browser close before relaunch skipped: ${err.message}`);
    }
    launchedBrowser = null;
    browser = null;
    page = null;
    // Kill any Chrome still holding the profile so the new launch is the sole owner
    // (prevents singleton hand-off → immediate disconnect → relaunch storm).
    killChromeProcessesUsingProfile(browserStateDataFolder);
    killStalePuppeteerChrome();
    forceClearProfileLocks(browserStateDataFolder);
    prepareChromeProfileForLaunch(browserStateDataFolder);
    assertProfileUnlocked(browserStateDataFolder);
    await sleepMs(2000);

    ({ launchedBrowser, browser, weLaunched } = await launchAndConnectBrowser(
        puppeteerLauncher,
        browserStateDataFolder,
        browserLaunchOptions
    ));
    page = await clearOldTabs(browser);
    page = await waitForPageMainFrame(page, 20000);
    await sleepMs(2000);
    return page;
}

async function warmUpScrapePage(targetPage) {
    if (!(await ensureBrowserConnected())) {
        targetPage = await recoverBrowserConnection();
    }
    if (!targetPage || targetPage.isClosed()) {
        targetPage = await pickOpenTab();
    }
    try {
        await waitForPageMainFrame(targetPage, 15000);
    } catch (err) {
        console.log(`Tab warm-up: frame not ready (${err.message}); rebinding tab...`);
        if (await ensureBrowserConnected()) {
            targetPage = await pickOpenTab();
            await waitForPageMainFrame(targetPage, 15000);
        }
    }
    try {
        const current = targetPage.url();
        if (current.startsWith('http')) return targetPage;
        if (current === 'about:blank' || current.startsWith('chrome://newtab')) return targetPage;
        await targetPage.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleepMs(800);
    } catch (err) {
        console.log(`Tab warm-up skipped: ${err.message}`);
        if (isNavigationDetachedError(err) || isConnectionLostError(err)) {
            if (await ensureBrowserConnected()) {
                try {
                    return await recoverBrowserConnection();
                } catch (_) {}
            }
        }
    }
    return targetPage;
}

async function locationAssignNavigate(targetPage, url, timeout, waitUntil = 'domcontentloaded') {
    await waitForPageMainFrame(targetPage, 15000);
    await Promise.all([
        targetPage.waitForNavigation({ waitUntil, timeout }),
        targetPage.evaluate((u) => { window.location.assign(u); }, url),
    ]);
    return targetPage;
}

async function isLoggedInOnChatThread() {
    try {
        page = await refreshPageIfDetached(process.env.chat_thread).catch(() => page);
        if (!isSameChatThreadUrl(page.url(), process.env.chat_thread)) return false;
        if (await isChatThreadReady()) return true;
        return !(await isLoginFormVisible());
    } catch (_) {}
    return false;
}

function isSameChatThreadUrl(currentUrl, targetUrl) {
    try {
        const a = new URL(String(currentUrl || '').trim());
        const b = new URL(String(targetUrl || '').trim());
        return a.origin === b.origin && a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '');
    } catch {
        return false;
    }
}

async function startPageNavigation(targetPage, url, timeout = 75000, options = {}) {
    const navUrl = String(url || '').trim();
    const waitUntil = options.waitUntil ?? 'domcontentloaded';
    if (options.blockOyfHome) {
        assertSafeNavigationUrl(navUrl, options.envHint || 'URL');
    }
    let activePage = targetPage;
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            if (!(await ensureBrowserConnected())) {
                await recoverBrowserConnection();
                activePage = page;
            }
            if (attempt === 0) {
                activePage = await warmUpScrapePage(activePage);
            } else {
                await waitForPageMainFrame(activePage, 15000);
            }
            await activePage.bringToFront().catch(() => {});
            if (attempt === 0) {
                await activePage.goto(navUrl, { waitUntil, timeout });
            } else {
                console.log(`Navigation retry ${attempt + 1}/3 via location.assign...`);
                activePage = await locationAssignNavigate(activePage, navUrl, timeout, waitUntil);
            }
            return activePage;
        } catch (err) {
            lastErr = err;
            if (isNavigationDetachedError(err) || /Navigation timeout/i.test(String(err?.message))) {
                if (!(await ensureBrowserConnected())) {
                    throw err;
                }
                return recoverPageAfterNavigationError(url);
            }
            if (isConnectionLostError(err) || !(await ensureBrowserConnected())) {
                console.log(`Navigation disconnect (${err.message}); retry ${attempt + 1}/3...`);
                await sleepMs(3000);
                try {
                    await recoverBrowserConnection();
                    activePage = page;
                    continue;
                } catch (recoverErr) {
                    lastErr = recoverErr;
                }
            }
            throw err;
        }
    }
    throw lastErr;
}

async function gotoWithDisconnectGuard(targetPage, url, options = {}) {
    const timeout = options.timeout ?? 75000;
    const waitUntil = options.waitUntil ?? 'domcontentloaded';
    const activeBrowser = targetPage.browser();
    let onDisc;
    const disconnected = new Promise((_, reject) => {
        onDisc = () => reject(new Error('Browser disconnected during navigation'));
        activeBrowser.once('disconnected', onDisc);
    });
    try {
        await Promise.race([
            targetPage.goto(url, { waitUntil, timeout }),
            disconnected,
        ]);
    } finally {
        if (onDisc) activeBrowser.off('disconnected', onDisc);
    }
    return targetPage;
}

async function navigateToChatThreadLogin(targetPage, timeout = 75000) {
    const chatUrl = process.env.chat_thread.trim();
    if (!(await ensureBrowserConnected())) {
        page = await relaunchBrowserForNavigation();
        targetPage = page;
    }
    try {
        if (targetPage && !targetPage.isClosed() && isSameChatThreadUrl(targetPage.url(), chatUrl)) {
            console.log('Already on chat thread URL; skipping navigation.');
            page = targetPage;
            return page;
        }
    } catch (_) {}
    console.log(`Opening chat thread: ${chatUrl}`);

    let navPage = targetPage;
    if (!navPage || navPage.isClosed()) {
        navPage = await browser.newPage();
    }

    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
        if (!(await ensureBrowserConnected())) {
            console.log(`Chat nav relaunch (${attempt}/3) after disconnect...`);
            page = await relaunchBrowserForNavigation();
            navPage = page;
        }
        if (!navPage || navPage.isClosed()) {
            navPage = await browser.newPage();
        }
        try {
            await cdpGotoPage(navPage, chatUrl, timeout);
            console.log(`Navigation landed at ${navPage.url()}`);
            page = navPage;
            return page;
        } catch (err) {
            lastErr = err;
            const disconnected = !(await ensureBrowserConnected());
            if (disconnected) {
                console.log(`Chat nav relaunch (${attempt}/3): ${err.message}`);
                try {
                    page = await relaunchBrowserForNavigation();
                    navPage = page;
                } catch (relaunchErr) {
                    lastErr = relaunchErr;
                }
                continue;
            }
            if (attempt < 3 && (isNavigationDetachedError(err) || /Navigation timeout|Browser disconnected/i.test(String(err?.message)))) {
                console.log(`Chat nav retry ${attempt}/3: ${err.message}`);
                await sleepMs(2000);
                try {
                    navPage = await pickScrapePageForUrl(chatUrl);
                } catch (_) {
                    navPage = await browser.newPage();
                }
                continue;
            }
            throw err;
        }
    }
    throw lastErr;
}

/** Reconnect, or relaunch + chat nav when Puppeteer lost the browser but scrape must continue. */
async function ensureLiveBrowserPage(fallbackUrl) {
    const targetUrl = fallbackUrl || process.env.chat_thread || '';
    if (await ensureBrowserConnected() && page && !page.isClosed()) {
        try {
            page.mainFrame();
            return page;
        } catch (_) {}
    }
    try {
        return await reconnectLiveChromium();
    } catch (_) {}
    console.log('Browser not reachable; relaunching for scrape...');
    page = await relaunchBrowserForNavigation();
    if (targetUrl) {
        page = await navigateToChatThreadLogin(page, 75000);
    }
    return page;
}

async function navigatePageToUrl(targetPage, url, timeout = 75000) {
    if (!(await ensureBrowserConnected())) await recoverBrowserConnection();
    const landed = await startPageNavigation(targetPage, url, timeout);
    console.log(`Navigation landed at ${landed.url()}`);
    return landed;
}

async function navigateScrapeTarget(url, logLabel, envHint, options = {}) {
    console.log(`Navigating to ${logLabel}: ${url}`);
    if (options.blockOyfHome) {
        assertSafeNavigationUrl(url, envHint || logLabel);
    }
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            if (!(await ensureBrowserConnected())) {
                page = await relaunchBrowserForNavigation();
            }
            if (!page || page.isClosed()) {
                page = await pickOpenTab().catch(() => browser.newPage());
            }
            await cdpGotoPage(page, url, 75000);
            console.log(`Landed at ${page.url()}`);
            await sleepMs(2000);
            return page;
        } catch (err) {
            lastErr = err;
            if (!(await ensureBrowserConnected())) {
                console.log(`Navigation disconnect (${err.message}); relaunching (${attempt}/3)...`);
                page = await relaunchBrowserForNavigation();
                continue;
            }
            if (attempt < 3) {
                console.log(`Navigation retry ${attempt}/3: ${err.message}`);
                await sleepMs(2000);
                continue;
            }
            throw err;
        }
    }
    throw lastErr;
}

async function waitForChatOrLoginUi(timeoutMs = 90000, options = {}) {
    const authOnly = options.authOnly === true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        try {
            if (page && !page.isClosed()) {
                try {
                    page.mainFrame();
                } catch (err) {
                    if (isNavigationDetachedError(err) || isTransientPageError(err)) {
                        page = await refreshPageIfDetached(process.env.chat_thread);
                    } else {
                        throw err;
                    }
                }
            } else {
                page = await refreshPageIfDetached(process.env.chat_thread);
            }
            if (authOnly) {
                const onChat = isSameChatThreadUrl(page.url(), process.env.chat_thread);
                if (onChat && (await isChatThreadReady() || !(await isLoginFormVisible()))) {
                    console.log('Authenticated on chat thread; proceeding without full chat UI load.');
                    return true;
                }
            }
            await page.waitForFunction(
                () => document.querySelector('.b-chats__scrollbar') || document.querySelector('input[type="email"]'),
                { timeout: Math.min(15000, remaining) }
            );
            return true;
        } catch (err) {
            if (isConnectionLostError(err)) {
                throw err;
            }
            console.log('Chat/login UI not ready yet; re-checking tab...');
            await sleepMs(authOnly ? 1000 : 2000);
        }
    }
    console.log('Login/chat UI not detected within timeout; continuing.');
    return false;
}

async function safeGoto(targetPage, url, options = {}) {
    const timeout = options.timeout ?? 30000;
    if (options.useCommitNavigation) {
        const result = await navigatePageToUrl(targetPage, url, timeout);
        page = result;
        return result;
    }
    const waitUntil = options.waitUntil ?? 'domcontentloaded';
    const retries = options.retries ?? 3;
    let activePage = targetPage;
    let lastErr;
    for (let attempt = 0; attempt < retries; attempt++) {
        if (!browser?.connected) {
            lastErr = new Error('Connection closed');
            break;
        }
        if (!activePage || activePage.isClosed()) activePage = await pickOpenTab();
        try {
            await activePage.goto(url, { waitUntil, timeout });
            page = activePage;
            return activePage;
        } catch (err) {
            lastErr = err;
            if (isNavigationDetachedError(err)) {
                try {
                    activePage = await recoverPageAfterNavigationError(url);
                    page = activePage;
                    return activePage;
                } catch (recoverErr) {
                    lastErr = recoverErr;
                }
            }
            if (!browser?.connected || attempt === retries - 1) break;
            console.log(`goto retry ${attempt + 1}/${retries - 1}: ${err.message}`);
            await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
        }
    }
    throw lastErr;
}

async function detectChromeProfileError(targetPage) {
    if (!targetPage || targetPage.isClosed()) return false;
    try {
        await waitForPageMainFrame(targetPage, 5000);
        if (targetPage.url().startsWith('chrome-error://')) return true;
        const text = await targetPage.evaluate(() => (document.body?.innerText || '').slice(0, 800));
        return /profile error occurred|profile appears to be in use|process singleton/i.test(text);
    } catch {
        return false;
    }
}

async function relaunchBrowserAfterProfileRepair() {
    console.log('Chromium profile error detected; repairing and relaunching once...');
    try {
        if (weLaunched && launchedBrowser) await launchedBrowser.close();
        else if (browser?.connected) await browser.disconnect();
    } catch (err) {
        console.log(`Browser close before relaunch skipped: ${err.message}`);
    }
    await repairChromeProfile(browserStateDataFolder);
    assertProfileUnlocked(browserStateDataFolder);
    ({ launchedBrowser, browser, weLaunched } = await launchAndConnectBrowser(
        puppeteerLauncher,
        browserStateDataFolder,
        browserLaunchOptions
    ));
    return bootstrapScrapePage();
}

({ launchedBrowser, browser, weLaunched } = await launchAndConnectBrowser(
    puppeteerLauncher, browserStateDataFolder, browserLaunchOptions
));
console.log('web_scrape.js build: nav-v57 (delete local profile after P: sync each run)');

// Windows: raise Chromium to the OS foreground (CDP alone often leaves the window behind other apps).
function focusChromeProcessWindow(rootPid) {
    if (!rootPid || process.platform !== 'win32') return false;
    const { execFileSync } = require('child_process');
    const ps = `
$ErrorActionPreference = 'SilentlyContinue'
function Get-DescendantPids([int]$ParentId) {
    $all = @($ParentId)
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$ParentId" | ForEach-Object {
        $all += Get-DescendantPids $_.ProcessId
    }
    return $all | Select-Object -Unique
}
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class ScrapeWinFocus {
    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
    public const int SW_RESTORE = 9;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_SHOWWINDOW = 0x0040;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    public static void ForceForeground(IntPtr hWnd) {
        ShowWindow(hWnd, SW_RESTORE);
        SetForegroundWindow(hWnd);
    }
}
"@
$rootPid = ${rootPid}
$pids = @(Get-DescendantPids $rootPid)
[IntPtr]$hwnd = [IntPtr]::Zero
[ScrapeWinFocus]::EnumWindows({
    param($hWnd, $lParam)
    [uint32]$wpid = 0
    [void][ScrapeWinFocus]::GetWindowThreadProcessId($hWnd, [ref]$wpid)
    if ($pids -contains [int]$wpid -and [ScrapeWinFocus]::IsWindowVisible($hWnd)) {
        $cn = New-Object System.Text.StringBuilder 256
        [void][ScrapeWinFocus]::GetClassName($hWnd, $cn, 256)
        if ($cn.ToString() -like 'Chrome_WidgetWin_*') {
            $script:hwnd = $hWnd
            return $false
        }
    }
    return $true
}, [IntPtr]::Zero) | Out-Null
if ($hwnd -ne [IntPtr]::Zero) {
    [ScrapeWinFocus]::ForceForeground($hwnd)
    Write-Output "Foreground: SetForegroundWindow pid=$rootPid hwnd=$hwnd"
    exit 0
}
Write-Output "Foreground: no scrape Chromium window found for pid=$rootPid (pids: $($pids -join ','))"
exit 1
`;
    try {
        const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
            encoding: 'utf8',
            windowsHide: true,
        }).trim();
        if (out) console.log(out.split('\n').pop());
        return !/no scrape Chromium window found/i.test(out);
    } catch (err) {
        console.log(`Foreground focus skipped: ${err.message}`);
        return false;
    }
}

async function focusScrapeWindowViaCdp(targetPage) {
    if (!targetPage || targetPage.isClosed()) return false;
    try {
        const targetId = targetPage.target()._targetId;
        const conn = targetPage.browser()?.connection;
        if (conn && targetId) {
            await conn.send('Target.activateTarget', { targetId });
        }
        await targetPage.bringToFront();
        return true;
    } catch (err) {
        console.log(`CDP focus skipped: ${err.message}`);
        return false;
    }
}

async function focusScrapeWindow(options = {}) {
    // osFocus: true = allow one Win32 foreground (budgeted); false = CDP tab activate only
    const wantOsFocus = options.osFocus === true;
    if (!(await ensureBrowserConnected())) return;
    if (!page || page.isClosed()) {
        try { page = await pickOpenTab(); } catch { return; }
    }
    try {
        page = await waitForPageMainFrame(page, 10000);
    } catch {
        return;
    }
    if (!(await ensureBrowserConnected())) return;
    await focusScrapeWindowViaCdp(page);

    const budget = getScrapeOsFocusBudget();
    if (!wantOsFocus || budget === 0 || scrapeOsFocusUses >= budget) {
        if (wantOsFocus && budget > 0 && scrapeOsFocusUses >= budget) {
            console.log(`OS foreground skipped (budget ${budget} per launch already used; CDP focus only).`);
        }
        return;
    }
    if (process.platform !== 'win32') return;
    try {
        const pid = browser?.process?.()?.pid ?? launchedBrowser?.process?.()?.pid;
        if (pid && focusChromeProcessWindow(pid)) {
            scrapeOsFocusUses += 1;
        }
    } catch (_) {}
    if (!(await ensureBrowserConnected())) return;
}

async function clearOldTabs(browser) {
    if (!browser.connected) {
        throw new Error('Chromium disconnected before tab cleanup.');
    }
    await sleepMs(1500);
    if (shouldReuseChromiumSession()) {
        try {
            const chatUrl = process.env.chat_thread?.trim();
            if (chatUrl) {
                page = await pickScrapePageForUrl(chatUrl);
                console.log(`Ready on scrape tab (reused session at ${page.url()}).`);
                return page;
            }
        } catch (_) {}
    }
    let pages = (await browser.pages()).filter(p => !p.isClosed());
    if (!pages.length) {
        page = await browser.newPage();
    } else {
        page = pages[0];
        for (let i = 1; i < pages.length; i++) {
            try {
                await pages[i].close({ runBeforeUnload: false });
                console.log('Closed extra startup tab.');
            } catch (err) {
                console.log(`Could not close extra tab: ${err.message}`);
            }
        }
    }
    await sleepMs(1000);
    console.log('Ready on scrape tab.');
    return page;
}

async function bootstrapScrapePage() {
    try {
        return await clearOldTabs(browser);
    } catch (err) {
        if (!isTransientPageError(err) && browser?.connected) throw err;
        console.log(`Chromium startup issue (${err.message}); relaunching once...`);
        try {
            if (weLaunched && launchedBrowser) await launchedBrowser.close();
            else if (browser?.connected) await browser.disconnect();
        } catch (closeErr) {
            console.log(`Browser close before relaunch skipped: ${closeErr.message}`);
        }
        await new Promise(r => setTimeout(r, 1000));
        ({ launchedBrowser, browser, weLaunched } = await launchAndConnectBrowser(
            puppeteerLauncher,
            browserStateDataFolder,
            browserLaunchOptions
        ));
        return clearOldTabs(browser);
    }
}

// no-gui browser (default)
// browser = await puppeteer.launch({ userDataDir: browserStateDataFolder });
// const page = await browser.newPage();
// Retrieve the default blank page
page = await bootstrapScrapePage();
// Profile error page check deferred until after first navigation (evaluate on about:blank can destabilize stealth + goto).

async function cdpGotoPage(navPage, url, timeout = 75000) {
    // Note: do NOT create+detach a CDP session here — detaching mid-navigation on the
    // authenticated oyf SPA destabilizes the browser connection. Use page.goto's
    // underlying nav via a session we keep open only as long as the page lives.
    const client = await navPage.createCDPSession();
    const { errorText } = await client.send('Page.navigate', { url });
    if (errorText) throw new Error(errorText);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (!(await ensureBrowserConnected())) {
            throw new Error('Browser disconnected during navigation');
        }
        try {
            const cur = navPage.url();
            if (urlHostMatches(cur, url) || (urlIsOyfSite(cur) && !cur.startsWith('chrome'))) {
                await sleepMs(1500);
                return;
            }
        } catch (_) {}
        await sleepMs(400);
    }
    throw new Error(`Navigation timeout for ${url}`);
}

async function attemptLogin() {
    page = await refreshPageIfDetached(process.env.chat_thread);
    if (!(await isLoginFormVisible())) {
        console.log('Login form not visible; assuming an active session and skipping login!');
        return;
    }
    try {
        await page.waitForSelector('input[type="email"]', { timeout: 5000 });
        await page.type('input[type="email"]', process.env.of_usern);
        await page.type('input[name="password"]', process.env.of_paswd);
        await attemptLoginFormSubmit();
    } catch (error) {
      console.log('One or more login inputs not loaded. Assuming an active session and skipping login!');
    }
}

// await attemptLogin();

async function attemptLoginFormSubmit() {
    try {
        const result = await page.evaluate(() => {
            const email = document.querySelector('input[type="email"]');
            if (!email) return { ok: false, reason: 'no email field' };
            const form = email.closest('form');
            const btn = form?.querySelector('button[type="submit"]');
            if (!btn) return { ok: false, reason: 'no submit in login form' };
            btn.click();
            return { ok: true };
        });
        if (result.ok) {
            console.log('Clicked login form submit.');
        } else {
            console.log(`Login form submit skipped: ${result.reason}`);
        }
    } catch (err) {
        console.log(`Login form submit skipped: ${err.message}`);
    }
}

async function attemptLoginSubmit() {
    if (await isLoginFormVisible()) {
        await attemptLoginFormSubmit();
        return;
    }
    try {
        await page.waitForSelector('button[type="submit"]', { timeout: 15000 });
        await page.click('button[type="submit"]');
    } catch (error) {
      console.log('One or more login inputs not loaded. Assuming an active session and skipping login!');
    }
}

async function isChatThreadReady() {
    try {
        return !!(await page.$('.b-chats__scrollbar'));
    } catch {
        return false;
    }
}

async function isLoginFormVisible() {
    try {
        return !!(await page.$('input[type="email"]')) && !!(await page.$('input[name="password"]'));
    } catch {
        return false;
    }
}

async function attemptLoginSubmitAfterCaptchaIfNeeded(options = {}) {
    const captchaWaitMs = options.captchaWaitMs ?? 90000;
    const submitIntervalMs = options.submitIntervalMs ?? 10000;

    if (await isChatThreadReady()) {
        console.log('Chat thread UI ready; skipping login submit.');
        return;
    }
    if (!(await isLoginFormVisible())) {
        console.log('Login form not visible; skipping post-captcha submit.');
        return;
    }

    console.log(
        'Login form visible — captcha may auto-resolve or need manual solve in Chromium. ' +
        `Re-submitting login form every ${Math.round(submitIntervalMs / 1000)}s ` +
        `(up to ${Math.round(captchaWaitMs / 1000)}s)...`
    );

    const deadline = Date.now() + captchaWaitMs;
    let lastSubmitMs = 0;

    while (Date.now() < deadline) {
        if (await isChatThreadReady()) {
            console.log('Chat thread UI ready (captcha/login complete).');
            return;
        }
        if (!(await isLoginFormVisible())) {
            console.log('Login form cleared; waiting for chat UI...');
            await waitForChatOrLoginUi(Math.min(45000, deadline - Date.now()));
            return;
        }

        const now = Date.now();
        if (lastSubmitMs === 0 || now - lastSubmitMs >= submitIntervalMs) {
            console.log('Submitting login form (captcha may have auto-resolved)...');
            await attemptLoginFormSubmit();
            lastSubmitMs = now;
            await sleepMs(3000);
            continue;
        }

        await sleepMs(2000);
    }

    if (await isChatThreadReady()) return;
    if (await isLoginFormVisible()) {
        console.log('Final login form submit after captcha wait...');
        await attemptLoginFormSubmit();
        await waitForChatOrLoginUi(45000);
    }
}

// await attemptLoginSubmit();

let loginSessionReady = false;
const MAX_LOGIN_RELAUNCHES = 2;

// Two login passes (initial + before scrape). Pass 2 skips full chat_thread reload when
// loginSessionReady && chat UI is already loaded; still runs post-captcha submit if needed.
async function ensureLoginViaChatThread(label) {
    console.log(`Opening chat thread for login${label ? ` (${label})` : ''}: ${process.env.chat_thread}`);

    if (label === 'before scrape' && isAuthOnlyLoginMode()) {
        if (loginSessionReady) {
            if (!(await ensureBrowserConnected())) {
                console.log('Browser disconnected before scrape; relaunching once...');
                page = await relaunchBrowserForNavigation();
                page = await navigateToChatThreadLogin(page, 75000);
            }
            logStep(`${scrapeMode} scrape: skipping pass 2 re-navigation (already authenticated).`);
            return;
        }
        page = await refreshPageIfDetached(process.env.chat_thread).catch(async () => {
            page = await reconnectLiveChromium();
            return page;
        });
        if (await isLoginFormVisible()) {
            console.log(`${scrapeMode} scrape: login form visible after pass 1; running captcha submit (no re-nav).`);
            await attemptLoginSubmitAfterCaptchaIfNeeded();
            loginSessionReady = await isLoggedInOnChatThread();
            if (loginSessionReady) return;
            console.log(`${scrapeMode} scrape: still not authenticated after captcha submit; full pass 2 login.`);
        } else if (loginSessionReady || (await isLoggedInOnChatThread())) {
            console.log(`${scrapeMode} scrape: skipping pass 2 re-navigation (already authenticated).`);
            await attemptLoginSubmitAfterCaptchaIfNeeded();
            return;
        }
    }

    if (label === 'before scrape' && scrapeMode === 'chat') {
        if (loginSessionReady) {
            page = await ensureLiveBrowserPage(process.env.chat_thread);
            if (!(await isChatThreadReady())) {
                await waitForChatOrLoginUi(45000).catch(err => {
                    console.log(`Chat UI wait skipped: ${err.message}`);
                });
            }
            await attemptLoginSubmitAfterCaptchaIfNeeded();
            loginSessionReady = await isChatThreadReady();
            logStep('Chat scrape: pass 2 complete (session from pass 1).');
            return;
        }
        page = await ensureLiveBrowserPage(process.env.chat_thread);
        const onChatUrl = isSameChatThreadUrl(page.url(), process.env.chat_thread);
        if (onChatUrl && !(await isLoginFormVisible())) {
            logStep('Chat scrape: still on chat thread after DuckDB; skipping pass 2 re-navigation.');
            if (!(await isChatThreadReady())) {
                await waitForChatOrLoginUi(45000);
            }
            await attemptLoginSubmitAfterCaptchaIfNeeded();
            loginSessionReady = await isChatThreadReady();
            return;
        }
        if (onChatUrl && (await isLoginFormVisible())) {
            logStep('Chat scrape: login/captcha on chat thread after DuckDB; waiting for manual captcha solve.');
            await attemptLoginSubmitAfterCaptchaIfNeeded({ captchaWaitMs: 120000 });
            loginSessionReady = await isChatThreadReady();
            return;
        }
    }

    if (label === 'before scrape' && loginSessionReady && (await isChatThreadReady())) {
        console.log('Chat UI ready; skipping re-navigation (pass 2 captcha check only).');
        page = await refreshPageIfDetached(process.env.chat_thread);
        await attemptLoginSubmitAfterCaptchaIfNeeded();
        return;
    }

    const authOnly = isAuthOnlyLoginMode();
    if (label === 'initial' && (authOnly || scrapeMode === 'chat')) {
        page = await navigateToChatThreadLogin(page, 75000);
        logStep(`Chat thread navigation landed (${label})`);
        await sleepMs(3000);
        if (!(await ensureBrowserConnected())) {
            console.log('Browser disconnected after chat nav; relaunching once...');
            page = await relaunchBrowserForNavigation();
            page = await navigateToChatThreadLogin(page, 75000);
        }
        try {
            page = await ensureLiveBrowserPage(process.env.chat_thread);
            if (await isLoginFormVisible()) {
                logStep('Login form visible; entering credentials.');
                await page.type('input[type="email"]', process.env.of_usern).catch(() => {});
                await page.type('input[name="password"]', process.env.of_paswd).catch(() => {});
                await attemptLoginFormSubmit();
            } else {
                console.log('Login form not visible; assuming active session.');
            }
            if (scrapeMode === 'chat') {
                await attemptLoginSubmitAfterCaptchaIfNeeded({ captchaWaitMs: 120000 });
                if (!(await isChatThreadReady())) {
                    await waitForChatOrLoginUi(60000);
                }
                loginSessionReady = await isChatThreadReady();
            } else {
                loginSessionReady = (await isLoggedInOnChatThread().catch(() => false))
                    || isSameChatThreadUrl(page.url(), process.env.chat_thread);
            }
        } catch (err) {
            console.log(`Login check skipped: ${err.message}`);
            loginSessionReady = false;
        }
        if (loginSessionReady) {
            logStep(
                scrapeMode === 'chat'
                    ? 'Login session ready (.b-chats__scrollbar visible).'
                    : 'Login session ready (authenticated on chat thread).'
            );
        }
        return;
    }

    let loginRelaunches = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            if (!(browser?.connected)) {
                page = await recoverBrowserConnection().catch(() => page);
            }
            if (label === 'initial') {
                console.log('Opening chat thread (OS focus after navigation lands)...');
            }
            page = await navigateToChatThreadLogin(page, 75000);
            logStep(`Chat thread navigation landed (${label || 'login'})`);
            if (label === 'initial') {
                // OS focus after nav destabilized Chromium on Windows; skip until scrape scroll.
            }
            await sleepMs(authOnly ? 500 : 1500);
            page = await refreshPageIfDetached(process.env.chat_thread);
            const uiTimeout = label === 'before scrape' && loginSessionReady ? 20000
                : authOnly ? 20000
                : 60000;
            if (await isLoginFormVisible()) {
                logStep('Login form visible; skipping UI wait — going straight to credential login.');
            } else {
                await waitForChatOrLoginUi(uiTimeout, { authOnly });
            }
            page = await refreshPageIfDetached(process.env.chat_thread);
            await attemptLogin();
            if (label === 'before scrape' || (label === 'initial' && scrapeMode === 'chat')) {
                await attemptLoginSubmitAfterCaptchaIfNeeded({
                    captchaWaitMs: label === 'initial' ? 120000 : 90000,
                });
            } else if (!authOnly) {
                await sleepMs(3000);
            }
            page = await refreshPageIfDetached(process.env.chat_thread);
            if (scrapeMode === 'chat' && !(await isChatThreadReady())) {
                logStep('Waiting for chat thread UI after login/captcha...');
                await waitForChatOrLoginUi(45000);
            }
            loginSessionReady = scrapeMode === 'chat'
                ? await isChatThreadReady()
                : await isLoggedInOnChatThread();
            if (loginSessionReady) {
                logStep(
                    scrapeMode === 'chat'
                        ? 'Login session ready (.b-chats__scrollbar visible).'
                        : 'Login session ready (authenticated on chat thread).'
                );
            } else {
                logStep(`Login pass "${label || 'login'}" finished; chat UI not ready yet.`);
            }
            return;
        } catch (err) {
            let onChatUrl = false;
            try {
                onChatUrl = page && !page.isClosed()
                    && (isSameChatThreadUrl(page.url(), process.env.chat_thread)
                        || urlIsOyfSite(page.url()));
            } catch (_) {}
            if (onChatUrl) {
                logStep(`On oyf site despite error (${err.message}); recovering browser for login...`);
                try {
                    page = await ensureLiveBrowserPage(process.env.chat_thread);
                    await attemptLogin();
                    if (label === 'before scrape' || (label === 'initial' && scrapeMode === 'chat')) {
                        await attemptLoginSubmitAfterCaptchaIfNeeded({
                            captchaWaitMs: label === 'initial' ? 120000 : 90000,
                        });
                    }
                    loginSessionReady = scrapeMode === 'chat'
                        ? await isChatThreadReady()
                        : await isLoggedInOnChatThread();
                } catch (loginErr) {
                    console.log(`Post-nav login skipped: ${loginErr.message}`);
                }
                return;
            }
            const browserDead = !(await ensureBrowserConnected());
            const connectionLost = browserDead || isConnectionLostError(err);
            if (loginRelaunches < MAX_LOGIN_RELAUNCHES && connectionLost) {
                loginRelaunches += 1;
                console.log(`Connection lost during login; relaunching browser (${loginRelaunches}/${MAX_LOGIN_RELAUNCHES})...`);
                page = await relaunchBrowserForNavigation({ fullRepair: loginRelaunches > 1 });
                continue;
            }
            if (attempt < 3 && (isNavigationDetachedError(err) || isTransientPageError(err))) {
                console.log(`Login step failed (${err.message}); retrying navigation...`);
                await sleepMs(2000);
                try {
                    page = await refreshPageIfDetached(process.env.chat_thread);
                    continue;
                } catch (_) {}
            }
            if (attempt < 3 && connectionLost) {
                console.log(`Login step failed (${err.message}); retrying...`);
                try {
                    page = await recoverBrowserConnection();
                    continue;
                } catch (_) {
                    if (loginRelaunches < MAX_LOGIN_RELAUNCHES) {
                        loginRelaunches += 1;
                        page = await relaunchBrowserForNavigation({ fullRepair: loginRelaunches > 1 });
                        continue;
                    }
                }
            }
            throw err;
        }
    }
}

loginSessionReady = await isLoggedInOnChatThread().catch(() => false);
if (!loginSessionReady) {
    await ensureLoginViaChatThread('initial');
}
logStep('Initial login complete; opening DuckDB...');

errorLogStream = fs.createWriteStream(logFilePath, { flags: 'a' });
const originalError = console.error;
console.error = function() {
    args = Array.from(arguments);
    logMessage = args.join(' ');
    errorLogStream.write(logMessage);
    originalError.apply(console, arguments);
};

// Create an in-memory database instance (or provide a file path for persistence)
dbPath = path.join(homeDirectory, 'data\\web.db');
let { DuckDB } = require('@duckdb/node-api');
let { DuckDBInstance } = require('@duckdb/node-api');
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
    const duckPath = duckDbJsonPath(filePath);
    try {
        schemaResult = await connection.runAndReadAll(
            `DESCRIBE SELECT * FROM read_json_auto('${duckPath}', union_by_name=true) LIMIT 0`
        );
    } catch (error) {
        logJsonReadFailure(filePath, error);
        throw error;
    }
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
        const colType = String(col[1] || '').toUpperCase();
        if (colName === 'media') {
            if (jsonCols && !jsonCols.has('media')) {
                return `NULL AS ${colName}`;
            }
            return buildMediaSelectExpr(jsonAlias);
        }
        if (jsonCols && !jsonCols.has(colName)) {
            return `NULL AS ${colName}`;
        }
        if (colType === 'JSON') {
            return `CASE WHEN ${jsonAlias}.${colName} IS NULL THEN NULL ELSE to_json(${jsonAlias}.${colName}) END AS ${colName}`;
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
    return (list || []).map(msg => ({
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

function stringifyJsonForDb(data) {
    return JSON.stringify(data, (_, value) => {
        if (typeof value === 'bigint') return value.toString();
        if (value === undefined) return null;
        return value;
    }, 2);
}

function duckDbJsonPath(filePath) {
    return filePath.replace(/\\/g, '/').replace(/'/g, "''");
}

function writeJsonFileAtomic(filePath, data) {
    const text = stringifyJsonForDb(data);
    JSON.parse(text);
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, text, 'utf-8');
    fs.renameSync(tmp, filePath);
    return text;
}

function createBatchQueue() {
    let chain = Promise.resolve();
    return (fn) => {
        chain = chain.then(fn).catch((err) => {
            console.error('Batch queue error:', err);
        });
        return chain;
    };
}

function logJsonReadFailure(filePath, error) {
    if (!fs.existsSync(filePath)) {
        console.error(`DuckDB JSON read failed; file missing: ${filePath}`, error);
        return;
    }
    const stat = fs.statSync(filePath);
    const text = fs.readFileSync(filePath, 'utf-8');
    console.error(
        `DuckDB JSON read failed for ${filePath} (${stat.size} bytes). ` +
        `First 500 chars:\n${text.slice(0, 500)}`
    );
    const recordMatch = String(error?.message || error).match(/record\/value (\d+)/i);
    if (recordMatch) {
        const idx = Number(recordMatch[1]);
        try {
            const rows = JSON.parse(text);
            if (Array.isArray(rows) && rows[idx] != null) {
                console.error(`Record ${idx} preview:\n${JSON.stringify(rows[idx]).slice(0, 500)}`);
            }
        } catch (_) {}
    }
}

function getAuthorIdFromCreds() {
    const fromChat = (process.env.chat_thread || '').match(/\/chat\/(\d+)/);
    if (fromChat) return fromChat[1];
    const fromWall = (process.env.wall_profile || '').match(/\/(\d+)\/?$/);
    if (fromWall) return fromWall[1];
    return null;
}

function getBatchMinMaxCreatedAtMs(list) {
    if (!list?.length) return { minMs: null, maxMs: null };
    let minMs = null;
    let maxMs = null;
    for (const msg of list) {
        if (!msg?.createdAt) continue;
        const t = new Date(msg.createdAt).getTime();
        if (!Number.isFinite(t)) continue;
        if (minMs === null || t < minMs) minMs = t;
        if (maxMs === null || t > maxMs) maxMs = t;
    }
    return { minMs, maxMs };
}

async function getChatCreatedAtBoundsMs(chatUserId) {
    const safeId = String(chatUserId || '').replace(/\D/g, '');
    const connection = await instance.connect();
    try {
        const schema = await connection.runAndReadAll('DESCRIBE stg_chat_messages');
        const columns = new Set(schema.getRows().map(r => r[0]));
        let whereSql = null;
        if (columns.has('chatUserId') && safeId) {
            whereSql = `cast(chatUserId as varchar) = '${safeId}'`;
        } else if (safeId) {
            // stg_chat_messages has no chatUserId — one chat thread per scrape; bounds over full table
            whereSql = null;
        }
        const reader = await connection.runAndReadAll(`
            SELECT
                min(cast(createdAt as timestamp)) AS min_ts,
                max(cast(createdAt as timestamp)) AS max_ts,
                count(*) AS cnt
            FROM stg_chat_messages
            ${whereSql ? `WHERE ${whereSql}` : ''}
        `);
        const row = reader.getRows()[0];
        if (!row || Number(row[2]) === 0) return { minMs: null, maxMs: null };
        const minMs = row[0] != null ? new Date(row[0]).getTime() : null;
        const maxMs = row[1] != null ? new Date(row[1]).getTime() : null;
        return {
            minMs: Number.isFinite(minMs) ? minMs : null,
            maxMs: Number.isFinite(maxMs) ? maxMs : null,
        };
    } catch (err) {
        if (/does not exist|Catalog Error/i.test(String(err.message))) return { minMs: null, maxMs: null };
        throw err;
    } finally {
        await connection.disconnectSync();
    }
}

function getBatchMinMaxPostedAtMs(list) {
    if (!list?.length) return { minMs: null, maxMs: null };
    let minMs = null;
    let maxMs = null;
    for (const post of list) {
        if (!post?.postedAt) continue;
        const t = new Date(post.postedAt).getTime();
        if (!Number.isFinite(t)) continue;
        if (minMs === null || t < minMs) minMs = t;
        if (maxMs === null || t > maxMs) maxMs = t;
    }
    return { minMs, maxMs };
}

function getBatchMaxPostedAtMs(list) {
    return getBatchMinMaxPostedAtMs(list).maxMs;
}

function getWallScrapeMinPostedAtMs() {
    const raw = parseInt(process.env.wall_scrape_max_age_days || '730', 10);
    const days = Number.isFinite(raw) && raw > 0 ? raw : 730;
    return Date.now() - days * 86400000;
}

function isTruthyCredsEnv(value) {
    const v = String(value ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function isWallScrapeForceBackfillEnabled() {
    return isTruthyCredsEnv(process.env.wall_scrape_force_backfill);
}

function filterWallPostsByMinPostedAt(list, minPostedAtMs) {
    if (minPostedAtMs == null || !list?.length) return list || [];
    return list.filter((post) => {
        if (!post?.postedAt) return false;
        const t = new Date(post.postedAt).getTime();
        return Number.isFinite(t) && t >= minPostedAtMs;
    });
}

async function getWallPostedAtBoundsMs(authorId, minPostedAtMs) {
    const safeId = String(authorId || '').replace(/\D/g, '');
    if (!safeId) return { minMs: null, maxMs: null, absMinMs: null, windowCount: 0, totalCount: 0 };
    const windowTs = minPostedAtMs != null
        ? new Date(minPostedAtMs).toISOString().replace('T', ' ').replace('Z', '')
        : null;
    const connection = await instance.connect();
    try {
        const reader = await connection.runAndReadAll(`
            SELECT
                min(cast(postedAt AS timestamp)) FILTER (WHERE cast(postedAt AS timestamp) >= timestamp '${windowTs || '1970-01-01'}') AS win_min_ts,
                max(cast(postedAt AS timestamp)) FILTER (WHERE cast(postedAt AS timestamp) >= timestamp '${windowTs || '1970-01-01'}') AS win_max_ts,
                count(*) FILTER (WHERE cast(postedAt AS timestamp) >= timestamp '${windowTs || '1970-01-01'}') AS win_cnt,
                min(cast(postedAt AS timestamp)) AS abs_min_ts,
                count(*) AS total_cnt
            FROM stg_wall_posts
            WHERE author.id = cast('${safeId}' AS bigint)
        `);
        const row = reader.getRows()[0];
        if (!row || Number(row[4]) === 0) {
            return { minMs: null, maxMs: null, absMinMs: null, windowCount: 0, totalCount: 0 };
        }
        const absMinMs = row[3] != null ? new Date(row[3]).getTime() : null;
        const windowCount = Number(row[2]) || 0;
        const totalCount = Number(row[4]) || 0;
        if (windowCount === 0) {
            return {
                minMs: null,
                maxMs: null,
                absMinMs: Number.isFinite(absMinMs) ? absMinMs : null,
                windowCount: 0,
                totalCount,
            };
        }
        const minMs = row[0] != null ? new Date(row[0]).getTime() : null;
        const maxMs = row[1] != null ? new Date(row[1]).getTime() : null;
        return {
            minMs: Number.isFinite(minMs) ? minMs : null,
            maxMs: Number.isFinite(maxMs) ? maxMs : null,
            absMinMs: Number.isFinite(absMinMs) ? absMinMs : null,
            windowCount,
            totalCount,
        };
    } catch (err) {
        if (/does not exist|Catalog Error/i.test(String(err.message))) {
            return { minMs: null, maxMs: null, absMinMs: null, windowCount: 0, totalCount: 0 };
        }
        throw err;
    } finally {
        await connection.disconnectSync();
    }
}

function wallPostsApiUrlMatches(url) {
    return url.includes('/posts') && url.includes('publish_date_desc');
}

// paid/chat unlocks are message-shaped (fromUser, createdAt), not wall posts
function trimChatUnlockListForDb(list) {
    return list.map(msg => {
        const { isMarkdownDisabled, ...rest } = msg;
        return {
            ...rest,
            media: (msg.media || []).map(trimMediaBlob),
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

async function pruneMediaDimHistory(connection) {
    const retainN = getMediaDimHistoryRetainRuns();
    const countResult = await connection.runAndReadAll(
        'SELECT COUNT(DISTINCT extract_ts) FROM media_dim_history'
    );
    const distinctTs = Number(countResult.getRows()[0]?.[0] || 0);
    if (distinctTs <= retainN) {
        console.log(
            `media_dim_history: ${distinctTs} extract_ts run(s); keeping all (retain last ${retainN}).`
        );
        return;
    }
    const beforeResult = await connection.runAndReadAll('SELECT COUNT(*) FROM media_dim_history');
    const beforeRows = Number(beforeResult.getRows()[0]?.[0] || 0);
    await connection.run(`
        WITH keep_ts AS (
            SELECT DISTINCT extract_ts
            FROM media_dim_history
            ORDER BY extract_ts DESC
            LIMIT ${retainN}
        )
        DELETE FROM media_dim_history
        WHERE extract_ts NOT IN (SELECT extract_ts FROM keep_ts)
    `);
    const afterResult = await connection.runAndReadAll(
        'SELECT COUNT(*), COUNT(DISTINCT extract_ts) FROM media_dim_history'
    );
    const afterRow = afterResult.getRows()[0] || [];
    console.log(
        `media_dim_history pruned: ${beforeRows} → ${afterRow[0]} rows, ` +
        `${afterRow[1]} extract_ts run(s) kept (retain last ${retainN}).`
    );
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

        -- 4. Append batch rows to history (not a full media_dim snapshot)
        INSERT INTO media_dim_history BY NAME
        SELECT md.*
        FROM media_dim md
        INNER JOIN (SELECT DISTINCT author_id, media_id FROM src_media_dim) s
            ON md.author_id = s.author_id AND md.media_id = s.media_id;

        -- 5. Clean up
        DROP TABLE recalculated_history;

        COMMIT;
        `;
        await connection.run(refreshMediaDimSql);
        await pruneMediaDimHistory(connection);
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
    const duckPath = duckDbJsonPath(filePath);
    try {
	    insertParts = await getTgtInsertParts(connection, tableName, 'cm', filePath);
        // Read json file and insert into pre-existing table
        insertTableSql = `INSERT INTO ${tableName} (${insertParts.colList}) SELECT ${insertParts.selectStr}
        FROM read_json_auto('${duckPath}', union_by_name=true) cm
		-- QUALIFY row_number() OVER (PARTITION BY id) = 1
		WHERE false
		or cast(cm.createdAt as timestamp) < (
			select coalesce(min(cast(createdAt as timestamp)), current_localtimestamp() + interval '1' day)
				from ${tableName} where json_extract_string(fromUser, '$.id') = json_extract_string(cm.fromUser, '$.id'))
		or cast(cm.createdAt as timestamp) > (
			select coalesce(max(cast(createdAt as timestamp)), current_localtimestamp() - interval '99' year) 
				from ${tableName} where json_extract_string(fromUser, '$.id') = json_extract_string(cm.fromUser, '$.id'))
		or not exists (select 1 from ${tableName} t where cast(t.id as bigint) = cast(cm.id as bigint))
		RETURNING 1
		;`;
        // console.log(insertTableSql);
        reader = await connection.runAndReadAll(insertTableSql);
        let insertCount = 0;
        insertCount = reader.getRows().length;
        // await connection.run(createTableSql);
        console.log(`Successfully loaded ${insertCount} rows into table "${tableName}"`);
        if (insertCount > 0) {
        await queryRows(connection, tableName);
        await refreshSrcMediaDim(connection, runDatetime);
        await updateMediaDimHist(connection);
        }
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
    }, scrollableSelector, 2000); // Pass the selector and pixels amount (1k) as arguments

    // add a wait here to observe the scroll action if headless: false
    // let { setTimeout } = require('node:'); // Do not use with puppeteer!
    await page.evaluate(() => new Promise(r => setTimeout(r, 2000)));
}

async function ensureTableFromJson(connection, tableName, filePath) {
    const duckPath = duckDbJsonPath(filePath);
    try {
        await connection.runAndReadAll(`DESCRIBE ${tableName}`);
    } catch (_) {
        await connection.run(
            `CREATE TABLE ${tableName} AS SELECT * FROM read_json_auto('${duckPath}', union_by_name=true) WHERE 1=0`
        );
        console.log(`Created table "${tableName}" from JSON schema`);
    }
}

async function loadWallPostsToDb(filePath, tableName, jsonResp) {
    if (!jsonResp?.length) {
        console.log(`Successfully loaded 0 rows into table "${tableName}"`);
        return 0;
    }
    connection = await instance.connect();
    const duckPath = duckDbJsonPath(filePath);
    try {
    	insertParts = await getTgtInsertParts(connection, tableName, 'wp', filePath);
        // Read json file and insert into pre-existing table
        insertTableSql = `INSERT INTO ${tableName} (${insertParts.colList}) SELECT ${insertParts.selectStr} FROM read_json_auto('${duckPath}', union_by_name=true) wp
        WHERE false
        or cast(wp.postedAt as timestamp) < (
            select coalesce(min(cast(postedAt as timestamp)), current_localtimestamp() + interval '1' day)
                from ${tableName} where json_extract_string(author, '$.id') = json_extract_string(wp.author, '$.id'))
        or cast(wp.postedAt as timestamp) > (
            select coalesce(max(cast(postedAt as timestamp)), current_localtimestamp() - interval '99' year)
                from ${tableName} where json_extract_string(author, '$.id') = json_extract_string(wp.author, '$.id'))
        or not exists (
            select 1 from ${tableName} t
            where cast(t.id as bigint) = cast(wp.id as bigint)
              and json_extract_string(t.author, '$.id') = json_extract_string(wp.author, '$.id'))
		RETURNING 1
        ;`;
        reader = await connection.runAndReadAll(insertTableSql);
        let insertCount = 0;
        insertCount = reader.getRows().length;
        console.log(`Successfully loaded ${insertCount} rows into table "${tableName}"`);
        return insertCount;
    } catch (error) {
        console.error("\nError loading wall post json into DuckDB:", error);
        logJsonReadFailure(filePath, error);
        return 0;
    } finally {
        // Close the connection and database
        await connection.disconnectSync();
    }
}

async function loadChatUnlocksToDb(filePath, tableName) {
    connection = await instance.connect();
    const duckPath = duckDbJsonPath(filePath);
    try {
        await ensureTableFromJson(connection, tableName, filePath);
        insertParts = await getTgtInsertParts(connection, tableName, 'cu', filePath);
        // Message-shaped unlocks: watermark on createdAt (account-wide purchase feed)
        insertTableSql = `INSERT INTO ${tableName} (${insertParts.colList}) SELECT ${insertParts.selectStr}
        FROM read_json_auto('${duckPath}', union_by_name=true) cu
        WHERE false
        or cast(cu.createdAt as timestamp) < (
            select coalesce(min(cast(createdAt as timestamp)), current_localtimestamp() + interval '1' day)
                from ${tableName})
        or cast(cu.createdAt as timestamp) > (
            select coalesce(max(cast(createdAt as timestamp)), current_localtimestamp() - interval '99' year)
                from ${tableName})
        RETURNING 1
        ;`;
        reader = await connection.runAndReadAll(insertTableSql);
        let insertCount = reader.getRows().length;
        console.log(`Successfully loaded ${insertCount} rows into table "${tableName}"`);
        await queryRows(connection, tableName);
        return insertCount;
    } catch (error) {
        console.error("\nError loading chat unlock json into DuckDB:", error);
        return 0;
    } finally {
        await connection.disconnectSync();
    }
}

async function safePageEvaluate(pageFn, fallbackUrl) {
    const targetUrl = fallbackUrl || process.env.wall_profile || process.env.chat_thread || '';
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            if (!(await ensureBrowserConnected())) {
                page = await relaunchBrowserForNavigation();
                if (targetUrl) {
                    await cdpGotoPage(page, targetUrl, 75000);
                    await sleepMs(2000);
                }
            }
            if (!page || page.isClosed()) {
                page = targetUrl
                    ? await pickScrapePageForUrl(targetUrl)
                    : await pickOpenTab();
            }
            return await page.evaluate(pageFn);
        } catch (err) {
            if (attempt < 2 && (isNavigationDetachedError(err) || isTransientPageError(err))) {
                console.log(`Page evaluate retry ${attempt + 1}/3: ${err.message}`);
                try {
                    if (await ensureBrowserConnected()) {
                        page = await pickScrapePageForUrl(targetUrl);
                    } else {
                        throw err;
                    }
                } catch (_) {
                    page = await relaunchBrowserForNavigation();
                    if (targetUrl) {
                        for (let navTry = 1; navTry <= 3; navTry++) {
                            try {
                                await cdpGotoPage(page, targetUrl, 75000);
                                await sleepMs(2000);
                                break;
                            } catch (navErr) {
                                console.log(`Re-nav after relaunch (${navTry}/3): ${navErr.message}`);
                                if (!(await ensureBrowserConnected())) {
                                    page = await relaunchBrowserForNavigation();
                                }
                                if (navTry === 3) throw navErr;
                            }
                        }
                    }
                }
                continue;
            }
            throw err;
        }
    }
}

async function scrollDnWall() {
    try {
        await safePageEvaluate(() => {
      window.scrollBy(0, 20000);
        }, process.env.wall_profile);
    } catch (err) {
        console.log(`Wall scroll skipped: ${err.message}`);
    }
    await sleepMs(3000);
}

async function scrapeChatMessages() {
    let needToScrollUp = true;
    let idleScrolls = 0;
    runDatetime = new Date();
    const enqueueChatBatch = createBatchQueue();
    const chatUserId = getAuthorIdFromCreds();
    const chatBounds = await getChatCreatedAtBoundsMs(chatUserId);
    const chatLowWatermarkMs = chatBounds.minMs;
    const chatHighWatermarkMs = chatBounds.maxMs;
    if (chatLowWatermarkMs != null && chatHighWatermarkMs != null) {
        console.log(
            `Chat DB bounds for ${chatUserId}: ` +
            `${new Date(chatLowWatermarkMs).toISOString()} .. ${new Date(chatHighWatermarkMs).toISOString()} ` +
            `(incremental scroll — stop when batch newest is older than DB high watermark with no new rows, batch reaches DB oldest, or hasMore=false)`
        );
    } else {
        console.log(`No existing chat messages for ${chatUserId}; scrolling until hasMore=false.`);
    }

    function evaluateChatBatchStop(jsonResponse, trimmed, insertCount) {
        const { minMs: batchMinMs, maxMs: batchMaxMs } = getBatchMinMaxCreatedAtMs(trimmed);
        if (!jsonResponse['hasMore']) {
            console.log('Chat API hasMore=false; stopping scroll.');
            needToScrollUp = false;
        } else if (
            chatHighWatermarkMs != null &&
            batchMaxMs != null &&
            batchMaxMs < chatHighWatermarkMs &&
            insertCount === 0
        ) {
            console.log(
                `Batch newest ${new Date(batchMaxMs).toISOString()} ` +
                `is older than DB high watermark ${new Date(chatHighWatermarkMs).toISOString()} with no new rows; stopping chat scroll.`
            );
            needToScrollUp = false;
        } else if (
            chatLowWatermarkMs != null &&
            batchMaxMs != null &&
            batchMaxMs <= chatLowWatermarkMs
        ) {
            console.log(
                `Batch newest ${new Date(batchMaxMs).toISOString()} ` +
                `<= DB oldest ${new Date(chatLowWatermarkMs).toISOString()}; stopping incremental scroll.`
            );
            needToScrollUp = false;
        }
    }

    let chatResponsesInFlight = 0;
    const onChatResponse = async (response) => {
        // Message pages only — other /chats/ XHRs have no list and must be ignored.
        const url = response.url();
        if (!url.includes('api2/v2/chats/') || !url.includes('/messages')) {
            return;
        }
        chatResponsesInFlight += 1;
        try {
            const jsonResponse = await response.json();
            const list = jsonResponse && jsonResponse.list;
            if (!Array.isArray(list)) {
                console.log('Skipping chat response without list array:', url);
                return;
            }
            idleScrolls = 0;
            enqueueChatBatch(async () => {
                const trimmed = trimChatListForDb(list);
                const { minMs: batchMinMs, maxMs: batchMaxMs } = getBatchMinMaxCreatedAtMs(trimmed);
                console.log(
                    `Chat API batch: ${trimmed.length} messages` +
                    (batchMaxMs != null ? `, newest ${new Date(batchMaxMs).toISOString()}` : '') +
                    (batchMinMs != null ? `, oldest ${new Date(batchMinMs).toISOString()}` : '')
                );
                if (trimmed.length === 0) {
                    evaluateChatBatchStop(jsonResponse, trimmed, 0);
                    return;
                }
                writeJsonFileAtomic(apiOpFile, trimmed);
                insertCount = await loadChatToDb(apiOpFile, 'stg_chat_messages', runDatetime);
                evaluateChatBatchStop(jsonResponse, trimmed, insertCount);
            });
        } catch (error) {
            logResponseParseError(error);
        } finally {
            chatResponsesInFlight -= 1;
        }
    };

    page.on('response', onChatResponse);
    try {
        if (!(await isChatThreadReady())) {
            console.log('Waiting for chat thread UI before reload...');
            await waitForChatOrLoginUi(45000);
        }
        if (await isChatThreadReady()) {
            console.log('Chat thread UI ready; reloading to capture latest messages (order=desc)...');
        } else {
            console.log('Chat UI not ready; reloading chat thread anyway...');
        }
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 75000 });
        await sleepMs(2500);
        await enqueueChatBatch(() => {});
        needToScrollUp = true;
        let scrollCount = 0;
        while (needToScrollUp && idleScrolls < 15 && scrollCount < 500) {
            const idleBefore = idleScrolls;
            await scrollUpChat();
            scrollCount += 1;
            await sleepMs(2500);
            await enqueueChatBatch(() => {});
            if (!needToScrollUp) break;
            if (idleScrolls === idleBefore) {
                idleScrolls += 1;
            }
        }
        if (scrollCount >= 500 && needToScrollUp) {
            console.log('Chat scroll stopped after 500 iterations (safety cap).');
        }
        if (idleScrolls >= 15 && needToScrollUp) {
            console.log('No chat API responses after 15 scrolls; stopping.');
        }
        console.log('Chat messages scrape complete.');
    } finally {
        page.off('response', onChatResponse);
        await waitInFlightHandlers(() => chatResponsesInFlight);
        await enqueueChatBatch(() => {});
    }
}

async function scrapeWallPosts() {
let needToScrollDn = true;
    let scrollCount = 0;
    let idleScrolls = 0;
    const enqueueWallBatch = createBatchQueue();
    const authorId = getAuthorIdFromCreds();
    const wallMinPostedAtMs = getWallScrapeMinPostedAtMs();
    const wallMaxAgeDays = process.env.wall_scrape_max_age_days || '730';
    const wallForceBackfill = isWallScrapeForceBackfillEnabled();

    logStep('Reading wall postedAt bounds from DuckDB (before navigation)...');
    console.log(
        `Wall scrape window: postedAt >= ${new Date(wallMinPostedAtMs).toISOString()} ` +
        `(wall_scrape_max_age_days=${wallMaxAgeDays})`
    );
    if (wallForceBackfill) {
        console.log(
            'wall_scrape_force_backfill=1: high-watermark stop disabled; ' +
            'scrolling until 730-day cutoff or hasMore=false (maiden-style gap backfill).'
        );
    }
    const wallBounds = await getWallPostedAtBoundsMs(authorId, wallMinPostedAtMs);
    const wallLowWatermarkMs = wallBounds.minMs;
    const wallHighWatermarkMs = wallBounds.maxMs;
    const wallStopHint = wallForceBackfill
        ? 'scroll down until 730-day cutoff or hasMore=false (force backfill)'
        : 'scroll down until batch is older than DB high watermark with no new rows, 730-day cutoff, or hasMore=false';
    if (wallLowWatermarkMs != null && wallHighWatermarkMs != null) {
        let boundsMsg =
            `Wall DB bounds for ${authorId} (within ${wallMaxAgeDays}-day window): ` +
            `${new Date(wallLowWatermarkMs).toISOString()} .. ${new Date(wallHighWatermarkMs).toISOString()} ` +
            `[${wallBounds.windowCount} posts`;
        if (wallBounds.totalCount > wallBounds.windowCount) {
            boundsMsg += `; ${wallBounds.totalCount} total in DB, oldest abs ${new Date(wallBounds.absMinMs).toISOString()} outside window`;
        }
        boundsMsg += `] (${wallStopHint})`;
        console.log(boundsMsg);
    } else if (wallBounds.totalCount > 0) {
        console.log(
            `Wall DB has ${wallBounds.totalCount} posts for ${authorId} but none within ${wallMaxAgeDays}-day window; ` +
            `scrolling until cutoff or hasMore=false.`
        );
    } else {
        console.log(`No existing wall posts for author ${authorId}; scrolling until cutoff or hasMore=false.`);
    }

    function evaluateWallBatchStop(jsonResponse, trimmed, list, insertCount) {
        const inWindow = list?.length ? list : [];
        const { minMs: batchMinMs } = getBatchMinMaxPostedAtMs(trimmed);
        const { maxMs: batchMaxMs } = getBatchMinMaxPostedAtMs(inWindow.length ? inWindow : trimmed);
        if (!jsonResponse['hasMore']) {
            console.log('Wall API hasMore=false; stopping scroll.');
            needToScrollDn = false;
        } else if (batchMinMs != null && batchMinMs < wallMinPostedAtMs) {
            console.log(
                `Batch oldest postedAt ${new Date(batchMinMs).toISOString()} ` +
                `is before ${wallMaxAgeDays}-day cutoff ${new Date(wallMinPostedAtMs).toISOString()}; stopping wall scroll.`
            );
            needToScrollDn = false;
        } else if (
            !wallForceBackfill &&
            wallHighWatermarkMs != null &&
            batchMaxMs != null &&
            batchMaxMs < wallHighWatermarkMs &&
            insertCount === 0
        ) {
            console.log(
                `Batch newest ${new Date(batchMaxMs).toISOString()} ` +
                `is older than DB high watermark ${new Date(wallHighWatermarkMs).toISOString()} with no new rows; stopping wall scroll.`
            );
            needToScrollDn = false;
        }
    }

    let wallResponsesInFlight = 0;
    const onWallResponse = async (response) => {
        const url = response.url();
        if (!wallPostsApiUrlMatches(url)) return;
        wallResponsesInFlight += 1;
        try {
            const jsonResponse = await response.json();
            enqueueWallBatch(async () => {
                const trimmed = trimWallPostListForDb(jsonResponse['list'] || []);
                const { minMs: batchMinMs, maxMs: batchMaxMs } = getBatchMinMaxPostedAtMs(trimmed);
                const list = filterWallPostsByMinPostedAt(trimmed, wallMinPostedAtMs);
                console.log(
                    `Wall API batch: ${trimmed.length} posts (${list.length} within ${wallMaxAgeDays}-day window)` +
                    (batchMaxMs != null ? `, newest ${new Date(batchMaxMs).toISOString()}` : '') +
                    (batchMinMs != null ? `, oldest ${new Date(batchMinMs).toISOString()}` : '')
                );
                idleScrolls = 0;
                let insertCount = 0;
                if (list.length > 0) {
                    const batchPath = path.join(homeDirectory, 'data', `api_out_wall_${Date.now()}.json`);
                    writeJsonFileAtomic(batchPath, list);
                    const batchStart = Date.now();
                    insertCount = await loadWallPostsToDb(batchPath, 'stg_wall_posts', list);
                    logStep(`Wall batch loaded ${insertCount} rows in ${((Date.now() - batchStart) / 1000).toFixed(1)}s`);
                    try { fs.unlinkSync(batchPath); } catch (_) {}
                } else {
                    console.log('Successfully loaded 0 rows into table "stg_wall_posts"');
                    logStep('Wall batch loaded 0 rows in 0.0s');
                }

                evaluateWallBatchStop(jsonResponse, trimmed, list, insertCount);
            });
        } catch (error) {
            logResponseParseError(error);
        } finally {
            wallResponsesInFlight -= 1;
        }
    };

    page.on('response', onWallResponse);
    try {
        await navigateScrapeTarget(process.env.wall_profile, 'wall profile', 'wall_profile', {
            blockOyfHome: true,
        });
        if (needToScrollDn) {
            logStep('Wall profile loaded; starting scroll for older posts...');
        } else {
            logStep('Wall profile loaded; scroll not needed (stop condition met during landing batches).');
        }
        while (needToScrollDn && scrollCount < 500) {
            await scrollDnWall();
            scrollCount += 1;
            idleScrolls += 1;
            if (idleScrolls >= 15) {
                console.log('No wall API responses after 15 scrolls; stopping.');
                break;
            }
        }
        if (scrollCount >= 500 && needToScrollDn) {
            console.log('Wall scroll stopped after 500 iterations (safety cap).');
        }
        console.log('Wall posts scrape complete.');
    } finally {
        page.off('response', onWallResponse);
        await waitInFlightHandlers(() => wallResponsesInFlight);
        await enqueueWallBatch(() => {});
    }
}

// document.getElementById(id).click() — confirmed working for Purchased / purchased-chat tabs.
async function waitAndClickTab(elementId, labelHint = null) {
    const id = elementId.replace(/^#/, '');
    console.log(`Waiting for tab #${id}${labelHint ? ` (${labelHint})` : ''}...`);
    const targetUrl = getPurchasesPageUrl();
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
        page = await refreshPageIfDetached(targetUrl).catch(() => page);
        const result = await page.evaluate(({ tabId, hint }) => {
            let el = document.getElementById(tabId);
            if (!el && hint) {
                el = [...document.querySelectorAll('button,a,[role="tab"],.b-tabs__item,li')].find(
                    (n) => (n.textContent || '').trim().toLowerCase() === hint.toLowerCase()
                );
            }
            if (!el) {
                const hintIds = [...document.querySelectorAll('[id]')]
                    .map((n) => n.id)
                    .filter((x) => /purch|chat|tab|message/i.test(x))
                    .slice(0, 20);
                return { ok: false, url: location.href, hintIds };
            }
            el.scrollIntoView({ block: 'center', inline: 'center' });
            el.click();
            return { ok: true, url: location.href };
        }, { tabId: id, hint: labelHint });
        if (result.ok) {
            console.log(`Clicked tab #${id} at ${result.url}`);
            return `#${id}`;
        }
        console.log(
            `Tab #${id} not ready (${Math.round((deadline - Date.now()) / 1000)}s left). ` +
            `Ids: ${(result.hintIds || []).join(', ') || 'none'}`
        );
        await page.evaluate(() => window.scrollTo(0, 400)).catch(() => {});
        await sleepMs(2500);
    }
    throw new Error(
        `Tab #${id} not found within 90s on ${targetUrl}. ` +
        'While logged in, open that URL in Chrome and check the Purchased tab id (DevTools). ' +
        'Set purchases_tab_selector / purchases_click_selector in config.env if needed.'
    );
}

async function clickTabById(elementId) {
    return waitAndClickTab(elementId);
}

// /posts/paid/chat: homepage → #Purchased → #purchased-chat (Messages).
// Overrides: purchases_tab_selector / purchases_click_selector as element ids (with or without #).
async function clickPaidChatTrigger() {
    const purchasedId = (process.env.purchases_tab_selector || 'Purchased').replace(/^#/, '');
    const messagesId = (process.env.purchases_click_selector || 'purchased-chat').replace(/^#/, '');

    console.log(`Purchases tabs: #${purchasedId} then #${messagesId}`);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await sleepMs(1500);
    await waitAndClickTab(purchasedId, 'Purchased');
    await sleepMs(3000);
    await waitAndClickTab(messagesId, 'Messages');
    await sleepMs(1500);
    return `#${messagesId}`;
}

async function scrapeChatUnlocks() {
    let needToScrollDn = true;
    let scrollCount = 0;
    let idleScrolls = 0;
    let sawPaidChat = false;
    let resolveFirstPaidChat;
    const firstPaidChat = new Promise((resolve) => { resolveFirstPaidChat = resolve; });
    const enqueuePurchasesBatch = createBatchQueue();

    let purchasesResponsesInFlight = 0;
    const onPurchasesResponse = async (response) => {
        // Site fires on click (then scroll): /api2/v2/posts/paid/chat?limit=10&skip_users=all&format=infinite&offset=…
        if (response.url().includes('/posts/paid/chat')) {
            purchasesResponsesInFlight += 1;
            try {
                sawPaidChat = true;
                resolveFirstPaidChat();
                idleScrolls = 0;
                const jsonResponse = await response.json();
                const list = jsonResponse['list'] || [];
                if (list.length === 0) {
                    needToScrollDn = false;
                    return;
                }
                enqueuePurchasesBatch(async () => {
                    console.log('API Response JSON:', list);
                    const trimmed = trimChatUnlockListForDb(list);
                    writeJsonFileAtomic(apiOpFile, trimmed);
        console.log(`Successfully saved JSON to ${apiOpFile}`);
                    insertCount = await loadChatUnlocksToDb(apiOpFile, 'stg_chat_unlocks');
	    if (!jsonResponse['hasMore'] || insertCount == 0) {
                        needToScrollDn = false;
	    }
                });
            } catch (error) {
                logResponseParseError(error);
            } finally {
                purchasesResponsesInFlight -= 1;
            }
        }
    };

    page.on('response', onPurchasesResponse);
    try {
        const purchasesUrl = getPurchasesPageUrl();
        await navigateScrapeTarget(purchasesUrl, 'purchases page', getPurchasesEnvHint());
        await sleepMs(4000);
        await page.evaluate(() => window.scrollTo(0, 500)).catch(() => {});
        await sleepMs(2000);

        await clickPaidChatTrigger();
        await Promise.race([firstPaidChat, sleepMs(20000)]);
        if (!sawPaidChat) {
            throw new Error(
                'No /posts/paid/chat XHR after click. Set purchases_click_selector in config.env to the correct control.'
            );
        }

        needToScrollDn = true;
        while (needToScrollDn && scrollCount < 500) {
    await scrollDnWall();
            scrollCount += 1;
            idleScrolls += 1;
            if (idleScrolls >= 15) {
                console.log('No purchases API responses after 15 scrolls; stopping.');
                break;
            }
        }
        if (scrollCount >= 500 && needToScrollDn) {
            console.log('Purchases scroll stopped after 500 iterations (safety cap).');
        }
        console.log('Chat unlocks (purchases) scrape complete.');
    } finally {
        page.off('response', onPurchasesResponse);
        await waitInFlightHandlers(() => purchasesResponsesInFlight);
        await enqueuePurchasesBatch(() => {});
    }
}

async function shutdown(options = {}) {
    // CLI defaults to exit; REPL defaults to keep process alive unless exit: true
    const shouldExit = options.exit ?? !isReplMode;
    console.log(options.message || 'Shutting down...');
    try {
        if (instance) await instance.closeSync();
    } catch (err) {
        console.log('DuckDB close skipped:', err.message);
    }
    try {
        if (weLaunched && launchedBrowser) {
            await launchedBrowser.close();
        } else if (browser && browser.connected) {
            await browser.disconnect();
        }
    } catch (err) {
        console.log('Browser close skipped:', err.message);
    }
    await sleepMs(1500);
    try {
        syncLocalChromeProfileToRemote();
    } catch (err) {
        console.log(`Chrome profile sync skipped: ${err.message}`);
    }
    try {
        if (errorLogStream) errorLogStream.end();
    } catch (_) {}
    if (shouldExit) process.exit(0);
}

async function shutdownAfterSuccess(mode) {
    await shutdown({ message: `${mode} scrape finished successfully; shutting down.`, exit: true });
}

function buildReplContext() {
    return {
        page,
        browser,
        launchedBrowser,
        weLaunched,
        instance,
        scrapeMode,
        homeDirectory,
        dbPath,
        apiOpFile,
        of_web: (process.env.of_web || '').replace(/\/$/, ''),
        getPurchasesPageUrl,
        clickPaidChatTrigger,
        scrapeChatMessages,
        scrapeWallPosts,
        scrapeChatUnlocks,
        ensureLoginViaChatThread,
        attemptLogin,
        attemptLoginSubmit,
        attemptLoginSubmitAfterCaptchaIfNeeded,
        loadChatToDb,
        loadWallPostsToDb,
        loadChatUnlocksToDb,
        scrollUpChat,
        scrollDnWall,
        focusScrapeWindow,
        clearOldTabs,
        shutdown,
        shutdownAfterSuccess,
        env: process.env,
    };
}

console.log('Opening DuckDB (if this hangs >30s, close duckdb-cli holding web.db)...');
const duckDbOpenStart = Date.now();
instance = await DuckDBInstance.create(dbPath);     // run while switching from duckdb cli!
logStep(`DuckDB ready: ${dbPath} (opened in ${((Date.now() - duckDbOpenStart) / 1000).toFixed(1)}s)`);

if (isReplMode) {
    console.log('REPL bootstrap: browser + DuckDB ready (login not run yet).');
    return buildReplContext();
}

logStep(`Starting ${scrapeMode} scrape...`);
await ensureLoginViaChatThread('before scrape');
if (scrapeMode === 'chat') {
    await scrapeChatMessages();
} else if (scrapeMode === 'wall') {
    logStep('Navigating to wall profile...');
    await scrapeWallPosts();
} else {
    logStep('Navigating to purchases page...');
    await scrapeChatUnlocks();
}
await shutdownAfterSuccess(scrapeMode);
}

if (require.main === module) {
    process.on('unhandledRejection', (err) => {
        console.error('Unhandled rejection:', err);
        process.exit(1);
    });
    if (process.argv.includes('--repl')) {
        require('./web_scrape_repl.js').startWebScrapeRepl().catch(err => {
            console.error(err);
            process.exit(1);
        });
    } else {
        main().catch(err => {
            console.error(err);
            process.exit(1);
        });
    }
}

module.exports = { main, parseScrapeMode, isReplMode };
