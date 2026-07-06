# web_scrape

Puppeteer-based scraper that captures chat messages, wall posts, and paid chat unlocks via intercepted API responses, loads them into DuckDB, and maintains a slowly-changing **media dimension** (SCD Type 2 + history). A **dbt** project (`dbt/webDataELT`) transforms staging tables into analytics-ready models.

## Overview

```
Browser (Puppeteer) → intercept XHR → api_out.json → DuckDB (web.db)
                                                      ├── stg_chat_messages
                                                      ├── stg_wall_posts
                                                      ├── stg_chat_unlocks
                                                      ├── media_dim / media_dim_history  (chat scrape only)
                                                      └── dbt models (dbt_media_dim, …)

sql_script/media_origin_date_tracker_multi_author.sql  →  approx wall-post origin date per chat media
```

| Component | Role |
|-----------|------|
| `web_scrape.js` | Browser scrape + DuckDB load (`chat`, `wall`, or `purchases` mode) |
| `data/web.db` | DuckDB database (staging + dimension tables) |
| `data/creds.env` | Credentials, `chat_thread`, `wall_profile`, `of_web` (one author at a time) |
| `data/testChromeSession/` | Persistent Chrome profile (cookies / session) |
| `sql_script/` | Ad-hoc DuckDB analysis scripts |
| `dbt/webDataELT/` | dbt models for media dimension ELT |

Data root defaults to `Z:\STUDY\web_scrape` (set in `web_scrape.js` as `homeDirectory`). Scripts and scrapers can run from this repo while data lives on that path.

## Prerequisites

- **Node.js** 18+ (22+ tested)
- **DuckDB CLI** (for `run_media_origin_tracker*.ps1`; default path in scripts: `C:\Users\dsouzaankit\Downloads\duckdb_cli-windows-amd64\duckdb.exe`)
- **Python venv** + **dbt-duckdb** (optional, for dbt models)
- Chromium via Puppeteer (`puppeteer`, `puppeteer-extra`, stealth plugin)

## Setup

### 1. Install Node dependencies

```powershell
npm install @duckdb/node-api dotenv puppeteer puppeteer-extra puppeteer-extra-plugin-stealth
```

### 2. Data layout

```
{homeDirectory}/          # default: Z:\STUDY\web_scrape
  data/
    creds.env             # secrets + URLs (not committed)
    web.db                # DuckDB file
    api_out.json          # latest API batch (overwritten each response)
    testChromeSession/    # Chrome user data dir
  logs/
    error_log_*.log
  sql_script/
    media_origin_date_tracker_multi_author.sql
```

Override data root for reporting scripts with `-HomeDirectory` or `$env:WEB_SCRAPE_HOME`.

### 3. Create `data/creds.env`

```env
of_usern=your_email
of_paswd=your_password
of_web=https://...com
chat_thread=https://...com/my/chats/chat/<author_id>
wall_profile=https://...com/<creator>
media_dim_history_retain_runs=5

# alternate author (ignored)
// chat_thread=https://...com/my/chats/chat/<other_author_id>
// wall_profile=https://...com/<other_creator>
```

Control which creator is scraped by setting the active `chat_thread` and `wall_profile` lines. Run **one author at a time**.

**Comment lines:** `web_scrape.js` uses `loadCredsEnv()` which skips blank lines and lines starting with `#` or `//` before parsing. Comment out inactive authors with `//` (or `#`) so only the active URLs are loaded into `process.env`.

The numeric segment in `chat_thread` (`/chat/<author_id>`) is also used by the media-origin reporting scripts to filter results.

### 4. Initialize DuckDB tables

Bootstrap staging tables from a sample API response (save one batch to `api_out.json` first):

