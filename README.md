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

sql_script/media_origin_date_tracker_multi_author.sql  →  approx wall-post origin date per chat message (one row per message containing the media)
```

| Component | Role |
|-----------|------|
| `web_scrape.js` | Browser scrape + DuckDB load (`chat`, `wall`, or `purchases` mode) |
| `data/web.db` | DuckDB database (staging + dimension tables) |
| `data/config.env` | Credentials, `chat_thread`, `wall_profile`, `of_web` (one author at a time) |
| `data/testChromeSession/` | Persistent Chrome profile (cookies / session) |
| `local_run/` | One-click scrape launchers (`scrape_*.ps1`) |
| `local_run/local_setup/` | Author switchers, force-backfill / debug toggles, clear `expired_ts` for active author |
| `sql_script/` | Ad-hoc DuckDB analysis, media-origin trackers, clear-expired soft-deletes |
| `data/scripts/` | `compact_web_db` / `analyze_web_db` maintenance |
| `dbt/webDataELT/` | dbt models for media dimension ELT |

Data root defaults to `P:\all_scripts\oyf_scrape` (set in `web_scrape.js` as `homeDirectory`). Scripts and scrapers can run from this repo while data lives on that path.

## Prerequisites

- **Node.js** 18+ (22+ tested)
- **DuckDB CLI** (for `run_media_origin_tracker*.ps1`; default path in scripts: `C:\Users\dsouzaankit\Downloads\duckdb_cli-windows-amd64\duckdb.exe`)
- **Python venv** + **dbt-duckdb** (optional, for dbt models)
- Chromium via Puppeteer (`puppeteer`, `puppeteer-extra`, stealth plugin)

## Setup

### 1. Install Node dependencies

`node_modules` must live on a **local disk** — the project root is on pCloud (`P:`),
and cloud/network drives lock files during sync (`EBUSY`) and slow module loading.
Install into `%LOCALAPPDATA%\oyf_scrape` (the `.ps1` wrappers expose it to Node via
`NODE_PATH`, and the DB scripts resolve it via `WEB_SCRAPE_NODE_HOME`):

```powershell
$dep = "$env:LOCALAPPDATA\oyf_scrape"
New-Item -ItemType Directory -Force -Path $dep | Out-Null
Copy-Item -Force node_script\package.json, node_script\package-lock.json $dep
npm install --prefix $dep
```

To use a different location, set `WEB_SCRAPE_NODE_HOME` to the folder that contains
`node_modules` (the wrappers derive `NODE_PATH` from it).

### 2. Data layout

```
{homeDirectory}/          # default: P:\all_scripts\oyf_scrape
  data/
    config.env             # secrets + URLs (not committed)
    web.db                # DuckDB file
    api_out.json          # latest API batch (overwrite), or NDJSON append log when scrape_debug=1
    api_out.load.json     # current batch for DuckDB when scrape_debug=1
    api_out_wall_*.json   # wall batch temp files (deleted right after DuckDB load)
    testChromeSession/    # Chrome user data dir
  logs/
    error_log_*.log
  sql_script/
    media_origin_date_tracker_multi_author.sql
```

Override data root for reporting scripts with `-HomeDirectory` or `$env:WEB_SCRAPE_HOME`.

### 3. Create `data/config.env`

If you have an existing `data/creds.env`, rename it to `config.env` (same keys and format).

```env
of_usern=your_email
of_paswd=your_password
of_web=https://...com
chat_thread=https://...com/my/chats/chat/<author_id>
wall_profile=https://...com/<creator>
media_dim_history_retain_runs=5
wall_scrape_max_age_days=730
wall_scrape_force_backfill=0
chat_scrape_force_backfill=0
purchases_scrape_force_backfill=0
scrape_debug=0

# alternate author (ignored)
// chat_thread=https://...com/my/chats/chat/<other_author_id>
// wall_profile=https://...com/<other_creator>
```

Control which creator is scraped by setting the active `chat_thread` and `wall_profile` lines. Run **one author at a time**.

**Scrape time window:** set `wall_scrape_max_age_days` in `data/config.env` (default **730** ≈ 2 years). **One key** controls scroll bounds and the oldest-batch cutoff for **wall**, **chat**, and **purchases** — there are no separate chat/purchases keys. Example: `wall_scrape_max_age_days=365` limits scraping to the last year. Change the value, save `config.env`, then run the scraper again. Rows already in `web.db` that are older than the new window are **not** deleted automatically.

**Comment lines:** `web_scrape.js` uses `loadConfigEnv()` which skips blank lines and lines starting with `#` or `//` before parsing. Comment out inactive authors with `//` (or `#`) so only the active URLs are loaded into `process.env`.

**Switch author (one-click):** `local_run/local_setup/set_config_author.ps1` uncomments the matching `chat_thread` + `wall_profile` pair for an `author_id` and comments out all other author pairs. Writes `data/config.env.bak` before updating.

Scripts live under `local_run/local_setup/`.

**Add author (interactive):** `add_config_author.ps1` prompts for `chat_thread` and `wall_profile` URLs, appends the pair to `config.env` (commented), writes `set_config_author_<author_id>.ps1`, and optionally activates the author.

