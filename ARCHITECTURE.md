# Architecture & Design Decisions

A deep dive into how AI Job Scanner works and why it's built the way it is.

---

## System overview

```
┌─────────────────────────────────────────────────────────────┐
│                    DAILY SCHEDULED RUN                      │
│                  (Windows Task Scheduler)                   │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                     scan.js                                 │
│                                                             │
│  1. Load config.json                                        │
│  2. Fetch Gmail label → filter new message IDs              │
│  3. For each new email → call Claude (extract jobs)         │
│  4. Batch all jobs → call Claude (score + rank)             │
│  5. Save scanned IDs, append job history                    │
│  6. Generate HTML dashboard                                 │
│  7. Upload via FTP                                          │
└──────┬──────────────┬──────────────────────┬────────────────┘
       │              │                      │
       ▼              ▼                      ▼
  Gmail API      Claude API            FTP Server
  (read-only)    (Anthropic)        (your web host)
                                           │
                                           ▼
                               ┌───────────────────────┐
                               │  job_matches.html      │
                               │  status_api.php        │
                               │  job_status.json       │
                               └───────────────────────┘
                                           │
                               ┌───────────┴───────────┐
                               │   Browser (any device) │
                               │   markjgrover.com/jobs │
                               └───────────────────────┘
```

---

## Key design decisions

### Zero npm dependencies

The entire application — Gmail OAuth, HTTPS requests, base64 decoding, HTML generation, FTP upload — is written against Node.js built-in modules only (`https`, `net`, `fs`, `path`, `child_process`).

**Why:** Every npm package is a potential supply chain attack, a version conflict, a breaking change, and a maintenance burden. For a tool that runs on a personal machine and handles Gmail OAuth tokens, minimizing the dependency surface is a security and reliability choice.

The tradeoff is slightly more verbose code in places (the FTP client is ~80 lines of TCP socket management that `ftp-client` would handle in 5). Worth it.

---

### Gmail label as the data source (not sender filtering)

Early versions filtered by sender addresses (`jobalerts-noreply@linkedin.com`, etc.). The current version reads from a Gmail label instead.

**Why:**
- More reliable — if LinkedIn changes their sender address, the label filter still works
- Cleaner — the user controls what goes in the label via Gmail's own filter UI
- Faster — fetching by label ID is a single Gmail API call vs. a complex query string
- Extensible — adding a new source just means adding it to the Gmail filter, not editing code

---

### Per-email extraction (not batch)

Each email is sent to Claude individually for job extraction, rather than batching multiple emails together.

**Why:** Email formats vary dramatically by source. LinkedIn bundles 10–15 jobs in plain text with tracking URLs. Indeed sends one job per email with the title in the subject line. Jobright includes salary ranges and match percentages. Sending them individually with a format-aware prompt produces much more reliable extraction than asking Claude to handle mixed formats in a single call.

The cost: more API calls. The benefit: near-100% extraction accuracy per source.

---

### Deduplication via message ID

Every processed Gmail message ID is stored in `scanned_ids.json` with a timestamp and subject line. On each run, the scanner fetches the full message list from the label but only downloads and processes messages with IDs not in the local store.

**Why this matters:** Without deduplication, every daily run reprocesses every email in the label window, re-calling Claude for extraction and ranking. With deduplication, day 2 onwards processes only new emails — typically 5–10 emails vs. 30–50. This reduces API cost by ~80% and cuts runtime from 4–5 minutes to under 60 seconds on most days.

**Design choice:** IDs are stored locally (not on the server) because they're machine-specific. The server only stores job application statuses.

---

### Status persistence via PHP + JSON (not a database)

Job application statuses are stored in `job_status.json` on the web server, read and written via `status_api.php`.

**Why not SQLite or a proper database:** Shared hosting typically doesn't give you database access via FTP, and spinning up a database for a personal tool is unnecessary overhead. A flat JSON file handled by PHP works for hundreds of tracked applications and requires zero database setup.

**Why not localStorage:** The dashboard needs to be readable from multiple devices (phone, laptop, tablet). Browser localStorage is device-specific. Server-side JSON is the simplest cross-device solution that doesn't require a real backend.

**Security model:** The GET endpoint (reading statuses) is public — anyone who can see the dashboard can see your application status. The POST endpoint (writing statuses) requires the `X-Auth-Token` header with your password. This is intentional: the dashboard is designed to be shareable (you might want a recruiter to see your ranked jobs) but write-protected.

---

### HTML report as a self-contained file

The dashboard is a single HTML file with all job data, CSS, and JavaScript embedded inline. No external JS frameworks, no build step, no CDN dependencies (except Google Fonts).