```sql
CREATE TABLE IF NOT EXISTS stg_chat_messages AS
SELECT * FROM read_json_auto('Z:/STUDY/web_scrape/data/api_out.json', union_by_name=true)
LIMIT 0;

CREATE TABLE IF NOT EXISTS stg_wall_posts AS
SELECT * FROM read_json_auto('Z:/STUDY/web_scrape/data/api_out.json', union_by_name=true)
LIMIT 0;

-- stg_chat_unlocks is auto-created on first purchases scrape if missing

CREATE TABLE IF NOT EXISTS media_dim AS
SELECT * FROM (VALUES
  (NULL::BIGINT, NULL::BIGINT, NULL::BIGINT, NULL::JSON, 0::BIGINT,
   NULL::TIMESTAMP, NULL::TIMESTAMP, false, NULL::TIMESTAMP)
) t(author_id, media_id, media_duration, media_blob, seen_count,
   valid_from_ts, valid_to_ts, is_current, extract_ts)
WHERE false;

CREATE TABLE IF NOT EXISTS media_dim_history AS SELECT * FROM media_dim WHERE false;
```

Sample JSON: DevTools → Network → chat/posts XHR → copy the `list` array.

### 5. dbt (optional)

```powershell
cd dbt
copy profiles.example.yml profiles.yml
# Edit profiles.yml: set path to data/web.db
dbt run --project-dir webDataELT --profiles-dir .
dbt test --project-dir webDataELT --profiles-dir .
```

## Scraping

### CLI

```powershell
node node_script/web_scrape.js chat        # stg_chat_messages + media_dim
node node_script/web_scrape.js wall        # stg_wall_posts
node node_script/web_scrape.js purchases   # stg_chat_unlocks (paid chat unlocks)
node node_script/web_scrape_repl.js        # interactive REPL (all modes)
node node_script/web_scrape.js --repl      # same as web_scrape_repl.js
```

Aliases: `chat_thread` / `messages`; `wall_posts` / `posts`; `unlocks` / `chat_unlocks` / `paid_chat`.

| Launcher | Runs |
|----------|------|
| `scrape_chat.ps1` | `node node_script/web_scrape.js chat` (tees to `logs/scrape_chat_*.log`) |
| `scrape_wall.ps1` | `node node_script/web_scrape.js wall` |
| `scrape_purchases.ps1` | `node node_script/web_scrape.js purchases` (tees to `logs/scrape_purchases_*.log`) |
| `compact_web_db.ps1` | `CHECKPOINT` + `VACUUM` on `data/web.db` (run **after** scraper/CLI close; see **Database maintenance**) |

Run **one mode per invocation** for CLI scrapes — chat, wall, and purchases are separate processes.

### Interactive REPL

`web_scrape_repl.js` boots Chromium + DuckDB and opens a prompt (**no** auto-scrape, **no** auto-exit). Works for **all** modes (`scrapeChatMessages`, `scrapeWallPosts`, `scrapeChatUnlocks`). Use top-level `await` (Node 20+).

```powershell
node node_script/web_scrape_repl.js           # general prompt: web_scrape>
node node_script/web_scrape_repl.js unlocks   # login first; unlocks> + du.* helpers
```

General:

```javascript
help()
await focusScrapeWindow()
await ensureLoginViaChatThread('manual')
await scrapeChatMessages()
await scrapeWallPosts()
await scrapeChatUnlocks()
page.url()
await shutdown()
.exit
```

### Debugging purchases (`stg_chat_unlocks`)

**Login:** same two-pass flow as chat/wall (`chat_thread` only — never site home for login). After login, navigates to the `of_web` base URL. Pass 2 full chat reload is skipped only when pass 1 already showed chat UI; otherwise pass 2 runs full login again before opening `of_web`.

`/posts/paid/chat` is **not** loaded on homepage open alone — it fires when the **Messages** tab under Purchased is clicked (`#purchased-chat`). Do not hand-build signed `fetch` headers (causes HTTP 400); intercept the site XHR like wall posts.

**Step-by-step:**

```powershell
node node_script/web_scrape_repl.js unlocks
```

```javascript
du.help()
await du.gotoPurchases()   // homepage (of_web)
await du.clickTrigger()    // #Purchased then #purchased-chat — Network: /posts/paid/chat?offset=0
await du.scroll()          // further offsets if infinite scroll applies
await du.count()
await du.sample(3)
await du.describe()
await du.mediaIds(20)
await du.run()             // full scrapeChatUnlocks() in one call
```