```powershell
& '.\local_run\local_setup\add_config_author.ps1'
& '.\local_run\local_setup\add_config_author.ps1' -Activate
& '.\local_run\local_setup\set_config_author.ps1' -List
& '.\local_run\local_setup\set_config_author.ps1' -AuthorId 180951488
& '.\local_run\local_setup\set_config_author.ps1'                    # interactive menu
& '.\local_run\local_setup\set_config_force_backfill.ps1' -Enable    # maiden-style wall/chat/purchases gap backfill
& '.\local_run\local_setup\set_config_force_backfill.ps1' -Disable   # default incremental stop
& '.\local_run\local_setup\set_config_force_backfill.ps1' -Status
& '.\local_run\local_setup\set_config_force_backfill.ps1'            # toggle all three keys (default)
& '.\local_run\local_setup\set_config_debug.ps1' -Enable             # api_out.json append-only NDJSON
& '.\local_run\local_setup\set_config_debug.ps1' -Disable
& '.\local_run\local_setup\set_config_debug.ps1' -Status
& '.\local_run\local_setup\clear_expired_for_active_author.ps1'      # undo expired_ts for active author
& '.\local_run\local_setup\clear_expired_for_active_author.ps1' -WhatIf
& '.\local_run\local_setup\clear_expired_for_active_author.ps1' -AuthorId 253745725
```

**Debug (`scrape_debug`):** when `1`, chat/purchases **append** each API batch to `data/api_out.json` as **NDJSON** (one JSON array per line; file truncated at scrape start). DuckDB still loads only the current batch from `data/api_out.load.json`. Default `0` overwrites `api_out.json` each batch.

**Wall batch files:** wall does **not** use `api_out.json`. Each non-empty in-window batch writes `data/api_out_wall_<timestamp>.json`, loads it into DuckDB, then **deletes that file immediately**. Empty batches create no file. Leftover `api_out_wall_*.json` files only appear if the process dies between write and delete (no end-of-run cleanup sweep). `scrape_debug` does not change wall temp-file behavior.

**One-click per author:**

| Shortcut | Author |
|----------|--------|
| `local_run/local_setup/set_config_author_180951488.ps1` | `180951488` |
| `local_run/local_setup/set_config_author_253745725.ps1` | `253745725` |

Add another author with `add_config_author.ps1` (recommended), or copy an existing pair + `set_config_author_<author_id>.ps1` manually.

The numeric segment in `chat_thread` (`/chat/<author_id>`) is also used by the media-origin reporting scripts to filter results.

### 4. Initialize DuckDB tables

Bootstrap staging tables from a sample API response (save one batch to `api_out.json` first):

```sql
CREATE TABLE IF NOT EXISTS stg_chat_messages AS
SELECT * FROM read_json_auto('P:/all_scripts/oyf_scrape/data/api_out.json', union_by_name=true)
LIMIT 0;

CREATE TABLE IF NOT EXISTS stg_wall_posts AS
SELECT * FROM read_json_auto('P:/all_scripts/oyf_scrape/data/api_out.json', union_by_name=true)
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
| `local_run/scrape_chat.ps1` | `node node_script/web_scrape.js chat` (tees to `logs/scrape_chat_*.log`) |
| `local_run/scrape_wall.ps1` | `node node_script/web_scrape.js wall` |
| `local_run/scrape_purchases.ps1` | `node node_script/web_scrape.js purchases`; then `run_media_origin_tracker_by_days_purchases.ps1` |
| `local_run/local_setup/add_config_author.ps1` | Interactive add author URLs + create `set_config_author_<author_id>.ps1` |
| `local_run/local_setup/set_config_author.ps1` | Activate one author in `data/config.env` (`chat_thread` + `wall_profile` pair) |
| `local_run/local_setup/set_config_force_backfill.ps1` | Toggle `wall_scrape_force_backfill`, `chat_scrape_force_backfill`, and `purchases_scrape_force_backfill` (disable high-watermark stop for gap backfill; chat/wall also soft-delete unseen ids progressively + final sweep) |
| `local_run/local_setup/set_config_debug.ps1` | Toggle `scrape_debug` — chat/purchases `api_out.json` append-only NDJSON (`api_out.load.json` for DuckDB) |
| `local_run/local_setup/clear_expired_for_active_author.ps1` | DuckDB CLI: clear `expired_ts` on chat + wall for active `chat_thread` author (`sql_script/clear_expired_for_author.sql`) |
| `local_run/local_setup/set_config_author_<author_id>.ps1` | One-click activate for a specific author — see **Switch author** |
| `data/scripts/compact_web_db.ps1` | `CHECKPOINT` + `VACUUM` on `data/web.db` (run **after** scraper/CLI close; see **Database maintenance**) |
| `sql_script/open_web_db.ps1` | DuckDB CLI: attach `data/web.db` as schema `web` (write when possible; `-ReadOnly` to force) |

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

**One-shot:** `& '.\local_run\scrape_purchases.ps1'` or `node node_script/web_scrape.js purchases`  
**Artifacts:** `data/api_out.json` (last batch), `logs/scrape_purchases_*.log` (PS1 tee), `logs/error_log_*.log`

**config.env**

| Key | Role |
|-----|------|
| `of_web` | Site or creator base URL; purchases navigates here **after** chat-thread login (`of_web` home ok post-login) |
| `purchases_page` | Optional override for homepage URL |
| `purchases_tab_selector` | Optional; default `#Purchased` (first click) |
| `purchases_click_selector` | Optional; default `#purchased-chat` (Messages; second click) |

If a click misses, set the matching selector in `config.env` to the live CSS id/class.

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

**Wall:** reads DB bounds **before navigation**; API is **newest-first** (`publish_date_desc`). Scrolls **down** for older posts. Typical incremental run exits early when landing batches are duplicates below DB `max(postedAt)`; otherwise scrolls to the **730-day** cutoff or `hasMore=false`.

