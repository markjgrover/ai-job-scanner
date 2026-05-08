#!/usr/bin/env node
// ============================================================
//  Gmail OAuth Setup — run this ONCE to authorize Gmail access
//  Creates gmail_token.json which scan.js uses automatically.
// ============================================================

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const TOKEN_FILE = path.join(__dirname, "gmail_token.json");
const CREDS_FILE = path.join(__dirname, "gmail_credentials.json");

// ── Check for credentials file ───────────────────────────────
if (!fs.existsSync(CREDS_FILE)) {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║              Gmail Setup — Step 1 of 2                      ║
╚══════════════════════════════════════════════════════════════╝

You need a Gmail OAuth credentials file. Here's how to get one:

1. Go to: https://console.cloud.google.com/
2. Create a new project (or select existing)
3. Go to "APIs & Services" → "Library"
4. Search for "Gmail API" and ENABLE it
5. Go to "APIs & Services" → "Credentials"
6. Click "+ CREATE CREDENTIALS" → "OAuth client ID"
7. Application type: Desktop app
8. Name it anything (e.g. "Job Scanner")
9. Click CREATE, then "DOWNLOAD JSON"
10. Rename the downloaded file to: gmail_credentials.json
11. Move it into this folder: ${__dirname}
12. Run this script again: node setup_gmail.js
`);
  process.exit(0);
}

function httpsRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function main() {
  const creds = JSON.parse(fs.readFileSync(CREDS_FILE));
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
  const REDIRECT_URI = "http://localhost:8080/callback";
  const SCOPES = "https://www.googleapis.com/auth/gmail.readonly";

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${encodeURIComponent(client_id)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&access_type=offline` +
    `&prompt=consent`;

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║              Gmail Setup — Authorizing Access               ║
╚══════════════════════════════════════════════════════════════╝

Opening your browser to authorize Gmail read access...
(The app only requests READ-ONLY access — it cannot send or delete emails)
`);

  // Open browser
  try {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    execSync(`${opener} "${authUrl}"`);
  } catch {
    console.log("Could not open browser automatically. Please open this URL manually:\n");
    console.log(authUrl);
  }

  // Start local server to catch the callback
  console.log("\nWaiting for authorization (listening on http://localhost:8080)...\n");

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith("/callback")) {
        const url = new URL(req.url, "http://localhost:8080");
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        res.writeHead(200, { "Content-Type": "text/html" });
        if (code) {
          res.end("<html><body style='font-family:sans-serif;padding:2rem'><h2>✅ Authorization successful!</h2><p>You can close this tab and return to the terminal.</p></body></html>");
          server.close();
          resolve(code);
        } else {
          res.end(`<html><body><h2>❌ Error: ${error}</h2></body></html>`);
          server.close();
          reject(new Error(error || "Authorization failed"));
        }
      }
    });
    server.listen(8080);
    server.on("error", reject);
    setTimeout(() => { server.close(); reject(new Error("Timed out waiting for authorization (2 min)")); }, 120000);
  });

  console.log("✅  Authorization code received — exchanging for tokens...\n");

  // Exchange code for tokens
  const params = new URLSearchParams({
    code,
    client_id,
    client_secret,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  }).toString();

  const res = await httpsRequest(
    { hostname: "oauth2.googleapis.com", path: "/token", method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": params.length } },
    params
  );

  if (!res.body.access_token) {
    throw new Error("Token exchange failed: " + JSON.stringify(res.body));
  }

  const token = {
    access_token: res.body.access_token,
    refresh_token: res.body.refresh_token,
    expiry_date: Date.now() + res.body.expires_in * 1000,
    client_id,
    client_secret,
  };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2));

  console.log(`✅  Token saved to gmail_token.json`);
  console.log(`\n🎉  Setup complete! You can now run the scanner:\n`);
  console.log(`    node scan.js          # scan last 3 days (default)`);
  console.log(`    node scan.js 7        # scan last 7 days`);
  console.log(`    node scan.js 14       # scan last 14 days\n`);
}

main().catch(err => {
  console.error("\n❌  Setup error:", err.message);
  process.exit(1);
});
