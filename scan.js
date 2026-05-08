#!/usr/bin/env node
// ============================================================
//  AI Job Match Scanner — created by Mark Grover  v3.0
//  - Reads from "Job Alerts" Gmail label
//  - Deduplication via scanned_ids.json
//  - Job history in job_history.json
//  - CRM dashboard: owner login, status tracking, pipeline, weekly report
//  - SFTP auto-upload to your-domain.com/jobs/
//  - Supports LinkedIn, Jobright, Built In, Indeed
//  - Ranking: remote-first, $150k salary floor, YourState hybrid only
//
//  Usage:
//    node scan.js          scan last 7 days (default)
//    node scan.js 14       scan last 14 days
//    node scan.js 7 --all  ignore dedup, reprocess everything
// ============================================================

const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ── CONFIG ───────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const GMAIL_TOKEN_FILE = path.join(__dirname, "gmail_token.json");
const SCANNED_IDS_FILE = path.join(__dirname, "scanned_ids.json");
const JOB_HISTORY_FILE = path.join(__dirname, "job_history.json");
const OUTPUT_FILE = path.join(__dirname, "job_matches.html");
const FTP_CONFIG_FILE = path.join(__dirname, "ftp_config.json");
const CONFIG_FILE = path.join(__dirname, "config.json");
const DAYS_BACK = parseInt(process.argv[2] || "7");
const RESCAN_ALL = process.argv.includes("--all");
const TEST_MODE = process.argv.includes("--test");

// ── LOAD USER CONFIG ─────────────────────────────────────────
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error("\n  config.json not found.");
    console.error(
      "  Copy config.json.template to config.json and fill in your details.\n",
    );
    process.exit(1);
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const required = ["ownerPassword", "gmailLabel", "resume"];
    const missing = required.filter((k) => !cfg[k]);
    if (missing.length) {
      console.error(
        `\n  config.json is missing required fields: ${missing.join(", ")}\n`,
      );
      process.exit(1);
    }
    return cfg;
  } catch (e) {
    console.error("\n  config.json is invalid JSON:", e.message, "\n");
    process.exit(1);
  }
}
const CFG = loadConfig();
const LABEL_NAME = CFG.gmailLabel || "Job Alerts";
const RESUME = CFG.resume;
const OWNER_PW = CFG.ownerPassword;
const SALARY_FLOOR = CFG.salaryFloor || 0;
const HYBRID_STATES = (CFG.acceptableHybridStates || []).map((s) =>
  s.toUpperCase(),
);
const PREFERRED_LOCS = (CFG.preferredLocations || ["Remote"]).map((s) =>
  s.toLowerCase(),
);

// ── HELPERS ──────────────────────────────────────────────────
function httpsRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function log(emoji, msg) {
  console.log(`${emoji}  ${msg}`);
}

// Generate a stable jobId from emailId + title
function makeJobId(emailId, title) {
  const safe = (title || "unknown")
    .replace(/\W+/g, "_")
    .slice(0, 40)
    .toLowerCase();
  return `${emailId}_${safe}`;
}