**Purchases:** navigates to `of_web` (its home is ok after login — **not** used as login entry), **clicks** `#Purchased` then `#purchased-chat` (overrides: `purchases_tab_selector`, `purchases_click_selector`), scrolls **down**, loads `stg_chat_unlocks`.

**URL rules:** never navigate to the `of_web` **home** for **login** (anti-bot). Use `chat_thread` for both login passes. The `of_web` home is fine for purchases navigation after login; override with `purchases_page` if needed.

On successful completion (scroll loop ends), the script closes DuckDB, closes the browser, and exits.

Entry point is `async function main()` so CommonJS `require()` works with async browser/DB calls.

### Browser tips

- Non-headless by default (`headless: false`).
- Do not **minimize** the window during scrape. If the Chromium window is behind other apps or minimized, loading can stall — mostly **Chromium background/occlusion throttling** on Windows, not the site blocking automation. Launch flags mitigate this (anti-throttle flags).
- **`focusScrapeWindow()`** — Win32 foreground **once per Chromium launch**, **after** initial chat navigation lands (for captcha). Budget: `scrape_os_focus_budget` in `config.env` (default **1**; set **0** to disable OS focus).
- **Login:** two passes (`initial` + `before scrape`). Pass 2 skips re-navigation only when `.b-chats__scrollbar` is visible after pass 1 (log: `Chat UI ready; skipping re-navigation`). Purchases then goes to `of_web` — not back through `wall_profile`.
- **After login:** chat stays on `chat_thread`; wall → `wall_profile`; purchases → `of_web` / `purchases_page`.
- Leftmost tab is active.

### Chromium / profile session

Persistent profile source: `data/testChromeSession/` on the data root (cookies/session).

**Cloud/network drive (`P:` / pCloud):** Chromium often **crashes on navigation** when the profile lives on a cloud-synced or mapped network drive. The scraper **automatically uses a local copy** at `%LOCALAPPDATA%\web_scrape\testChromeSession` (one-time **auth-only** seed from `P:` — not a full 140MB copy). On shutdown it **syncs session cookies/login back** to `data/testChromeSession/` on `P:` (disable with `sync_chrome_profile_to_p=0`). Override with `chrome_user_data_dir` or `use_local_chrome_profile=0` in `config.env` to force the remote profile. Set `refresh_local_chrome_profile=1` once to wipe and re-seed the local profile.

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

Maps chat `media_id` to an approximate wall-post date (`approx_origin_date`) by comparing media ID bands on wall posts. Each output row is one **message** that contains the media (deduped on `(author_id, media_id, chat_id)` internally). If the same `media_id` was sent in multiple messages, **all** matching messages appear (not just the latest).

**Output columns:** `msg_text`, `created_date`, `media_id`, `duration`, `msg_price`, `n_media`, `duration_ratio`, `approx_origin_date`, plus when the same `media_id` appears on the wall: `wall_date`, `wall_price` (staging `tipsAmount`; no separate PPV price column today), `wall_text` (null if not on wall).

**Dedup:** `QUALIFY` keeps one row per `(author_id, media_id, chat_id)` — re-sent promo clips in newer messages no longer collapse to a single “latest” row. `author_id` / `chat_id` are not selected in the report output.

**Inspect one media_id:** uncomment `media_id_filter` in the SQL file, e.g. `select unnest([4458229438::bigint]) as media_id`, then run `run_media_origin_tracker.ps1`.

**Expired messages:** rows with `expired_ts` set (after chat/wall force backfill) are excluded from the report and from wall-post interval bands. See **Who uses `expired_ts`** under incremental load logic.

**Edge case — non-monotonic wall `media_id`:** wall posts are not always ordered by increasing media id. The tracker builds day bands from `media_id_v2 = greatest(media_id, max_media_id_yet)` (running max by `postedAt`), then assigns each chat/unlock `media_id` to a day where `first_media_id_v2 <= id < last_media_id_v2`. If an **earlier** post uses a **higher** id than a later post, the later day’s band can collapse (empty range) and nearby chat ids fall into the **previous** day’s wider band. Example: wall `4508438257` on **Jun 13** after wall `4508468661` on **Jun 12** → Jun 13 band empty; chat `4508438273` can get `approx_origin_date` **Jun 11** instead of Jun 13. Treat `approx_origin_date` as approximate when wall ids go backwards in time.

**SQL:** `sql_script/media_origin_date_tracker_multi_author.sql`

Built-in optional filters (edit CTEs in the SQL file, or let PS1 inject values):

| CTE | Purpose |
|-----|---------|
| `author_filter` | Restrict to author id(s); PS1 sets from `config.env` `chat_thread` |
| `msg_text_filter` | Substring match on message text |
| `media_id_filter` | Specific media IDs |
| `origin_days_filter` | `approx_origin_date` within last N days (`null` = no limit) |
| `unlocked_media` | Always excludes `media_id` values present in `stg_chat_unlocks` |

### Purchases / unlocked media origin

**SQL:** `sql_script/media_origin_date_tracker_multi_author_purchases.sql` — same wall-band `approx_origin_date` logic, but sources **`stg_chat_unlocks`** (purchased media). Output: `msg_text`, `unlock_date`, `media_id`, `duration`, `msg_price`, `n_media`, `duration_ratio`, `approx_origin_date`, plus `wall_date` / `wall_price` / `wall_text` when that `media_id` is also on the wall (`author_id` / `unlock_id` used for dedup only, not selected).

