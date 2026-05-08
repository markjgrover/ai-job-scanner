#!/usr/bin/env node
// ============================================================
//  FTP Setup — run once to save Spaceship FTP credentials
//  Creates ftp_config.json used by scan.js for auto-upload
//
//  Find your credentials in Spaceship:
//  Hosting Manager → Manage → FTP Accounts
// ============================================================

const readline = require("readline");
const fs       = require("fs");
const path     = require("path");

const CONFIG_FILE = path.join(__dirname, "ftp_config.json");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(resolve => rl.question(q, resolve));

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║         FTP Setup — markjgrover.com                         ║
╚══════════════════════════════════════════════════════════════╝

Find your credentials in Spaceship:
  Hosting Manager -> Manage -> FTP Accounts

`);
  const host      = await ask("FTP hostname (e.g. ftp.markjgrover.com): ");
  const user      = await ask("FTP username: ");
  const password  = await ask("FTP password: ");
  const remoteDir = await ask("Remote jobs folder path (e.g. /public_html/jobs): ");

  const config = {
    host:      host.trim(),
    user:      user.trim(),
    password:  password.trim(),
    remoteDir: remoteDir.trim(),
  };

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log(`
Done! Saved to ftp_config.json

    Host:       ${config.host}
    User:       ${config.user}
    Remote dir: ${config.remoteDir}

Keep ftp_config.json private - it contains your password.
It is listed in .gitignore and should never be shared.

Next steps:
  1. Upload server/status_api.php to your /jobs/ folder on Spaceship
  2. Run: node scan.js 7   to test the full pipeline with upload
`);
  rl.close();
}

main().catch(err => { console.error("Error:", err.message); rl.close(); process.exit(1); });