**One-shot:** `.\scrape_purchases.ps1` or `node node_script/web_scrape.js purchases`  
**Artifacts:** `data/api_out.json` (last batch), `logs/scrape_purchases_*.log` (PS1 tee), `logs/error_log_*.log`

**creds.env**

| Key | Role |
|-----|------|
| `of_web` | Site or creator base URL; purchases navigates here **after** chat-thread login (`of_web` home ok post-login) |
| `purchases_page` | Optional override for homepage URL |
| `purchases_tab_selector` | Optional; default `#Purchased` (first click) |
| `purchases_click_selector` | Optional; default `#purchased-chat` (Messages; second click) |

If a click misses, set the matching selector in `creds.env` to the live CSS id/class.

### Per-run flow

1. Before launch, clears Chrome session-restore files and sets `restore_on_startup=4` (single new tab; cookies kept in `testChromeSession/`). Picks the first stable launch tab — never calls `newPage()` during startup.
2. **Login pass 1 — `initial`** (before DuckDB): opens `chat_thread`, waits for chat UI or login form, runs `attemptLogin()`, focuses the browser window once.
3. Opens `web.db` once (`DuckDBInstance.create`).
4. **Login pass 2 — `before scrape`** (immediately before the scrape mode):
   - Skips full chat-thread reload **only** when pass 1 left `.b-chats__scrollbar` visible (`loginSessionReady`); still runs post-captcha submit if needed.
   - Otherwise → full chat-thread navigation again (captcha window, submit).
   - Applies to **all modes** including purchases — purchases does **not** require a second full login when pass 1 already loaded chat UI.
5. Runs the selected scrape mode:

**Chat:** stays on `chat_thread`; intercepts `api2/v2/chats/…/messages`, loads `stg_chat_messages`, scrolls **up**.

**Wall:** navigates to `wall_profile`; intercepts posts API, scrolls **down** until high watermark or `hasMore=false`.

**Purchases:** navigates to `of_web` (its home is ok after login — **not** used as login entry), **clicks** `#Purchased` then `#purchased-chat` (overrides: `purchases_tab_selector`, `purchases_click_selector`), scrolls **down**, loads `stg_chat_unlocks`.

**URL rules:** never navigate to the `of_web` **home** for **login** (anti-bot). Use `chat_thread` for both login passes. The `of_web` home is fine for purchases navigation after login; override with `purchases_page` if needed.

On successful completion (scroll loop ends), the script closes DuckDB, closes the browser, and exits.

Entry point is `async function main()` so CommonJS `require()` works with async browser/DB calls.

### Browser tips

- Non-headless by default (`headless: false`).
- Do not **minimize** the window during scrape. If the Chromium window is behind other apps or minimized, loading can stall — mostly **Chromium background/occlusion throttling** on Windows, not the site blocking automation. Launch flags mitigate this (anti-throttle flags).
- **`focusScrapeWindow()`** — Win32 foreground **once per Chromium launch**, **after** initial chat navigation lands (for captcha). Budget: `scrape_os_focus_budget` in `creds.env` (default **1**; set **0** to disable OS focus).
- **Login:** two passes (`initial` + `before scrape`). Pass 2 skips re-navigation only when `.b-chats__scrollbar` is visible after pass 1 (log: `Chat UI ready; skipping re-navigation`). Purchases then goes to `of_web` — not back through `wall_profile`.
- **After login:** chat stays on `chat_thread`; wall → `wall_profile`; purchases → `of_web` / `purchases_page`.
- Leftmost tab is active.

### Chromium / profile session

Persistent profile source: `data/testChromeSession/` on the data root (cookies/session).

**Network drive (`Z:` / Koofr):** Chromium often **crashes on navigation** when the profile lives on a mapped network drive. The scraper **automatically uses a local copy** at `%LOCALAPPDATA%\web_scrape\testChromeSession` (one-time **auth-only** seed from `Z:` — not a full 140MB copy). On shutdown it **syncs session cookies/login back** to `data/testChromeSession/` on `Z:` (disable with `sync_chrome_profile_to_z=0`). Override with `chrome_user_data_dir` or `use_local_chrome_profile=0` in `creds.env` to force the remote profile. Set `refresh_local_chrome_profile=1` once to wipe and re-seed the local profile.