**Note:** `last_n_days` filters on **`approx_origin_date`** (estimated wall-post date), not `unlock_date` (when you purchased). Use `-Days 365` or edit `origin_days_filter` in the SQL if recent unlocks have older wall origins.

| Script | Description |
|--------|-------------|
| `sql_script/run_media_origin_tracker_by_days_purchases.ps1` | Unlocked media for **30, 60, 90, 180, 365**-day `approx_origin_date` windows |

```powershell
.\sql_script\run_media_origin_tracker_by_days_purchases.ps1
.\sql_script\run_media_origin_tracker_by_days_purchases.ps1 -Days 365
```

`scrape_purchases.ps1` runs this tracker after a successful purchases scrape.

### PowerShell launchers (chat media)

| Script | Description |
|--------|-------------|
| `sql_script/run_media_origin_tracker.ps1` | Single run; optional `-OriginDaysLast N` |
| `sql_script/run_media_origin_tracker_by_days.ps1` | Runs for **30, 60, 90, 180, 365** days (override with `-Days`) |

```powershell
.\sql_script\run_media_origin_tracker.ps1
.\sql_script\run_media_origin_tracker.ps1 -OriginDaysLast 90
.\sql_script\run_media_origin_tracker.ps1 -AuthorId 180951488

.\sql_script\run_media_origin_tracker_by_days.ps1
.\sql_script\run_media_origin_tracker_by_days.ps1 -Days 30,90
```

Both scripts:

- Read `author_id` from `chat_thread` in `config.env` (unless `-AuthorId` is passed).
- Open `data/web.db` directly in **read-only** mode (safe while scraper holds a write lock).
- Substitute `author_filter` and `origin_days_filter` into the SQL template at runtime.
- Log `last_n_days` to the console (`none` when no day filter is applied; per-window value in the by-days script).

Parameters shared by both: `-HomeDirectory`, `-SqlPath`, `-ConfigPath`, `-DuckDbExe`, `-Writable`.

## Incremental load logic

**Chat / wall inserts** use a per-author timestamp watermark plus ID dedup:

- Insert when `createdAt` / `postedAt` is **older** than the author’s DB min or **newer** than the DB max (catch-up / backfill).
- **Or** when the message/post `id` is not already in the table (gap-fill inside the existing time range).
- Chat: `NOT EXISTS` on `id` only (one thread per scrape).
- Wall: `NOT EXISTS` on `(author.id, id)`.
- Purchases: `NOT EXISTS` on `id` (account-wide unlock feed).

**Wall scroll stop** (scroll **down**, API `publish_date_desc` — newest batch first):

**`insertCount`** — rows actually inserted by DuckDB (`INSERT … RETURNING 1` row count). `0` means the batch was all duplicates / filtered out; scroll-stop rules use this value.

1. **Before navigation** — `getWallPostedAtBoundsMs(author, cutoff)` reads `min`/`max` `postedAt` for the author **only where** `postedAt >= now - wall_scrape_max_age_days` (default **730** days / ~2 years) **and** `expired_ts IS NULL`. `min` is logged only (not used to stop scroll). `max` is the **high watermark** for scroll-stop.
2. **Landing batches** — API responses during profile load are processed like scroll batches. If a stop condition is met before navigation finishes, the scroll loop is **not** restarted.
3. **Per batch** — only posts inside the window are inserted (`filterWallPostsByMinPostedAt`). Inserts also gap-fill via timestamp (`postedAt` &lt; min or &gt; max) and ID dedup (`NOT EXISTS` on `author.id` + `id`).
4. **Stop when** any of:
   - `hasMore=false`
   - batch newest (raw API batch) is before the 730-day cutoff (entire page below window)
   - batch newest **within the window** is **strictly older than** DB **high watermark** (`max(postedAt)` in the window) **and** `insertCount === 0`
5. **No low-watermark stop** — once scrolling starts, it is **not** stopped merely because the batch is below DB `min(postedAt)`; scroll continues toward the 730-day cutoff unless rule 4 applies.
6. **Maiden author** (no rows for `author.id`): high watermark is null — rule 4 does not apply; scroll continues until cutoff or `hasMore=false`.
7. **Keep scrolling** when `insertCount > 0` (new or gap-fill rows), even if batch newest is below the high watermark.
8. **Safety cap** — 500 scroll iterations per run.

**Typical caught-up incremental run:** API returns the latest posts first. Landing batches have `batchMax < dbMax`, all IDs already in DB (`insertCount === 0`) → high-watermark stop fires immediately; no scroll loop.

**Gap backfill tradeoff:** High-watermark stop at the top can end the run **before** scrolling to older pages below DB `min` (e.g. missing posts between DB oldest and the 730-day cutoff). Those gaps insert via `postedAt < min` only if a run reaches those API batches (`insertCount > 0` prevents early stop). For a full history sweep within the window, set `wall_scrape_force_backfill=1`, `chat_scrape_force_backfill=1`, and/or `purchases_scrape_force_backfill=1` in `config.env` (or `& '.\local_run\local_setup\set_config_force_backfill.ps1' -Enable` to set all three).

| `wall_scrape_force_backfill` | `0` (default) — incremental; stop when batch newest &lt; DB high watermark with no new rows |
| `wall_scrape_force_backfill` | `1` — skip high-watermark stop; scroll for gap backfill until cutoff or `hasMore=false` |
| `chat_scrape_force_backfill` | `0` (default) — incremental; stop when batch newest &lt; DB high watermark with no new rows |
| `chat_scrape_force_backfill` | `1` — skip high-watermark stop; scroll for gap backfill until 730-day cutoff or `hasMore=false` |
| `purchases_scrape_force_backfill` | `0` (default) — incremental; stop when batch newest &lt; DB high watermark with no new rows |
| `purchases_scrape_force_backfill` | `1` — skip high-watermark stop; scroll for gap backfill until 730-day cutoff or `hasMore=false` |