// ── DEDUPLICATION ─────────────────────────────────────────────
function loadScannedIds() {
  if (!fs.existsSync(SCANNED_IDS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SCANNED_IDS_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveScannedIds(ids) {
  fs.writeFileSync(SCANNED_IDS_FILE, JSON.stringify(ids, null, 2));
}

// ── JOB HISTORY ───────────────────────────────────────────────
function loadJobHistory() {
  if (!fs.existsSync(JOB_HISTORY_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(JOB_HISTORY_FILE, "utf8"));
  } catch {
    return [];
  }
}
function appendJobHistory(rankedJobs, emailsProcessed) {
  const history = loadJobHistory();
  history.unshift({
    scannedAt: new Date().toISOString(),
    emailsProcessed,
    jobCount: rankedJobs.length,
    jobs: rankedJobs,
  });
  fs.writeFileSync(JOB_HISTORY_FILE, JSON.stringify(history, null, 2));
  const total = history.reduce((n, r) => n + r.jobCount, 0);
  log(
    "💾",
    `History: ${history.length} run(s), ${total} total jobs in job_history.json`,
  );
}

// ── GMAIL AUTH ────────────────────────────────────────────────
async function getAccessToken() {
  if (!fs.existsSync(GMAIL_TOKEN_FILE)) {
    console.error("\n  gmail_token.json not found. Run: node setup_gmail.js\n");
    process.exit(1);
  }
  const token = JSON.parse(fs.readFileSync(GMAIL_TOKEN_FILE));
  if (token.expiry_date && Date.now() > token.expiry_date - 60000) {
    log("🔄", "Refreshing Gmail token...");
    const params = new URLSearchParams({
      client_id: token.client_id,
      client_secret: token.client_secret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    }).toString();
    const res = await httpsRequest(
      {
        hostname: "oauth2.googleapis.com",
        path: "/token",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(params),
        },
      },
      params,
    );
    if (res.body.access_token) {
      token.access_token = res.body.access_token;
      token.expiry_date = Date.now() + res.body.expires_in * 1000;
      fs.writeFileSync(GMAIL_TOKEN_FILE, JSON.stringify(token, null, 2));
    }
  }
  return token.access_token;
}

// ── GMAIL API ─────────────────────────────────────────────────
async function gmailGet(accessToken, endpoint) {
  const res = await httpsRequest({
    hostname: "gmail.googleapis.com",
    path: `/gmail/v1/users/me/${endpoint}`,
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status !== 200)
    throw new Error(`Gmail API ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

function base64Decode(str) {
  return Buffer.from(
    str.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  ).toString("utf8");
}

function extractEmailBody(payload) {
  let plain = "",
    html = "";
  function walk(node) {
    if (!node) return;
    if (node.body && node.body.data) {
      const decoded = base64Decode(node.body.data);
      if (node.mimeType === "text/plain" && !plain) plain = decoded;
      if (node.mimeType === "text/html" && !html) html = decoded;
    }
    if (node.parts) node.parts.forEach(walk);
  }
  walk(payload);
  return { plain, html };
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, " ")
    .replace(/\s{3,}/g, "\n\n")
    .trim();
}

// ── FETCH EMAILS ──────────────────────────────────────────────
async function fetchJobEmails(accessToken) {
  const since = Math.floor(
    (Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000) / 1000,
  );
  const scannedIds = RESCAN_ALL ? {} : loadScannedIds();

  log("🏷️ ", `Looking up Gmail label: "${LABEL_NAME}"...`);
  const labelsRes = await gmailGet(accessToken, "labels");
  const label = (labelsRes.labels || []).find(
    (l) => l.name.toLowerCase() === LABEL_NAME.toLowerCase(),
  );

  let messageList = [];
  if (label) {
    const query = `label:${LABEL_NAME.replace(/ /g, "-")} after:${since}`;
    const res = await gmailGet(
      accessToken,
      `messages?q=${encodeURIComponent(query)}&maxResults=200`,
    );
    messageList = res.messages || [];
    log("📬", `Found ${messageList.length} email(s) in "${LABEL_NAME}"`);
  } else {
    log("⚠️ ", `Label not found — falling back to sender search`);
    const senders = [
      "jobalerts-noreply@linkedin.com",
      "jobs-noreply@linkedin.com",
      "no-reply@jobright.ai",
      "noreply@jobright.ai",
      "hello@jobright.ai",
      "donotreply@match.indeed.com",
      "jobalerts@indeed.com",
      "alerts@builtin.com",
      "jobs@builtin.com",
      "noreply@builtin.com",
    ];
    const query = `(${senders.map((s) => `from:${s}`).join(" OR ")}) after:${since}`;
    const res = await gmailGet(
      accessToken,
      `messages?q=${encodeURIComponent(query)}&maxResults=200`,
    );
    messageList = res.messages || [];
    log("📬", `Found ${messageList.length} email(s) via sender search`);
  }

  if (messageList.length === 0)
    return { emails: [], newCount: 0, skippedCount: 0 };

  const newMessages = messageList.filter((m) => !scannedIds[m.id]);
  const skippedCount = messageList.length - newMessages.length;

  if (skippedCount > 0)
    log("⏭️ ", `Skipping ${skippedCount} already-scanned email(s)`);
  if (newMessages.length === 0)
    return { emails: [], newCount: 0, skippedCount };
  log("🆕", `Processing ${newMessages.length} new email(s)...`);

  const emails = [];
  for (const msg of newMessages) {
    try {
      const full = await gmailGet(
        accessToken,
        `messages/${msg.id}?format=full`,
      );
      const subject =
        full.payload.headers?.find((h) => h.name === "Subject")?.value || "";
      const from =
        full.payload.headers?.find((h) => h.name === "From")?.value || "";
      const date =
        full.payload.headers?.find((h) => h.name === "Date")?.value || "";
      const { plain, html } = extractEmailBody(full.payload);
      const body = plain
        ? plain.slice(0, 5000)
        : stripHtml(html).slice(0, 5000);
      emails.push({ id: msg.id, subject, from, date, body });
    } catch (e) {
      log("⚠️ ", `Could not fetch ${msg.id}: ${e.message}`);
    }
  }
  return { emails, newCount: newMessages.length, skippedCount };
}

// ── CLAUDE API ────────────────────────────────────────────────
async function callClaude(system, user, maxTokens) {
  if (!ANTHROPIC_API_KEY) {
    console.error(
      "\n  ANTHROPIC_API_KEY not set. Run: set ANTHROPIC_API_KEY=sk-ant-...\n",
    );
    process.exit(1);
  }
  const body = JSON.stringify({
    model: "claude-opus-4-5",
    max_tokens: maxTokens || 2000,
    system,
    messages: [{ role: "user", content: user }],
  });
  const res = await httpsRequest(
    {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    body,
  );
  if (res.status !== 200)
    throw new Error(`Claude API ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function parseJsonArray(text) {
  const cleaned = text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  return match ? JSON.parse(match[0]) : [];
}

// ── EXTRACT JOBS ──────────────────────────────────────────────
async function extractJobs(emails) {
  log("🤖", `Extracting jobs from ${emails.length} new email(s)...`);
  const SKIP = [
    "learning spotlight",
    "green skills",
    "earth day",
    "newsletter",
    "webinar",
    "course of the week",
  ];
  const allJobs = [];

  for (let i = 0; i < emails.length; i++) {
    const e = emails[i];
    if (SKIP.some((k) => e.subject.toLowerCase().includes(k))) {
      log("⏭️ ", `Skipping: "${e.subject.slice(0, 55)}"`);
      continue;
    }
    let result;
    try {
      result = await callClaude(
        `You extract job listings from job alert emails. Return ONLY a raw JSON array, no markdown, no backticks.

Formats by source:
- LinkedIn (jobalerts-noreply@linkedin.com): bundles 6-15 jobs. Each shows title, company, location, "View job: <url>". Extract ALL.
- Jobright (jobright.ai): bundles 8-12 jobs. Each shows company, match%, title, salary, location. URLs often absent.
- Built In (builtin.com): bundles multiple jobs. Title, company, location.
- Indeed (match.indeed.com): ONE job per email. Title is in Subject line. Body has company, location, job type, description.

Each object must have exactly: title, company, location, salary (or ""), source (LinkedIn/Jobright/Built In/Indeed), url (or ""), snippet (1 sentence).
Return [] if no job listings found.`,
        `From: ${e.from}\nSubject: ${e.subject}\nDate: ${e.date}\n\n${e.body}`,
        2000,
      );
    } catch (err) {
      log("⚠️ ", `Email ${i + 1} error: ${err.message}`);
      continue;
    }
    try {
      const jobs = parseJsonArray(result);
      if (jobs.length > 0) {
        jobs.forEach((j) => {
          j.emailDate = e.date;
          j.emailId = e.id;
          j.jobId = makeJobId(e.id, j.title);
        });
        log(
          "✅",
          `Email ${i + 1}/${emails.length}: ${jobs.length} job(s) — ${e.subject.slice(0, 50)}`,
        );
        allJobs.push(...jobs);
      } else {
        log(
          "➖",
          `Email ${i + 1}/${emails.length}: no jobs — ${e.subject.slice(0, 50)}`,
        );
      }
    } catch (err) {
      log("⚠️ ", `Email ${i + 1} parse error: ${err.message}`);
      fs.writeFileSync(
        path.join(__dirname, `debug_email_${i + 1}.txt`),
        result,
      );
    }
  }
  return allJobs;
}

// ── RANK JOBS ─────────────────────────────────────────────────
async function rankJobs(jobs) {
  log("🎯", `Ranking ${jobs.length} job(s)...`);
  const BATCH = 15;
  let allRanked = [];

  for (let i = 0; i < jobs.length; i += BATCH) {
    const batch = jobs.slice(i, i + BATCH);
    let result;
    try {
      result = await callClaude(
        `You are a senior career coach scoring job listings against a resume. Score each job 0-100.

SCORING WEIGHTS:
1. Title & seniority alignment (35%): Match the candidate's target roles. Junior or clearly mismatched titles score low.
2. Skills overlap (30%): Match against the skills and experience in the resume.
3. Remote/location fit (20%): ${PREFERRED_LOCS.includes("remote") ? "Remote = full score." : ""} Hybrid in ${HYBRID_STATES.join(" or ") || "preferred states"} = acceptable, minor deduction. Hybrid elsewhere = heavy penalty. On-site = heavy penalty.
4. Salary fit (15%): ${SALARY_FLOOR > 0 ? `Salary at $${SALARY_FLOOR.toLocaleString()}+ = bonus. Below = penalty.` : "Score salary fit based on seniority."} No salary listed = neutral.

Return ONLY a raw JSON array, no markdown. Keep all original fields and add:
  score (0-100), rationale (2-3 sentences), strengths (array of 2-3 strings), gaps (array of 0-2 strings).
Sort by score descending.`,
        `RESUME:\n${RESUME}\n\nJOBS:\n${JSON.stringify(batch, null, 2)}`,
        6000,
      );
    } catch (err) {
      log(
        "⚠️ ",
        `Ranking batch ${Math.floor(i / BATCH) + 1} error: ${err.message}`,
      );
      continue;
    }
    try {
      allRanked.push(...parseJsonArray(result));
    } catch (err) {
      log("⚠️ ", `Ranking parse error: ${err.message}`);
      fs.writeFileSync(path.join(__dirname, "rank_debug.txt"), result);
    }
  }
  allRanked.sort((a, b) => (b.score || 0) - (a.score || 0));
  allRanked.forEach((j, i) => {
    j.rank = i + 1;
  });
  return allRanked;
}

// ── SFTP UPLOAD ───────────────────────────────────────────────
async function uploadToServer(localFile, remoteFilename) {
  if (!fs.existsSync(FTP_CONFIG_FILE)) {
    log(
      "WARNING",
      "ftp_config.json not found - skipping upload. Run node setup_ftp.js.",
    );
    return false;
  }
  const cfg = JSON.parse(fs.readFileSync(FTP_CONFIG_FILE));
  const remotePath =
    cfg.remoteDir.replace(/^\//, "").replace(/\/$/, "") + "/" + remoteFilename;
  const fileData = fs.readFileSync(localFile);
  const net = require("net");

  return new Promise((resolve) => {
    let dataPort = 0,
      dataServer = null;
    const cmd = net.createConnection(21, cfg.host);
    let buf = "";

    function send(line) {
      cmd.write(line + "\r\n");
    }

    function openDataServer() {
      return new Promise((res) => {
        dataServer = net.createServer();
        dataServer.listen(0, "0.0.0.0", () => {
          dataPort = dataServer.server
            ? dataServer.server.address().port
            : dataServer.address().port;
          res();
        });
      });
    }

    cmd.on("data", async (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\r\n");
      buf = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        const code = parseInt(line.slice(0, 3));

        if (code === 220) {
          send("USER " + cfg.user);
        } else if (code === 331) {
          send("PASS " + cfg.password);
        } else if (code === 230) {
          send("TYPE I");
        } else if (code === 200 || code === 215) {
          send("TYPE I");
        } else if (code === 200) {
          // Set up passive mode
          send("PASV");
        } else if (code === 227) {
          // Parse PASV response: (h1,h2,h3,h4,p1,p2)
          const m = line.match(/(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/);
          if (m) {
            const pasvHost = m[1] + "." + m[2] + "." + m[3] + "." + m[4];
            const pasvPort = parseInt(m[5]) * 256 + parseInt(m[6]);
            const dataConn = net.createConnection(pasvPort, pasvHost);
            dataConn.on("connect", () => {
              send("STOR " + remotePath);
            });
            dataConn.on("error", (e) => {
              log("WARNING", "FTP data connection error: " + e.message);
              cmd.destroy();
              resolve(false);
            });
            // Store dataConn reference for use when 150 received
            cmd._dataConn = dataConn;
          }
        } else if (code === 150) {
          // Server ready to receive - send the file
          if (cmd._dataConn) {
            cmd._dataConn.write(fileData);
            cmd._dataConn.end();
          }
        } else if (code === 226) {
          // Transfer complete
          send("QUIT");
        } else if (code === 221) {
          cmd.destroy();
          resolve(true);
        } else if (code >= 400) {
          log("WARNING", "FTP error: " + line.trim());
          cmd.destroy();
          resolve(false);
        }
      }
    });

    cmd.on("connect", () => {
      // Wait for 220 greeting
    });

    cmd.on("error", (e) => {
      log("WARNING", "FTP connection error: " + e.message);
      resolve(false);
    });

    cmd.on("close", () => {
      // If we haven't resolved yet, something went wrong
    });

    // After auth (230), use PASV mode
    // Override TYPE I handler to trigger PASV
    cmd.on("data", () => {}); // duplicate listener removed by Node automatically

    // Simplified state machine - re-wire
    cmd.removeAllListeners("data");
    let state = "GREETING";
    cmd.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\r\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const code = parseInt(line.slice(0, 3));
        if (code === 220 && state === "GREETING") {
          state = "USER";
          send("USER " + cfg.user);
        } else if (code === 331 && state === "USER") {
          state = "PASS";
          send("PASS " + cfg.password);
        } else if (code === 230 && state === "PASS") {
          state = "PWD";
          send("PWD");
        } else if (code === 257 && state === "PWD") {
          // PWD response tells us current dir e.g. 257 "/" or 257 "/home/user"
          const pwdMatch = line.match(/"([^"]+)"/);
          const currentDir = pwdMatch ? pwdMatch[1] : "/";
          log("OK ", "FTP current dir: " + currentDir);
          // Build absolute path from current dir + remoteDir
          const relDir = cfg.remoteDir.replace(/^\//, "").replace(/\/$/, "");
          // Try the configured path first; if it fails we log alternatives
          const parts = relDir.split("/").filter(Boolean);
          cmd._cwdParts = parts;
          cmd._cwdIndex = 0;
          // Log what we're about to try
          log("OK ", "FTP navigating to: " + parts.join(" -> "));
          state = "CWD";
          send("CWD " + parts[0]);
        } else if ((code === 250 || code === 200) && state === "CWD") {
          cmd._cwdIndex++;
          if (cmd._cwdIndex < cmd._cwdParts.length) {
            send("CWD " + cmd._cwdParts[cmd._cwdIndex]);
          } else {
            state = "TYPE";
            send("TYPE I");
          }
        } else if (code === 200 && state === "TYPE") {
          state = "PASV";
          send("PASV");
        } else if (code === 227 && state === "PASV") {
          state = "STOR";
          const m = line.match(/(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/);
          if (!m) {
            log("WARNING", "FTP: could not parse PASV");
            cmd.destroy();
            resolve(false);
            return;
          }
          const ph = m[1] + "." + m[2] + "." + m[3] + "." + m[4];
          const pp = parseInt(m[5]) * 256 + parseInt(m[6]);
          const dc = net.createConnection(pp, ph);
          dc.on("connect", () => {
            send("STOR " + remoteFilename);
          });
          dc.on("error", (e) => {
            log("WARNING", "FTP data error: " + e.message);
            cmd.destroy();
            resolve(false);
          });
          cmd._dc = dc;
        } else if (code === 150 && state === "STOR") {
          state = "WAIT";
          if (cmd._dc) {
            cmd._dc.write(fileData);
            cmd._dc.end();
          }
        } else if (code === 226 && state === "WAIT") {
          state = "QUIT";
          send("QUIT");
        } else if (code === 221 && state === "QUIT") {
          cmd.destroy();
          resolve(true);
        } else if (code === 550 && state === "CWD") {
          // CWD failed - log what we tried and suggest alternatives
          log("WARNING", "FTP CWD failed: " + line.trim());
          log(
            "WARNING",
            "Could not navigate to: " +
              cmd._cwdParts.slice(0, cmd._cwdIndex + 1).join("/"),
          );
          log(
            "TIP   ",
            "Try running: node list_ftp.js to see what folders exist on the server",
          );
          cmd.destroy();
          resolve(false);
        } else if (code >= 400) {
          log("WARNING", "FTP server error: " + line.trim());
          cmd.destroy();
          resolve(false);
        }
      }
    });
  });
}

// ── HTML REPORT ───────────────────────────────────────────────
function generateReport(jobs, skippedEmails) {
  const now = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const strong = jobs.filter((j) => j.score >= 70).length;
  const mid = jobs.filter((j) => j.score >= 50 && j.score < 70).length;
  // Escape backticks so they do not break the template literal embedding
  // Only escape backticks - dollar signs do NOT need escaping in template literals
  const jobsJson = JSON.stringify(jobs).replace(/`/g, "\\`");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Job Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:#F7F6F2;color:#1a1a18;min-height:100vh}
.page-header{background:#1a1a18;color:#F7F6F2;padding:2rem 2rem 1.75rem;display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:1rem}
.page-header h1{font-family:'DM Serif Display',serif;font-size:2.2rem;font-weight:400;margin-bottom:.25rem}
.page-header .subtitle{font-size:.85rem;color:#888}
.login-area{display:flex;gap:8px;align-items:center}
#loginBtn{background:transparent;border:1px solid #444;color:#ccc;border-radius:6px;padding:6px 14px;font-size:.82rem;cursor:pointer;font-family:inherit;transition:all .2s}
#loginBtn:hover{border-color:#888;color:#fff}
#loginBtn.active{background:#0F6E56;border-color:#0F6E56;color:#fff}
#ownerBadge{font-size:.75rem;color:#0F6E56;display:none}
.stats-bar{display:flex;gap:1.5rem;padding:1.25rem 2rem;background:#fff;border-bottom:1px solid #eee;flex-wrap:wrap}
.stat{display:flex;flex-direction:column}
.stat-val{font-size:1.8rem;font-weight:500;line-height:1}
.stat-lbl{font-size:.75rem;color:#888;margin-top:3px;text-transform:uppercase;letter-spacing:.05em}
.stat-val.green{color:#0F6E56}.stat-val.blue{color:#185FA5}.stat-val.amber{color:#854F0B}.stat-val.gray{color:#888}
.tabs{display:flex;padding:0 2rem;background:#fff;border-bottom:1px solid #eee}
.tab-btn{background:none;border:none;border-bottom:2px solid transparent;padding:.75rem 1.25rem;font-size:.9rem;cursor:pointer;color:#888;font-family:inherit;transition:all .2s}
.tab-btn.active{color:#1a1a18;border-bottom-color:#1a1a18}
.tab-pane{display:none;padding:1.5rem 2rem 3rem}
.tab-pane.active{display:block}
.filters{display:flex;gap:.6rem;flex-wrap:wrap;align-items:center;margin-bottom:1.5rem}
.filter-btn{background:#fff;border:1px solid #ddd;border-radius:20px;padding:4px 13px;font-size:.82rem;cursor:pointer;transition:all .15s;font-family:inherit;color:#555}
.filter-btn:hover,.filter-btn.active{background:#1a1a18;color:#fff;border-color:#1a1a18}
.filter-label{font-size:.8rem;color:#888;margin-right:.25rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:1.1rem}
.card{animation:fadeUp .3s ease both}
@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.card[data-hidden="true"]{display:none}
.card-inner{background:#fff;border-radius:10px;padding:1.1rem 1.2rem;border:1px solid #e8e8e4;height:100%;display:flex;flex-direction:column;gap:9px}
.card-inner.status-applied{border-left:4px solid #185FA5}
.card-inner.status-phone_screen{border-left:4px solid #854F0B}
.card-inner.status-interview{border-left:4px solid #0F6E56}
.card-inner.status-offer{border-left:4px solid #3B6D11}
.card-inner.status-rejected,.card-inner.status-not_interested{border-left:4px solid #ccc;opacity:.55}
.card-inner.rank-top{border-left:4px solid #0F6E56}
.card-inner.rank-top2{border-left:4px solid #185FA5}
.card-header{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.card-title-block{flex:1;min-width:0}
.job-title{font-size:.95rem;font-weight:500;line-height:1.3}
.job-company{font-size:.82rem;color:#666;margin-top:2px}
.location{color:#888}
.score-block{text-align:center;flex-shrink:0}
.score-circle{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.9rem;font-weight:500}
.score-label{font-size:.65rem;font-weight:500;margin-top:2px;text-transform:uppercase;letter-spacing:.04em}
.meta-row{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.source-tag{font-size:.7rem;background:#F1EFE8;color:#666;padding:2px 7px;border-radius:3px}
.rank-badge{font-size:.7rem;background:#E1F5EE;color:#0F6E56;padding:2px 7px;border-radius:3px;font-weight:500}
.salary-tag{font-size:.7rem;background:#EAF3DE;color:#3B6D11;padding:2px 7px;border-radius:3px;font-weight:500}
.date-tag{font-size:.7rem;color:#aaa;margin-left:auto}
.status-pill{font-size:.7rem;padding:2px 8px;border-radius:10px;font-weight:500}
.sp-new{background:#F1EFE8;color:#888}
.sp-applied{background:#E6F1FB;color:#185FA5}
.sp-phone_screen{background:#FAEEDA;color:#854F0B}
.sp-interview{background:#E1F5EE;color:#0F6E56}
.sp-offer{background:#EAF3DE;color:#3B6D11}
.sp-rejected,.sp-not_interested{background:#F1EFE8;color:#aaa}
.rationale{font-size:.84rem;line-height:1.6;color:#444;flex:1}
.tags-row{display:flex;flex-wrap:wrap;gap:4px}
.tag{font-size:.72rem;padding:2px 8px;border-radius:4px}
.tag.strength{background:#E6F1FB;color:#185FA5}
.tag.gap{background:#FAEEDA;color:#854F0B}
.card-footer{margin-top:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.apply-btn{display:inline-block;background:#1a1a18;color:#F7F6F2;text-decoration:none;font-size:.78rem;padding:5px 12px;border-radius:5px;transition:opacity .15s}
.apply-btn:hover{opacity:.8}
.status-select{font-size:.78rem;border:1px solid #ddd;border-radius:5px;padding:4px 8px;font-family:inherit;cursor:pointer;background:#fff;display:none}
body.owner-mode .status-select{display:block}
.report-section{margin-bottom:2rem}
.report-section h3{font-size:1rem;font-weight:500;margin-bottom:1rem}
.report-table{width:100%;border-collapse:collapse;font-size:.85rem}
.report-table th{text-align:left;padding:.5rem .75rem;background:#F7F6F2;border-bottom:1px solid #eee;font-weight:500;color:#888;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em}
.report-table td{padding:.6rem .75rem;border-bottom:1px solid #f0f0f0;vertical-align:top}
.report-table tr:hover td{background:#fafaf8}
.empty-state{padding:3rem;text-align:center;color:#aaa;font-size:.9rem}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center;z-index:100}
.modal-overlay.open{display:flex}
.modal{background:#fff;border-radius:12px;padding:2rem;width:320px;max-width:90vw}
.modal h3{font-size:1.1rem;font-weight:500;margin-bottom:1rem}
.modal input{width:100%;border:1px solid #ddd;border-radius:6px;padding:8px 12px;font-size:.9rem;font-family:inherit;margin-bottom:.75rem}
.modal-btns{display:flex;gap:.5rem;justify-content:flex-end}
.modal-btns button{border:1px solid #ddd;background:#fff;border-radius:6px;padding:6px 16px;font-size:.85rem;cursor:pointer;font-family:inherit}
.modal-btns .primary{background:#1a1a18;color:#fff;border-color:#1a1a18}
.modal-error{font-size:.8rem;color:#A32D2D;margin-bottom:.5rem;display:none}
.generated{text-align:center;padding:1.5rem;font-size:.75rem;color:#aaa}
</style>
</head>
<body>

<div class="modal-overlay" id="modalOverlay">
  <div class="modal">
    <h3>Owner login</h3>
    <div class="modal-error" id="modalError">Incorrect password</div>
    <input type="password" id="pwInput" placeholder="Password" onkeydown="if(event.key==='Enter')doLogin()">
    <div class="modal-btns">
      <button onclick="closeModal()">Cancel</button>
      <button class="primary" onclick="doLogin()">Unlock</button>
    </div>
  </div>
</div>

<div class="page-header">
  <div>
    <h1>Job Dashboard</h1>
    <div class="subtitle">Last scan: ${now} &nbsp;&middot;&nbsp; ${skippedEmails} email(s) skipped (already seen)</div>
  </div>
  <div class="login-area">
    <span id="ownerBadge">&#x1F513; Owner mode</span>
    <button id="loginBtn" onclick="openModal()">Owner login</button>
  </div>
</div>

<div class="stats-bar">
  <div class="stat"><div class="stat-val">${jobs.length}</div><div class="stat-lbl">Jobs ranked</div></div>
  <div class="stat"><div class="stat-val green">${strong}</div><div class="stat-lbl">Strong (70+)</div></div>
  <div class="stat"><div class="stat-val blue">${mid}</div><div class="stat-lbl">Good (50-69)</div></div>
  <div class="stat"><div class="stat-val amber" id="statApplied">0</div><div class="stat-lbl">Applied</div></div>
  <div class="stat"><div class="stat-val gray" id="statInterview">0</div><div class="stat-lbl">Interviewing</div></div>
</div>

<div class="tabs">
  <button class="tab-btn active" onclick="switchTab('all',this)">All Jobs</button>
  <button class="tab-btn" onclick="switchTab('pipeline',this)">My Pipeline</button>
  <button class="tab-btn" onclick="switchTab('report',this)">Weekly Report</button>
</div>

<div class="tab-pane active" id="tab-all">
  <div class="filters">
    <span class="filter-label">Filter:</span>
    <button class="filter-btn active" onclick="filterGrid('all',this,'jobGrid')">All</button>
    <button class="filter-btn" onclick="filterGrid('strong',this,'jobGrid')">Strong (70+)</button>
    <button class="filter-btn" onclick="filterGrid('good',this,'jobGrid')">Good (50-69)</button>
    <button class="filter-btn" onclick="filterGrid('LinkedIn',this,'jobGrid')">LinkedIn</button>
    <button class="filter-btn" onclick="filterGrid('Jobright',this,'jobGrid')">Jobright</button>
    <button class="filter-btn" onclick="filterGrid('Built In',this,'jobGrid')">Built In</button>
    <button class="filter-btn" onclick="filterGrid('Indeed',this,'jobGrid')">Indeed</button>
  </div>
  <div style="display:none;background:#fdd;padding:1rem;margin:1rem 2rem;border-radius:6px;font-family:monospace;white-space:pre-wrap;font-size:.8rem" id="jsError"></div>
<div class="grid" id="jobGrid"></div>
</div>

<div class="tab-pane" id="tab-pipeline">
  <div class="filters">
    <span class="filter-label">Status:</span>
    <button class="filter-btn active" onclick="filterPipeline('all',this)">All active</button>
    <button class="filter-btn" onclick="filterPipeline('applied',this)">Applied</button>
    <button class="filter-btn" onclick="filterPipeline('phone_screen',this)">Phone screen</button>
    <button class="filter-btn" onclick="filterPipeline('interview',this)">Interview</button>
    <button class="filter-btn" onclick="filterPipeline('offer',this)">Offer</button>
  </div>
  <div class="grid" id="pipelineGrid"></div>
</div>

<div class="tab-pane" id="tab-report">
  <div class="report-section">
    <h3>Applied this week</h3>
    <div id="weeklyContent"></div>
  </div>
  <div class="report-section">
    <h3>Full application history</h3>
    <div id="historyContent"></div>
  </div>
</div>

<div class="generated">Job Match Scanner v3.0 &nbsp;&middot;&nbsp; ${now}</div>

<script>
const ALL_JOBS = ${jobsJson};
const API_BASE = 'status_api.php';
const OWNER_PW = '${OWNER_PW.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}';
const STATUS_LABELS = {
  new:'New', applied:'Applied', phone_screen:'Phone screen',
  interview:'Interview', offer:'Offer', rejected:'Rejected', not_interested:'Not interested'
};
let statuses = {}, isOwner = false;

// ── Init ──
async function init() {
  // Global error catcher - shows errors on page instead of silently failing
  window.onerror = function(msg, src, line, col, err) {
    const d = document.getElementById('jsError');
    if (d) { d.style.display='block'; d.textContent = 'JS Error: ' + msg + ' (line ' + line + ')'; }
    return false;
  };
  // Load statuses from server if available; silently skip if running locally (file://)
  if (window.location.protocol !== 'file:') {
    try {
      const r = await fetch(API_BASE);
      if (r.ok) statuses = await r.json();
    } catch { statuses = {}; }
  }
  try {
    renderGrid('jobGrid', ALL_JOBS);
  } catch(e) {
    const d = document.getElementById('jsError');
    if (d) { d.style.display='block'; d.textContent = 'renderGrid error: ' + e.message; }
  }
  updateStats();
}

// ── Card builder ──
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function makeCard(job) {
  const st     = statuses[job.jobId] || {};
  const status = st.status || 'new';
  const sc     = job.score >= 70 ? '#0F6E56' : job.score >= 50 ? '#185FA5' : '#888780';
  const sb     = job.score >= 70 ? '#E1F5EE' : job.score >= 50 ? '#E6F1FB' : '#F1EFE8';
  const bc     = status !== 'new' ? 'status-' + status
               : job.rank === 1   ? 'rank-top'
               : job.rank <= 3    ? 'rank-top2' : '';
  const strs   = (job.strengths||[]).map(s=>'<span class="tag strength">'+s+'</span>').join('');
  const gaps   = (job.gaps||[]).map(g=>'<span class="tag gap">'+g+'</span>').join('');
  const urlBtn = job.url ? '<a href="'+job.url+'" target="_blank" class="apply-btn">View listing &rarr;</a>' : '';
  const rb     = job.rank <= 3 ? '<span class="rank-badge">#'+job.rank+' pick</span>' : '';
  const sal    = job.salary ? '<span class="salary-tag">'+job.salary+'</span>' : '';
  const dt     = job.emailDate ? new Date(job.emailDate).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '';
  const pill   = '<span class="status-pill sp-'+status+'">'+(STATUS_LABELS[status]||status)+'</span>';
  const opts   = Object.entries(STATUS_LABELS).map(([v,l])=>'<option value="'+v+'"'+(v===status?' selected':'')+'>'+l+'</option>').join('');
  return '<div class="card" data-score="'+job.score+'" data-source="'+(job.source||'')+'" data-status="'+status+'" data-jobid="'+(job.jobId||'')+'">'+
    '<div class="card-inner '+bc+'" id="ci_'+(job.jobId||'')+'">'+
    '<div class="card-header"><div class="card-title-block">'+
    '<div class="job-title">'+esc(job.title||'Unknown')+'</div>'+
    '<div class="job-company">'+(job.company||'')+(job.location?' &middot; <span class="location">'+job.location+'</span>':'')+'</div>'+
    '</div><div class="score-block">'+
    '<div class="score-circle" style="background:'+sb+';color:'+sc+'">'+job.score+'</div>'+
    '<div class="score-label" style="color:'+sc+'">'+(job.score>=70?'Strong':job.score>=50?'Good':'Weak')+'</div>'+
    '</div></div>'+
    '<div class="meta-row"><span class="source-tag">'+(job.source||'')+'</span>'+sal+rb+pill+'<span class="date-tag">'+dt+'</span></div>'+
    '<p class="rationale">'+esc(job.rationale||'')+'</p>'+
    '<div class="tags-row">'+strs+gaps+'</div>'+
    '<div class="card-footer">'+urlBtn+
    '<select class="status-select" data-jid="'+(job.jobId||'')+'" onchange="updateStatus(this.dataset.jid,this.value)">'+opts+'</select>'+
    '</div></div></div>';
}

function renderGrid(id, jobs) {
  if (!jobs.length) {
    document.getElementById(id).innerHTML = '<div class="empty-state">No jobs to show.</div>';
    return;
  }
  const html = jobs.map((job, i) => {
    try { return makeCard(job); }
    catch(e) {
      console.error('makeCard error on job ' + i + ' (' + (job.title||'?') + '):', e);
      return '<div class="card"><div class="card-inner" style="border-left:4px solid red;padding:1rem"><b>Card render error:</b> ' + String(e.message).replace(/</g,'&lt;') + '<br><small>' + String(job.title||'').replace(/</g,'&lt;') + '</small></div></div>';
    }
  }).join('');
  document.getElementById(id).innerHTML = html;
}

// ── Status update ──
async function updateStatus(jobId, newStatus) {
  if (!isOwner || !jobId) return;
  try {
    const res = await fetch(API_BASE, {
      method:'POST',
      headers:{'Content-Type':'application/json','X-Auth-Token':OWNER_PW},
      body:JSON.stringify({jobId, status:newStatus})
    });
    if (res.ok) {
      if (!statuses[jobId]) statuses[jobId] = {};
      statuses[jobId].status = newStatus;
      if (newStatus === 'applied' && !statuses[jobId].appliedAt)
        statuses[jobId].appliedAt = new Date().toISOString();
      // Re-render this card in all grids
      document.querySelectorAll('[data-jobid="'+jobId+'"]').forEach(card => {
        const job = ALL_JOBS.find(j => j.jobId === jobId);
        if (job) {
          const tmp = document.createElement('div');
          tmp.innerHTML = makeCard(job);
          const newCard = tmp.firstChild;
          card.replaceWith(newCard);
          if (isOwner) newCard.querySelector('.status-select').style.display = 'block';
        }
      });
      updateStats();
      if (document.getElementById('tab-report').classList.contains('active')) renderReport();
    }
  } catch(e) { console.error('Status update failed', e); }
}

// ── Stats ──
function updateStats() {
  const applied   = Object.values(statuses).filter(s=>['applied','phone_screen','interview','offer'].includes(s.status)).length;
  const interview = Object.values(statuses).filter(s=>['phone_screen','interview','offer'].includes(s.status)).length;
  document.getElementById('statApplied').textContent   = applied;
  document.getElementById('statInterview').textContent = interview;
}

// ── Filters ──
function filterGrid(type, btn, gridId) {
  btn.closest('.filters').querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('#'+gridId+' .card').forEach(card=>{
    const score=parseInt(card.dataset.score), source=card.dataset.source;
    let show=true;
    if(type==='strong') show=score>=70;
    else if(type==='good') show=score>=50&&score<70;
    else if(['LinkedIn','Jobright','Built In','Indeed'].includes(type)) show=source===type;
    card.setAttribute('data-hidden',show?'false':'true');
  });
}

function filterPipeline(type, btn) {
  btn.closest('.filters').querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('#pipelineGrid .card').forEach(card=>{
    const s=card.dataset.status;
    card.setAttribute('data-hidden',(type==='all'||s===type)?'false':'true');
  });
}

// ── Tabs ──
function switchTab(tab, btn) {
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p=>p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-'+tab).classList.add('active');
  if (tab==='pipeline') {
    const active=['applied','phone_screen','interview','offer'];
    renderGrid('pipelineGrid', ALL_JOBS.filter(j=>active.includes(statuses[j.jobId]?.status)));
    if (isOwner) document.querySelectorAll('#pipelineGrid .status-select').forEach(s=>s.style.display='block');
  }
  if (tab==='report') renderReport();
}

// ── Weekly report ──
function renderReport() {
  const weekAgo  = Date.now() - 7*24*60*60*1000;
  const active   = ['applied','phone_screen','interview','offer'];
  const allApplied = ALL_JOBS.filter(j=>active.includes(statuses[j.jobId]?.status));
  const thisWeek   = allApplied.filter(j=>new Date(statuses[j.jobId]?.appliedAt||0).getTime()>=weekAgo);

  const makeTable = (jobs, empty) => {
    if (!jobs.length) return '<div class="empty-state">'+empty+'</div>';
    return '<table class="report-table"><thead><tr><th>Role</th><th>Company</th><th>Score</th><th>Status</th><th>Applied</th></tr></thead><tbody>'+
      jobs.map(j=>{
        const st=statuses[j.jobId]||{};
        const d=st.appliedAt?new Date(st.appliedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'&mdash;';
        return '<tr><td>'+j.title+'</td><td>'+j.company+'</td>'+
          '<td><b style="color:'+(j.score>=70?'#0F6E56':'#185FA5')+'">'+j.score+'</b></td>'+
          '<td><span class="status-pill sp-'+(st.status||'new')+'">'+(STATUS_LABELS[st.status]||'New')+'</span></td>'+
          '<td style="color:#888;font-size:.82rem">'+d+'</td></tr>';
      }).join('')+'</tbody></table>';
  };
  document.getElementById('weeklyContent').innerHTML  = makeTable(thisWeek,  'No applications this week yet.');
  document.getElementById('historyContent').innerHTML = makeTable(allApplied, 'No applications tracked yet. Use owner mode to tag roles as Applied.');
}

// ── Owner login ──
function openModal()  { document.getElementById('modalOverlay').classList.add('open'); setTimeout(()=>document.getElementById('pwInput').focus(),50); }
function closeModal() { document.getElementById('modalOverlay').classList.remove('open'); document.getElementById('modalError').style.display='none'; document.getElementById('pwInput').value=''; }

function doLogin() {
  if (document.getElementById('pwInput').value === OWNER_PW) {
    isOwner = true;
    document.body.classList.add('owner-mode');
    document.getElementById('loginBtn').textContent='Logout';
    document.getElementById('loginBtn').classList.add('active');
    document.getElementById('loginBtn').onclick=doLogout;
    document.getElementById('ownerBadge').style.display='inline';
    closeModal();
  } else {
    document.getElementById('modalError').style.display='block';
  }
}

function doLogout() {
  isOwner = false;
  document.body.classList.remove('owner-mode');
  document.getElementById('loginBtn').textContent='Owner login';
  document.getElementById('loginBtn').classList.remove('active');
  document.getElementById('loginBtn').onclick=openModal;
  document.getElementById('ownerBadge').style.display='none';
}

init();
</script>
</body>
</html>`;
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║      Job Match Scanner  v3.0         ║");
  console.log(
    `║  Last ${String(DAYS_BACK).padEnd(2)} day(s)  ${RESCAN_ALL ? "RESCAN ALL mode   " : "dedup ON (new only) "}║`,
  );
  console.log("╚══════════════════════════════════════╝\n");

  if (RESCAN_ALL) log("⚠️ ", "--all flag: reprocessing all emails in window");

  // ── TEST MODE — no Gmail, no Claude API calls ──────────────
  if (TEST_MODE) {
    log("🧪", "TEST MODE — skipping Gmail and Claude, using sample data");
    const testJobs = [
      {
        rank: 1,
        score: 95,
        title: "Principal TPM Manager",
        company: "Microsoft",
        location: "Remote",
        salary: "$180k-$220k",
        source: "LinkedIn",
        url: "https://linkedin.com",
        snippet: "Lead AI platform programs.",
        rationale:
          "Perfect seniority and skills match. Remote role with strong salary.",
        jobId: "test_001",
        strengths: ["PMP certified", "AI platform experience", "Remote role"],
        gaps: [],
        emailDate: new Date().toISOString(),
      },
      {
        rank: 2,
        score: 88,
        title: "Sr. Staff TPM, GenAI",
        company: "Pinterest",
        location: "Remote",
        salary: "$160k-$195k",
        source: "Jobright",
        url: "",
        snippet: "Drive GenAI product delivery.",
        rationale:
          "Strong match on AI enablement and cross-functional leadership.",
        jobId: "test_002",
        strengths: ["GenAI focus", "Senior level", "Remote"],
        gaps: ["Pinterest-specific stack"],
        emailDate: new Date().toISOString(),
      },
      {
        rank: 3,
        score: 75,
        title: "Director of Technical Programs",
        company: "Acme Corp",
        location: "Charlotte, NC",
        salary: "$150k",
        source: "Indeed",
        url: "",
        snippet: "Lead enterprise transformation programs.",
        rationale:
          "Good title match. Hybrid NC location is acceptable per preferences.",
        jobId: "test_003",
        strengths: ["Director level", "NC location", "Enterprise focus"],
        gaps: ["Hybrid role"],
        emailDate: new Date().toISOString(),
      },
      {
        rank: 4,
        score: 62,
        title: "Technical Program Manager",
        company: "StartupXYZ",
        location: "Remote",
        salary: "",
        source: "Built In",
        url: "",
        snippet: "Manage product roadmap.",
        rationale:
          "Reasonable skills overlap but title is below preferred seniority level.",
        jobId: "test_004",
        strengths: ["Remote", "TPM role"],
        gaps: ["Below senior level", "No salary listed"],
        emailDate: new Date().toISOString(),
      },
      {
        rank: 5,
        score: 45,
        title: "Senior Project Manager",
        company: "Widget Co",
        location: "New York, NY",
        salary: "$120k",
        source: "LinkedIn",
        url: "",
        snippet: "Manage construction projects.",
        rationale:
          "On-site in NY and salary below $150k floor significantly reduces score.",
        jobId: "test_005",
        strengths: ["Senior title"],
        gaps: ["On-site NY", "Below salary floor", "Wrong industry"],
        emailDate: new Date().toISOString(),
      },
    ];
    const html = generateReport(testJobs, 0);
    fs.writeFileSync(OUTPUT_FILE, html);
    log("✅", "Test report generated: " + OUTPUT_FILE);
    if (fs.existsSync(FTP_CONFIG_FILE)) {
      log("📤", "Testing FTP upload...");
      const ok = await uploadToServer(OUTPUT_FILE, "job_matches.html");
      if (ok)
        log(
          "🌐",
          "FTP upload SUCCESS — live at: https://markjgrover.com/jobs/job_matches.html",
        );
      else log("❌", "FTP upload failed — check warnings above");
    }
    try {
      execSync(`start "" "${OUTPUT_FILE}"`);
    } catch {}
    return;
  }
  // ── END TEST MODE ──────────────────────────────────────────

  try {
    const accessToken = await getAccessToken();
    const { emails, newCount, skippedCount } =
      await fetchJobEmails(accessToken);

    if (emails.length === 0) {
      if (skippedCount > 0) {
        log(
          "✅",
          `All ${skippedCount} email(s) already scanned — nothing new!`,
        );
        log("💡", `To rescan: node scan.js ${DAYS_BACK} --all`);
      } else {
        log(
          "😐",
          `No emails found in "${LABEL_NAME}" for the last ${DAYS_BACK} day(s).`,
        );
        log("💡", `Try: node scan.js 14   or check your Gmail label name`);
      }
      return;
    }

    const jobs = await extractJobs(emails);

    // Mark emails as scanned regardless of extraction result
    const scannedIds = loadScannedIds();
    emails.forEach((e) => {
      scannedIds[e.id] = {
        scannedAt: new Date().toISOString(),
        subject: e.subject,
      };
    });
    saveScannedIds(scannedIds);
    log(
      "✅",
      `Marked ${emails.length} email(s) as scanned (${Object.keys(scannedIds).length} total)`,
    );

    if (jobs.length === 0) {
      log("😐", "New emails found but no job listings extracted.");
      return;
    }
    log("✅", `Extracted ${jobs.length} job(s)`);

    const ranked = await rankJobs(jobs);
    log("✅", `Ranked ${ranked.length} job(s)`);

    appendJobHistory(ranked, emails.length);

    const html = generateReport(ranked, skippedCount);
    fs.writeFileSync(OUTPUT_FILE, html);
    log("✅", `Report saved: ${OUTPUT_FILE}`);

    // SFTP upload
    if (fs.existsSync(FTP_CONFIG_FILE)) {
      log("📤", "Uploading to markjgrover.com/jobs/...");
      const ok = await uploadToServer(OUTPUT_FILE, "job_matches.html");
      if (ok)
        log("🌐", "Live at: https://markjgrover.com/jobs/job_matches.html");
    }

    // Auto-open locally
    try {
      execSync(`start "" "${OUTPUT_FILE}"`);
    } catch {}

    // Terminal summary
    const history = loadJobHistory();
    const total = history.reduce((n, r) => n + r.jobCount, 0);
    console.log("\n── Top 5 matches ────────────────────────");
    ranked
      .slice(0, 5)
      .forEach((j) =>
        console.log(`  ${j.rank}. [${j.score}/100] ${j.title} @ ${j.company}`),
      );
    console.log(
      `\n  Lifetime: ${history.length} scan(s), ${total} total jobs evaluated\n`,
    );
  } catch (err) {
    console.error("\n  Error:", err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
}

main();