**Startup (`launchAndConnectBrowser`):**

1. If `DevToolsActivePort` in the profile points at a **live** debug port → reconnect to that Chromium (no new window).
2. Otherwise stop orphan Puppeteer Chromium, clear stale `DevToolsActivePort` / `lockfile` / `Singleton*` locks, then launch (common after crash or bad shutdown).
3. `puppeteer.launch()` → use that browser handle directly (no second `connect()` — avoids `Network.enable timed out`).
4. Launch flags reduce timer/render throttling when the window is occluded (`--disable-background-timer-throttling`, `--disable-features=CalculateNativeWinOcclusion`, etc.).
5. Console milestones: `Launching Chromium...` or `Reusing existing Chromium on port ...`, then `WebSocket Endpoint URL: ...`.

**Shutdown:** on successful scrape, disconnects the Puppeteer client and closes Chromium only if this run launched it (`weLaunched`).

**If Chromium does not open:**

```powershell
# end orphan Puppeteer Chromium (not your daily Google Chrome)
Get-Process chrome -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like '*\.cache\puppeteer\*' } |
  Stop-Process -Force
```

Then rerun `node node_script/web_scrape.js chat` or `wall`.

## Media origin reporting

Maps chat `media_id` to an approximate wall-post date (`approx_origin_date`) by comparing media ID bands on wall posts.

**SQL:** `sql_script/media_origin_date_tracker_multi_author.sql`

Built-in optional filters (edit CTEs in the SQL file, or let PS1 inject values):

| CTE | Purpose |
|-----|---------|
| `author_filter` | Restrict to author id(s); PS1 sets from `creds.env` `chat_thread` |
| `msg_text_filter` | Substring match on message text |
| `media_id_filter` | Specific media IDs |
| `origin_days_filter` | `approx_origin_date` within last N days (`null` = no limit) |
| `unlocked_media` | Always excludes `media_id` values present in `stg_chat_unlocks` |

### PowerShell launchers

| Script | Description |
|--------|-------------|
| `run_media_origin_tracker.ps1` | Single run; optional `-OriginDaysLast N` |
| `run_media_origin_tracker_by_days.ps1` | Runs for **30, 60, 90, 180, 365** days (override with `-Days`) |

```powershell
.\run_media_origin_tracker.ps1
.\run_media_origin_tracker.ps1 -OriginDaysLast 90
.\run_media_origin_tracker.ps1 -AuthorId 180951488

.\run_media_origin_tracker_by_days.ps1
.\run_media_origin_tracker_by_days.ps1 -Days 30,90
```

Both scripts:

- Read `author_id` from `chat_thread` in `creds.env` (unless `-AuthorId` is passed).
- Open `data/web.db` directly in **read-only** mode (safe while scraper holds a write lock).
- Substitute `author_filter` and `origin_days_filter` into the SQL template at runtime.
- Log `last_n_days` to the console (`none` when no day filter is applied; per-window value in the by-days script).

Parameters shared by both: `-HomeDirectory`, `-SqlPath`, `-CredsPath`, `-DuckDbExe`, `-Writable`.

## Incremental load logic

**Chat / wall inserts** use a per-author timestamp watermark: only rows with `createdAt` / `postedAt` outside the existing min/max for that author are inserted.

**Wall scroll stop:** before scrolling, reads `max(postedAt)` for the author from `stg_wall_posts`. After each API batch (newest-first / `publish_date_desc`), stops when `hasMore=false`, when the batch’s newest `postedAt` is at or below that high watermark, or when the batch inserts zero rows. Avoids scrolling into older backfill territory (`postedAt < min`) after incremental catch-up.

**Chat scroll stop** (scroll **up**, API `order=desc`): after reload, processes one batch at a time (waits for DuckDB load before next scroll). Stops when:

1. `hasMore=false`, or
2. Batch newest `createdAt` ≤ pre-run DB oldest (reached existing history), or
3. Two consecutive zero-insert batches fully inside the pre-run `[oldest .. newest]` range (duplicate territory), or
4. No API response after 15 scrolls.