**Force backfill expiration (chat + wall):** when `chat_scrape_force_backfill=1` or `wall_scrape_force_backfill=1`:

1. **Per batch:** when the next API batch’s newest timestamp is **older** than the previous batch’s newest, soft-delete in-window rows with timestamp **strictly newer than that next-batch newest** that were not seen yet (`expired_ts` set). Logs **`earliest expired mark date`** and **`soft-deleted id(s): …`** each iteration so you can **Ctrl+C** once past dates/ids you care about. Batches that are not older (equal/newer / out-of-order) skip expire and do not advance the frontier.
2. **Final sweep:** on a full stop (`hasMore=false` or 730-day cutoff — not the 500-scroll safety cap), expire any remaining in-window ids still not seen (also logs cleared ids). Incomplete runs keep progressive soft-deletes and skip the final sweep.

Every API batch tracks returned `id` values. IDs seen again clear `expired_ts` (`markScrapeIdsActive`). Incremental runs (`force_backfill=0`) never expire rows.

**Caveat:** chat/wall UI scroll often returns **sparse, non-contiguous** pages. Soft-delete keys off “not in this pass’s API batches,” not “gone from the GUI,” so force backfill can expire rows you still see in the site UI. Prefer reviewing the soft-deleted id logs before relying on expiration.

**Undo soft-deletes:** DuckDB CLI script clears `expired_ts` on `stg_chat_messages` + `stg_wall_posts` for the active `chat_thread` author (or `-AuthorId`). Close the scraper / other DuckDB writers first if the DB is locked.

```powershell
& '.\local_run\local_setup\clear_expired_for_active_author.ps1'
& '.\local_run\local_setup\clear_expired_for_active_author.ps1' -WhatIf   # read-only active/expired counts
& '.\local_run\local_setup\clear_expired_for_active_author.ps1' -AuthorId 253745725
```

SQL: `sql_script/clear_expired_for_author.sql` (PS1 injects `author_id` into the `author_filter` unnest line).

| Column | Table | Meaning |
|--------|-------|---------|
| `expired_ts` | `stg_chat_messages`, `stg_wall_posts` | `NULL` = active (API-visible); timestamp = soft-deleted (progressive older-batch and/or final backfill) |

**Who uses `expired_ts`:**

| Consumer | Filters `expired_ts IS NULL`? | Why |
|----------|-------------------------------|-----|
| Scroll-stop bounds (`getChatCreatedAtBoundsMs`, `getWallPostedAtBoundsMs`) | **Yes** | High watermark must reflect the newest **API-visible** row. If a withdrawn message still held `max(createdAt)`, incremental runs could think they are caught up and stop early. |
| Media origin tracker SQL | **Yes** | Report reflects the **current** chat feed and wall bands, not withdrawn promos. |
| `media_dim` / `media_dim_history` (`refreshSrcMediaDim`) | **No** | Historical ledger — media stays recorded even if the source message was later withdrawn. |
| `INSERT … NOT EXISTS` dedup | **No** | Expired rows still block duplicate inserts; re-seen API ids revive via `expired_ts = NULL` instead of re-inserting. |

**Note:** `730` in `wall_scrape_max_age_days` is a **day count** (time window), not a row count. Logged post count (e.g. `260 posts`) is unrelated. The same window applies to **chat** and **purchases** (`createdAt`).

### Scalability at 1M+ rows (not implemented)

The scraper is tuned for **incremental** loads at typical scale: hundreds–low thousands of rows per author, wall capped at ~2 years (`wall_scrape_max_age_days=730`). Logic is correct at any size; **performance** degrades once a target table (or one author’s slice of a multi-author table) approaches **1M+ rows**.

#### Where time goes today

| Operation | When | Cost at 1M+ |
|-----------|------|-------------|
| `getWallPostedAtBoundsMs` / `getChatCreatedAtBoundsMs` / `getChatUnlocksCreatedAtBoundsMs` | Once per scrape (before scroll) | Full scan / aggregate on `stg_*` (wall uses `author.id`; chat may scan whole table if no `chatUserId` column; purchases is account-wide on `createdAt`) |
| `loadWallPostsToDb` / `loadChatToDb` | Every API batch (~10–50 rows) | **Per incoming row:** two correlated `min`/`max` subqueries + one `NOT EXISTS` ID probe |
| `loadChatUnlocksToDb` | Purchases batches | Per-row `min`/`max` + `NOT EXISTS` ID dedup |
| `refreshSrcMediaDim` + `updateMediaDimHist` | After chat batches with inserts | Scales with batch media IDs + history table size (separate from wall) |

Insert SQL pattern (wall example — chat is analogous on `createdAt` / `fromUser`):

```sql
-- Simplified: each wp row re-runs these subqueries
WHERE postedAt < (SELECT min(postedAt) FROM stg_wall_posts WHERE json_extract_string(author,'$.id') = ...)
   OR postedAt > (SELECT max(postedAt) FROM stg_wall_posts WHERE json_extract_string(author,'$.id') = ...)
   OR NOT EXISTS (SELECT 1 FROM stg_wall_posts t WHERE t.id = wp.id AND json_extract_string(t.author,'$.id') = ...)
```

