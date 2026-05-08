# Installation Guide

Complete step-by-step setup for AI Job Scanner. Estimated time: **20–30 minutes** (mostly waiting for Google Cloud setup).

---

## Prerequisites

- A Windows, Mac, or Linux computer that stays on (for scheduled scans)
- A Gmail account that receives job alert emails
- A web host with FTP access and PHP support (for the live dashboard — optional but recommended)

---

## Step 1 — Install Node.js

1. Go to [nodejs.org](https://nodejs.org)
2. Download the **LTS** version (left green button)
3. Run the installer with default settings
4. Verify in a terminal:

```bash
node --version   # should show v18.x.x or higher
```

---

## Step 2 — Get an Anthropic API Key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Sign up or log in
3. Click **API Keys** → **Create Key**
4. Copy the key (starts with `sk-ant-`) — you won't see it again
5. Add some credits under **Billing** (start with $5–10; each scan costs ~$0.05–0.15)

Set the key as an environment variable:

**Windows (permanent):**
1. Search "environment variables" in Start menu
2. Click **Edit the system environment variables**
3. Click **Environment Variables**
4. Under **User variables**, click **New**
5. Name: `ANTHROPIC_API_KEY`, Value: `sk-ant-your-key`
6. Click OK through all dialogs

**Mac/Linux (permanent):**
```bash
echo 'export ANTHROPIC_API_KEY=sk-ant-your-key' >> ~/.zshrc
source ~/.zshrc
```

---

## Step 3 — Clone the repository

```bash
git clone https://github.com/yourusername/ai-job-scanner.git
cd ai-job-scanner
```

Or download as a ZIP from GitHub and extract it.

---

## Step 4 — Create your config.json

```bash
cp config.json.template config.json
```

Open `config.json` and fill in your details:

```json
{
  "ownerPassword": "choose-a-secret-password",
  "gmailLabel": "Job Alerts",
  "salaryFloor": 150000,
  "preferredLocations": ["Remote"],
  "acceptableHybridStates": ["CA", "NY"],
  "ftpRemoteDir": "jobs",
  "resume": "Your Name — Your Title\n\nYour resume text here..."
}
```

**Config fields explained:**

| Field | Description | Example |
|---|---|---|
| `ownerPassword` | Password to unlock CRM controls on the dashboard | `"mySecret123"` |
| `gmailLabel` | Gmail label name where job emails live | `"Job Alerts"` |
| `salaryFloor` | Minimum salary — jobs below this score lower | `150000` |
| `preferredLocations` | Preferred work arrangements | `["Remote"]` |
| `acceptableHybridStates` | States where hybrid is acceptable | `["TX", "CO"]` |
| `ftpRemoteDir` | Server folder for dashboard upload | `"jobs"` |
| `resume` | Your full resume as plain text | See template |

> **Tip for the resume field:** Paste your resume as a single string. Use `\n` for line breaks. The more detail you provide, the better the scoring.

---

## Step 5 — Set up Gmail

### 5a. Create a Gmail label

1. In Gmail, click the **+** next to Labels in the left sidebar
2. Name it exactly what you put in `config.json` (default: `Job Alerts`)
3. Create a filter: **Settings → Filters → Create new filter**
4. In the **From** field enter:
   ```
   jobalerts-noreply@linkedin.com OR jobs-noreply@linkedin.com OR noreply@jobright.ai OR alerts@builtin.com OR donotreply@match.indeed.com
   ```
5. Click **Next** → check **Skip the Inbox** and **Apply label: Job Alerts** → **Create filter**

From now on all job alert emails bypass your inbox and land in the label automatically.

### 5b. Set up Gmail OAuth (one-time, ~5 minutes)

You need a Google Cloud project to give the scanner read-only Gmail access.

**Create a Google Cloud project:**
1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Click **Select a project** → **New Project** → name it `Job Scanner` → **Create**

**Enable the Gmail API:**
1. Go to **APIs & Services → Library**
2. Search `Gmail API` → click it → **Enable**

**Configure OAuth consent screen:**
1. Go to **APIs & Services → OAuth consent screen**
2. Choose **External** → **Create**
3. Fill in App name (`Job Scanner`), your email for support and developer contact
4. Click **Save and Continue** through all steps
5. On **Test users**, add your Gmail address → **Save**

**Create OAuth credentials:**
1. Go to **APIs & Services → Credentials**
2. Click **+ Create Credentials → OAuth client ID**
3. Application type: **Desktop app** → Name: `Job Scanner` → **Create**
4. Click **Download JSON** → rename to `gmail_credentials.json`
5. Move `gmail_credentials.json` into your `ai-job-scanner` folder

**Authorize the scanner:**
```bash
node setup_gmail.js
```

Your browser will open. Sign in with your Gmail, click **Allow**. You'll see a success message and `gmail_token.json` will be created.

> **Note:** Google will show a warning that the app isn't verified. This is normal for personal scripts. Click **Advanced → Go to Job Scanner (unsafe)** to proceed.

---

## Step 6 — Test the scanner

```bash
node scan.js --test
```

This runs with 5 sample jobs, no Gmail or Claude API calls. Verify:
- The HTML file opens in your browser
- Cards render correctly
- Owner login works with your password from `config.json`

---

## Step 7 — Configure FTP upload (optional but recommended)

If you have a web host, the scanner can publish your dashboard automatically.

**Find your FTP credentials** in your hosting control panel (look for FTP Accounts).

```bash
node setup_ftp.js
```

Enter your FTP hostname, username, password, and the remote folder path.

**Upload the PHP status API:**
Use your FTP client (FileZilla, CoreFTP, etc.) to upload `server/status_api.php` to your jobs folder on the server.

**Test the upload:**
```bash
node scan.js --test
```

You should see `FTP upload SUCCESS` in the terminal.

---

## Step 8 — Run for real

```bash
node scan.js 7
```

This scans the last 7 days of emails. On first run it may take 3–5 minutes depending on how many emails are in your label. Every subsequent run is much faster because of deduplication.

---

## Step 9 — Schedule daily runs (Windows)

Right-click `setup_task_scheduler.bat` and choose **Run as administrator**.

This creates a Windows Task Scheduler job called `JobMatchScanner` that runs `node scan.js 1` every morning at 7am automatically.

**Useful commands:**
```
schtasks /run /tn "JobMatchScanner"      # Run immediately
schtasks /delete /tn "JobMatchScanner"   # Remove the task
```

**Mac/Linux (cron):**
```bash
crontab -e
# Add this line:
0 7 * * * cd /path/to/ai-job-scanner && node scan.js 1 >> scan.log 2>&1
```

---

## Troubleshooting

**"config.json not found"**
Run `cp config.json.template config.json` and fill in your details.

**"gmail_token.json not found"**
Run `node setup_gmail.js` first.

**"ANTHROPIC_API_KEY not set"**
Set the environment variable (see Step 2). Open a new terminal after setting it.

**"No emails found"**
Try a longer window: `node scan.js 14`. Check that your Gmail label name in `config.json` exactly matches the label in Gmail (case-sensitive).

**"Emails found but no job listings extracted"**
Check `debug_email_1.txt` (created on failure) to see the raw email content. The extraction prompt may need updating for a new email format.

**FTP upload fails**
Run `node list_ftp.js` to see the actual folder structure on your server and verify `ftpRemoteDir` in `ftp_config.json` is correct.

**Dashboard cards don't render**
Open browser console (F12). If you see a `SyntaxError`, check for unusual characters in your resume field in `config.json` — backticks (`` ` ``) in particular need to be removed or replaced.

**Google "app not verified" warning**
Click **Advanced → Go to Job Scanner (unsafe)**. This is expected for personal OAuth applications in testing mode.

---

## Updating your resume

Edit `config.json` and update the `resume` field. The new resume will be used for scoring on the next run. Run `node scan.js 1 --all` to re-score recent jobs against your updated resume.

---

## Adding new job sources

To add a new email source (e.g. Dice, Glassdoor), add their sender address to the Gmail filter in Step 5a, then open `scan.js` and add their format description to the extraction prompt in the `extractJobs` function. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.