**Media dimension** (`refreshSrcMediaDim` + `updateMediaDimHist`) runs after each chat batch and recalculates SCD Type 2 history for media IDs in that batch. Only batch-affected rows are appended to `media_dim_history`; older runs are pruned to the last **N** distinct `extract_ts` values (`media_dim_history_retain_runs` in `creds.env`, default **5**).

Prune groups by **`extract_ts`** (one timestamp per chat scrape session, shared by all scroll batches in that run). When a new scrape introduces a **6th** distinct `extract_ts` (with default `retain_runs=5`), all rows for the oldest `extract_ts` bucket are **deleted**. Earlier scrapes with ≤5 runs keep everything; wall/purchases modes do not touch `media_dim_history`.

**Important:** `DELETE` only removes rows logically — it does **not** shrink `web.db` on disk. Dead storage accumulates until `CHECKPOINT` + `VACUUM` (see **Database maintenance**).

**JSON trimming** before load:

- `media`: drops `files`, `videoSources`; keeps `id`, `type`, `duration`, etc.
- Wall posts: drops `isMarkdownDisabled`, `fundRaising`, `linkedPosts` on save.
- `read_json_auto(..., union_by_name=true)` tolerates optional API keys (e.g. `replyToMessage`).
- Table columns missing from a JSON batch insert as `NULL` via explicit column lists.

## DuckDB concurrency

- **Scraper writing:** do not open `web.db` for writes in DuckDB CLI while `web_scrape.js` is running.
- **Reporting scripts:** `run_media_origin_tracker*.ps1` use `-readonly` by default and can run alongside the scraper.
- Only one `DuckDBInstance.create(dbPath)` per Node process.

## Database maintenance

Chat scrape **prune** deletes old `media_dim_history` rows frequently, but DuckDB keeps that space allocated until compaction.

| Step | Effect |
|------|--------|
| `DELETE` (prune) | Fewer visible rows; file size usually **unchanged** |
| `CHECKPOINT` | Merges `web.db.wal` into the main database file |
| `VACUUM` | Reclaims dead blocks and can **shrink** `web.db` |

Run compaction when the scraper and DuckDB CLI are **not** holding a write lock:

```powershell
.\compact_web_db.ps1
```

Logs to `logs/compact_web_db_*.log`. Override data root with `$env:WEB_SCRAPE_HOME` (same as scrape scripts).

**When to run:** once after upgrading from pre–nav-v31 history bloat (~600 MB → ~55 MB typical); then optionally after chat scrapes that pruned, or weekly if `web.db` grows on `Z:` sync. `VACUUM` on a network drive can take minutes — not chained into `scrape_chat.ps1` by default.

Direct Node usage:

```powershell
node compact_web_db.js Z:\STUDY\web_scrape\data\web.db
```

### Inspect size and row counts (read-only)

`analyze_web_db.js` reports file/WAL size, table row counts, `media_dim_history` runs, approximate JSON payload sizes, and `PRAGMA database_size`. Opens **read-only** — safe while the scraper is running.

```powershell
node analyze_web_db.js
node analyze_web_db.js Z:\STUDY\web_scrape\data\web.db
node analyze_web_db.js --deep
```

`--deep` adds per-column size estimates and `pragma_storage_info` segment dumps (useful when the file is large but `COUNT(*)` is small — dead blocks from prune `DELETE`s).

Override path with `$env:WEB_SCRAPE_DB` or pass the `.db` path as the last argument.

## dbt models

| Model | Description |
|-------|-------------|
| `dbt_src_media_dim` | Incremental media rows from `stg_chat_messages` outside existing dim range |
| `dbt_media_dim` | SCD Type 2 media dimension with delete/reactivation handling |
| `dbt_media_dim_history` | Snapshot of current `dbt_media_dim` |

Sources: `dbt/webDataELT/models/src.yaml` (adjust database/schema to match your DuckDB attach name).

## Example queries

**Latest chat date for a media ID:**

```sql
SELECT max(date(cast(cm.createdAt AS timestamp)))
FROM stg_chat_messages cm,
     unnest(cm.media) AS u(m)
WHERE json_extract_string(cm.fromUser, '$.id') = '253745725'
  AND m.id = 4241839416;
```