**Scroll-stop bounds** already use struct fields (`author.id` in `getWallPostedAtBoundsMs`), but **insert** filters still use `json_extract_string(...)` — so manual indexes on `author.id` / `fromUser.id` help pre-scroll aggregates more than they help per-batch inserts unless insert SQL is aligned.

| Table rows (relevant slice) | Typical batch load |
|-----------------------------|-------------------|
| &lt; ~10k | Sub-second |
| ~10k–100k | Noticeable; repeated scans per batch |
| 1M+ | Multi-second batches; full history scrape impractical without refactor |

Monitor growth: `node data/scripts/analyze_web_db.js` (read-only; safe during scrape).

#### Refactor roadmap (priority)

**1. Bind watermarks from JS (lowest effort)** — bounds are already computed before scroll (`getWallPostedAtBoundsMs`, `getChatCreatedAtBoundsMs`, `getChatUnlocksCreatedAtBoundsMs`). Pass `minMs` / `maxMs` as SQL literals in the `INSERT … SELECT` instead of per-row subqueries. Scroll-stop and insert logic stay in sync; removes ~2× table scans per batch row.

**2. Batch-scoped ID anti-join (medium)** — one lookup for the whole batch instead of `NOT EXISTS` per row:

```sql
WITH batch AS (
  SELECT * FROM read_json_auto('…', union_by_name=true)
),
existing AS (
  SELECT t.id FROM stg_wall_posts t
  INNER JOIN (SELECT DISTINCT id, author.id AS author_id FROM batch) b
    ON t.id = b.id AND t.author.id = b.author_id
)
SELECT … FROM batch wp
WHERE … -- timestamp rules
  AND NOT EXISTS (SELECT 1 FROM existing e WHERE e.id = wp.id);
```

Wall dedup is `(author.id, id)`. Chat insert dedup is **`id` only** (table-wide) — at 1M+ chat rows across threads, consider scoping to `fromUser.id` to match watermark filters.

**3. Align filters with indexable columns (medium)** — use `author.id` / `fromUser.id` in insert `WHERE` (same as bounds queries), or add persisted generated columns, e.g. `author_id BIGINT`, and index those. Required for indexes to help insert path.

**4. Indexes (manual; not created by this repo)** — create when scraper is **not** holding a write lock:

```sql
-- wall (multi-author)
CREATE INDEX IF NOT EXISTS idx_wall_author_id ON stg_wall_posts (author.id, id);
CREATE INDEX IF NOT EXISTS idx_wall_author_posted ON stg_wall_posts (author.id, postedAt);

-- chat (per-sender incremental + dedup if scoped)
CREATE INDEX IF NOT EXISTS idx_chat_fromuser_id ON stg_chat_messages (fromUser.id, id);
CREATE INDEX IF NOT EXISTS idx_chat_fromuser_created ON stg_chat_messages (fromUser.id, createdAt);

-- purchases (account-wide feed; watermark is global min/max)
CREATE INDEX IF NOT EXISTS idx_unlocks_created ON stg_chat_unlocks (createdAt);
```

Indexes speed up bounds queries and batch anti-joins; they **do not** fix per-row correlated subqueries if insert SQL is left unchanged.

**5. Larger changes (only if needed)** — staging table + `INSERT … SELECT` merge per run; per-author partition or separate tables; drop redundant ID dedup when scroll-stop guarantees no overlap (wall high-watermark path only inserts gap rows — still need ID dedup for gaps and maiden runs).

None of the above is implemented in `web_scrape.js` today; the correlated-subquery pattern was kept after a batch-CTE experiment proved correctness-sensitive.

**Chat scroll stop** (scroll **up**, API `order=desc` — newest batch first): after reload, processes one batch at a time (waits for DuckDB load before next scroll). Same rules as wall, adapted for `createdAt` / scroll-up. **`insertCount`** is the DuckDB `INSERT … RETURNING` row count.

1. **Before reload** — `getChatCreatedAtBoundsMs(author, cutoff)` reads `min`/`max` `createdAt` for the sender **only where** `createdAt >= now - wall_scrape_max_age_days` (default **730** days) **and** `expired_ts IS NULL`. `min` is logged only (not used to stop scroll). `max` is the **high watermark** for scroll-stop.
2. **Per batch** — only messages inside the window are inserted (`filterChatMessagesByMinCreatedAt`). Inserts also gap-fill via timestamp (`createdAt` &lt; min or &gt; max) and ID dedup.
3. **Stop when** any of:
   - `hasMore=false`
   - batch newest (raw API batch) is before the 730-day cutoff (entire page below window)
   - batch newest **within the window** is **strictly older than** DB **high watermark** (`max(createdAt)` in the window) **and** `insertCount === 0` — **skipped** when `chat_scrape_force_backfill=1`
4. **No low-watermark stop** — scroll is **not** stopped merely because the batch is below DB `min(createdAt)`; scroll continues toward the 730-day cutoff unless rule 3 applies.
5. **Keep scrolling** when `insertCount > 0` (new or gap-fill rows), even if batch newest is below the high watermark.
6. **Safety cap** — 500 scroll iterations per run.

**Typical caught-up incremental chat run:** landing batches are duplicates below DB `max(createdAt)` → high-watermark stop fires immediately (unless force backfill).

**Maiden chat** (no rows / null bounds): high watermark stop does not apply; scroll continues until cutoff or `hasMore=false`.