**Why:** It works offline, it uploads as a single FTP transfer, it can be opened locally as `file://` for testing, and it requires zero build tooling. The job data is embedded as a JSON constant at the top of the script block, which is regenerated on each scan run.

**The tradeoff:** The file is regenerated completely on each run, which means any status changes made via the dashboard need to be persisted server-side (hence `status_api.php`) — they can't live in the HTML itself. This separation of concerns (static presentation + dynamic state) is the right architecture for this use case.

---

### FTP over SFTP/SCP

The upload uses plain FTP via a custom Node.js TCP socket client rather than SFTP or SCP.

**Why:** The target audience is people on shared hosting plans (Spaceship, Bluehost, Namecheap, etc.). These hosts universally support plain FTP on port 21. SFTP requires SSH access, which shared hosting rarely provides. SCP requires the same. FTP is the lowest common denominator that works everywhere.

The Node.js FTP client uses the `net` module to implement the FTP protocol directly (PASV mode, CWD navigation, STOR transfer) rather than shelling out to curl, because curl's handling of special characters in passwords on Windows PowerShell is unreliable.

---

### Scoring weights

Jobs are scored 0–100 against your resume using four weighted criteria:

| Criterion | Weight | Rationale |
|---|---|---|
| Title & seniority alignment | 35% | A Principal TPM who gets matched to a junior coordinator wastes time regardless of other factors |
| Skills overlap | 30% | The core match quality signal |
| Remote/location fit | 20% | A high-match job that requires relocation is effectively a low-match job |
| Salary fit | 15% | Below-floor roles waste application effort |

These weights are configurable via `config.json` in spirit — the prompt reads `salaryFloor`, `preferredLocations`, and `acceptableHybridStates` dynamically. More granular weight control is a potential future enhancement.

---

## Data flow diagram

```
Gmail label
    │
    ├── Already seen? ──YES──► Skip (dedup)
    │
    └── NO
         │
         ▼
    Fetch full email
         │
         ▼
    Claude extraction prompt
    (format-aware per source)
         │
         ▼
    Structured job objects
    [title, company, location, salary, source, url, snippet]
         │
         ▼
    Claude ranking prompt
    (resume + config scoring weights)
         │
         ▼
    Ranked jobs
    [+ score, rationale, strengths, gaps, rank]
         │
         ├──► Append to job_history.json
         ├──► Mark email IDs in scanned_ids.json
         ├──► Generate job_matches.html
         └──► FTP upload to web host
```

---

## Security considerations

**What has access to what:**
- `gmail_token.json` — grants read-only Gmail access. Never commit to git. Refresh tokens are long-lived; rotate by re-running `setup_gmail.js`.
- `config.json` — contains your resume and dashboard password. Never commit to git.
- `ftp_config.json` — contains FTP credentials. Never commit to git.
- `status_api.php` — publicly accessible endpoint. Reads are unauthenticated. Writes require the owner password as a header token.

**What the scanner can't do:**
- It requests `gmail.readonly` scope only — it cannot send, delete, or modify emails
- It has no write access to any Google service
- It doesn't store email content beyond the current run

**Threat model:** This is a personal tool running on a machine you control. It's not designed to be hardened against adversarial users. The main risks are credential exposure (mitigated by `.gitignore`) and the dashboard password being weak (mitigated by your choice of password).

---

## Extending the scanner

### Adding a new job source

1. Add their sender to your Gmail filter
2. Open `scan.js` and find the `extractJobs` function
3. Add a description of the email format to the extraction prompt:
   ```
   - SourceName (sender@domain.com): describe the format here
   ```
4. Add a filter button to the dashboard in `generateReport`:
   ```javascript
   <button class="filter-btn" onclick="filterGrid('SourceName',this,'jobGrid')">SourceName</button>
   ```

### Modifying scoring criteria

Edit `config.json`:
- `salaryFloor` — adjust your minimum salary
- `acceptableHybridStates` — add/remove states where hybrid is acceptable
- `preferredLocations` — change work arrangement preferences

For more fundamental scoring changes, edit the ranking prompt in the `rankJobs` function in `scan.js`.

### Running on Linux/Mac

Everything works on Linux and Mac with one change: replace the Windows-specific auto-open command in `main()`:
```javascript
// Replace:
execSync(`start "" "${OUTPUT_FILE}"`);
// With:
execSync(`open "${OUTPUT_FILE}"`);   // Mac
execSync(`xdg-open "${OUTPUT_FILE}"`); // Linux
```

And use cron instead of Task Scheduler for scheduling.