(`unnest` belongs in `FROM`, not `WHERE`.)

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `Usage: node web_scrape.js <chat\|wall\|purchases>` | Pass `chat`, `wall`, or `purchases` as first argument |
| `ERR_AMBIGUOUS_MODULE_SYNTAX` | Scraper uses `main()` wrapper — do not add top-level `await` outside it |
| `Cannot open file … used by another process` | Stop scraper before write access; use reporting PS1 scripts for read-only queries |
| `Cannot launch in-memory database in read-only mode` | Use `run_media_origin_tracker*.ps1` (opens `web.db` directly, not `:memory:`) |
| `unknown key "replyToMessage"` | Ensure `union_by_name=true` on `read_json_auto` |
| `Could not find key "hasCustomPreview"` | Media load uses `json_extract` in `getTgtInsertParts` |
| `Table … does not have column "isMarkdownDisabled"` | Inserts use explicit column lists, not `INSERT BY NAME` with extra JSON fields |
| Login submit redirects to `/my/chats/send` | Post-captcha submit runs only when the **login form** (`input[type="email"]` + password) is visible and chat UI (`.b-chats__scrollbar`) is not ready. Skipped when already on chat thread without login form, or when chat UI is loaded |
| Wrong author loaded from `creds.env` | Comment inactive lines with `//` or `#`; only non-comment lines are parsed by `loadCredsEnv()` |
| `The browser is already running for …testChromeSession` | Stale `lockfile` / `DevToolsActivePort` / `Singleton*`, or Puppeteer Chromium still holding the profile. Script kills orphan `.cache\puppeteer` chrome, clears dead locks, or reuses a live session — see **Chromium / profile session** above |
| Chromium shows **Profile error occurred** | Usually stale locks or a crashed prior session. Script auto-repairs locks and relaunches once. If it persists: stop orphan Puppeteer Chrome (command above), then rename `data\testChromeSession` → `testChromeSession.bak` and rerun (re-login required) |
| Chromium disconnects on `Opening chat thread:` | **nav-v49+** — stealth on by default, `--disable-gpu` on Windows, warm-up + retry nav. Log: `nav-v49`, `Puppeteer ready (stealth)`. Set `puppeteer_stealth=0` only for debugging |
| `TimeoutError: Timed out after waiting` at launch | **nav-v47+** kills zombie Chromium after each failed attempt. Close stuck Puppeteer windows; log should show `Chromium executable: ...\.cache\puppeteer\...` |
| Page loads only after focusing/restoring Chromium | Chromium throttles background/occluded windows on Windows. Script uses anti-throttle launch flags and one-time `focusScrapeWindow()` before initial login |
| `web.db` huge but `COUNT(*)` on `media_dim_history` is small | Prune `DELETE`s are logical only; run `.\compact_web_db.ps1` with scraper/CLI stopped. Run `node analyze_web_db.js --deep` to compare logical row counts vs on-disk segments. Copying `web.db` without its `.wal` can show stale row counts until checkpointed |

Errors are also written to `logs/error_log_<timestamp>.log`.

## Project layout

```
web_scrape/
  node_script/
    web_scrape.js                      # scraper (chat | wall | purchases)
    web_scrape_repl.js                 # interactive REPL
    package.json                       # node deps (npm install here)
  scrape_chat.ps1
  scrape_wall.ps1
  scrape_purchases.ps1
  compact_web_db.ps1                   # CHECKPOINT + VACUUM web.db
  compact_web_db.js
  analyze_web_db.js                    # read-only size/row-count report (--deep for storage segments)
  run_media_origin_tracker.ps1         # single media-origin report
  run_media_origin_tracker_by_days.ps1 # report for 30/60/90/180/365-day windows
  node_modules/
  dbt/
    profiles.example.yml
    webDataELT/
      models/
  job_reqs_book_matcher/               # unrelated subproject
```

On `Z:\STUDY\web_scrape` (data root): `data/`, `logs/`, `sql_script/`.

## License

Private / personal use. Respect platform terms of service and rate limits.