**Purchases scroll stop** (scroll **down**, `/posts/paid/chat`): same rules as wall/chat on account-wide `stg_chat_unlocks` (`createdAt`, `getChatUnlocksCreatedAtBoundsMs`). **`insertCount`** + ID dedup on `id`. Stops on `hasMore=false`, 730-day cutoff, high watermark (unless `purchases_scrape_force_backfill=1`), or 500-scroll safety cap. No low-watermark stop.

**Media dimension** (`refreshSrcMediaDim` + `updateMediaDimHist`) runs after each chat batch and recalculates SCD Type 2 history for media IDs in that batch. **`media_dim` is a historical ledger** — it reads all `stg_chat_messages` rows (including `expired_ts` set) that match the incremental watermark rules. Only batch-affected rows are appended to `media_dim_history`; older runs are pruned to the last **N** distinct `extract_ts` values (`media_dim_history_retain_runs` in `config.env`, default **5**).

Prune groups by **`extract_ts`** (one timestamp per chat scrape session, shared by all scroll batches in that run). When a new scrape introduces a **6th** distinct `extract_ts` (with default `retain_runs=5`), all rows for the oldest `extract_ts` bucket are **deleted**. Earlier scrapes with ≤5 runs keep everything; wall/purchases modes do not touch `media_dim_history`.

**Important:** `DELETE` only removes rows logically — it does **not** shrink `web.db` on disk. Dead storage accumulates until `CHECKPOINT` + `VACUUM` (see **Database maintenance**).

**JSON trimming** before load:

- `media`: drops `files`, `videoSources`; keeps `id`, `type`, `duration`, etc.
- Wall posts: drops `isMarkdownDisabled`, `fundRaising`, `linkedPosts` on save.
- `read_json_auto(..., union_by_name=true)` tolerates optional API keys (e.g. `replyToMessage`).
- Table columns missing from a JSON batch insert as `NULL` via explicit column lists.

## DuckDB concurrency

- **One scrape at a time** on the default data root (`P:\all_scripts\oyf_scrape`): shared `web.db`, `config.env`, Chrome profile, and `api_out.json` — do not run two `scrape_*.ps1` processes together.
- **Scraper writing:** do not open `web.db` for writes in DuckDB CLI while `web_scrape.js` is running.
- **Reporting scripts:** `run_media_origin_tracker*.ps1` use `-readonly` by default and can run alongside the scraper.
- Only one `DuckDBInstance.create(dbPath)` per Node process.
- **Parallel scrapes (advanced):** only with separate `WEB_SCRAPE_HOME` **and** separate `chrome_user_data_dir` per process (one author + one mode each). Not a supported default workflow.

## Database maintenance

Chat scrape **prune** deletes old `media_dim_history` rows frequently, but DuckDB keeps that space allocated until compaction.

| Step | Effect |
|------|--------|
| `DELETE` (prune) | Fewer visible rows; file size usually **unchanged** |
| `CHECKPOINT` | Merges `web.db.wal` into the main database file |
| `VACUUM` | Reclaims dead blocks and can **shrink** `web.db` |

Run compaction when the scraper and DuckDB CLI are **not** holding a write lock:

```powershell
.\data\scripts\compact_web_db.ps1
```

Logs to `logs/compact_web_db_*.log`. Override data root with `$env:WEB_SCRAPE_HOME` (same as scrape scripts).

**When to run:** once after upgrading from pre–nav-v31 history bloat (~600 MB → ~55 MB typical); then optionally after chat scrapes that pruned, or weekly if `web.db` grows on `P:` sync. `VACUUM` on a cloud/network drive can take minutes — not chained into `local_run/scrape_chat.ps1` by default.

Direct Node usage:

```powershell
node .\data\scripts\compact_web_db.js P:\all_scripts\oyf_scrape\data\web.db
```

### Inspect size and row counts (read-only)

`analyze_web_db.js` reports file/WAL size, table row counts, `media_dim_history` runs, approximate JSON payload sizes, and `PRAGMA database_size`. Opens **read-only** — safe while the scraper is running.

```powershell
node .\data\scripts\analyze_web_db.js
node .\data\scripts\analyze_web_db.js P:\all_scripts\oyf_scrape\data\web.db
node .\data\scripts\analyze_web_db.js --deep
```

`--deep` adds per-column size estimates and `pragma_storage_info` segment dumps (useful when the file is large but `COUNT(*)` is small — dead blocks from prune `DELETE`s).

Override path with `$env:WEB_SCRAPE_DB` or pass the `.db` path as the last argument.

## TBD

### `media_chat_link` SCD (media ↔ message linkage)

**Problem:** `media_dim` grain is `(author_id, media_id)` only. `valid_from_ts` comes from message `createdAt`, but **`chat_id` is not stored**. `refreshSrcMediaDim` uses `SELECT DISTINCT author_id, media_id`, so the same clip in multiple messages collapses to one row per batch. SCD there tracks **re-sends over time**, not **which messages** held the media.

**Today:** per-message linkage is answered by querying `stg_chat_messages` directly (see media origin tracker and example queries below).

**Proposed:** bridge table **`media_chat_link`** (and optional `media_chat_link_history`) with SCD Type 2 at grain **`(author_id, media_id, chat_id)`**:

| Column | Source |
|--------|--------|
| `author_id` | `fromUser.id` |
| `media_id` | `unnest(media).id` |
| `chat_id` | `stg_chat_messages.id` |
| `valid_from_ts` | `createdAt` |
| `valid_to_ts` | parent message `expired_ts`, or open while active |
| `is_current` | `valid_to_ts IS NULL` |
| `extract_ts` | scrape session timestamp (same pattern as `media_dim`) |

**Intersecting intervals:** one `media_id` in multiple `chat_id` values yields multiple rows; intervals `[valid_from_ts, valid_to_ts)` can overlap in calendar time. Overlap query (sketch):

```sql
SELECT a.media_id, a.chat_id AS chat_a, b.chat_id AS chat_b
FROM media_chat_link a
JOIN media_chat_link b
  ON a.author_id = b.author_id AND a.media_id = b.media_id AND a.chat_id < b.chat_id
WHERE a.valid_from_ts < coalesce(b.valid_to_ts, current_timestamp)
  AND b.valid_from_ts < coalesce(a.valid_to_ts, current_timestamp);
```

**Population (not implemented):** derive from `unnest(media)` on chat load; revive when `expired_ts` clears on the parent message; close `valid_to_ts` when the message is soft-deleted after force backfill. Keep **`media_dim`** as the media-attribute historical ledger; use **`media_chat_link`** for message linkage.

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
| Wrong author loaded from `config.env` | Comment inactive lines with `//` or `#`; only non-comment lines are parsed by `loadConfigEnv()` |
| `The browser is already running for …testChromeSession` | Stale `lockfile` / `DevToolsActivePort` / `Singleton*`, or Puppeteer Chromium still holding the profile. Script kills orphan `.cache\puppeteer` chrome, clears dead locks, or reuses a live session — see **Chromium / profile session** above |
| Chromium shows **Profile error occurred** | Usually stale locks or a crashed prior session. Script auto-repairs locks and relaunches once. If it persists: stop orphan Puppeteer Chrome (command above), then rename `data\testChromeSession` → `testChromeSession.bak` and rerun (re-login required) |
| Chromium disconnects on `Opening chat thread:` | **nav-v49+** — stealth on by default, `--disable-gpu` on Windows, warm-up + retry nav. Log: `nav-v49`, `Puppeteer ready (stealth)`. Set `puppeteer_stealth=0` only for debugging |
| `TimeoutError: Timed out after waiting` at launch | **nav-v47+** kills zombie Chromium after each failed attempt. Close stuck Puppeteer windows; log should show `Chromium executable: ...\.cache\puppeteer\...` |
| Page loads only after focusing/restoring Chromium | Chromium throttles background/occluded windows on Windows. Script uses anti-throttle launch flags and one-time `focusScrapeWindow()` before initial login |
| `web.db` huge but `COUNT(*)` on `media_dim_history` is small | Prune `DELETE`s are logical only; run `.\data\scripts\compact_web_db.ps1` with scraper/CLI stopped. Run `node .\data\scripts\analyze_web_db.js --deep` to compare logical row counts vs on-disk segments. Copying `web.db` without its `.wal` can show stale row counts until checkpointed |
| Multiple **Enter** presses to close a PS1 window | Several scripts end with `Read-Host` so a double-clicked console stays open. **Stacked prompts:** `scrape_chat.ps1` / `scrape_wall.ps1` call `run_media_origin_tracker_by_days.ps1`, which **always** prompts in a `finally` block; the parent prompts again **only on failure** — so a failed tracker after a successful scrape needs **two** Enters. **Early Enter:** a keypress while Node/DuckDB output is still streaming may not reach the prompt; wait for `Press Enter to…` before pressing. **Integrated terminal:** `set_config_force_backfill.ps1` skips the prompt when stdin is redirected; other scripts may still prompt |

Errors are also written to `logs/error_log_<timestamp>.log`.

## Project layout

```
web_scrape/
  node_script/
    web_scrape.js                      # scraper (chat | wall | purchases)
    web_scrape_repl.js                 # interactive REPL
    package.json                       # node deps manifest (installed locally; see Setup)
    package-lock.json
  local_run/
    scrape_chat.ps1
    scrape_wall.ps1
    scrape_purchases.ps1
    local_setup/
      add_config_author.ps1             # interactive add author + one-click script
      set_config_author.ps1             # switch active author in config.env
      set_config_force_backfill.ps1      # toggle wall/chat/purchases scrape_force_backfill
      set_config_debug.ps1              # toggle scrape_debug (api_out.json append-only NDJSON)
      clear_expired_for_active_author.ps1  # undo expired_ts via DuckDB CLI + clear_expired_for_author.sql
      set_config_author_180951488.ps1   # one-click activate author_id 180951488
      set_config_author_253745725.ps1   # one-click activate author_id 253745725
      set_config_author_24569249.ps1   # one-click activate author_id 24569249
  data/scripts/
    compact_web_db.ps1                 # CHECKPOINT + VACUUM web.db
    compact_web_db.js
    analyze_web_db.ps1
    analyze_web_db.js                  # read-only size/row-count report (--deep for storage segments)
  sql_script/
    clear_expired_for_author.sql       # clear expired_ts for one author (chat + wall)
    run_media_origin_tracker.ps1       # single media-origin report
    run_media_origin_tracker_by_days.ps1  # report for 30/60/90/180/365-day windows
    run_media_origin_tracker_by_days_purchases.ps1  # unlocked media origin (stg_chat_unlocks)
    media_origin_date_tracker_multi_author.sql
    media_origin_date_tracker_multi_author_purchases.sql
    open_web_db.ps1                    # interactive DuckDB CLI on web.db
  dbt/
    profiles.example.yml
    webDataELT/
      models/
  job_reqs_book_matcher/               # unrelated subproject
```
On `P:\all_scripts\oyf_scrape` (data root): `data/`, `logs/`, `sql_script/`.

## License

Private / personal use. Respect platform terms of service and rate limits.
