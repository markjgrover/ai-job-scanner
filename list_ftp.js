#!/usr/bin/env node
// FTP Diagnostic — lists folders at FTP root to find correct upload path
// Run: node list_ftp.js

const net  = require("net");
const fs   = require("fs");
const path = require("path");

const FTP_CONFIG_FILE = path.join(__dirname, "ftp_config.json");
if (!fs.existsSync(FTP_CONFIG_FILE)) { console.error("ftp_config.json not found"); process.exit(1); }

const cfg = JSON.parse(fs.readFileSync(FTP_CONFIG_FILE));
console.log(`\nConnecting to ${cfg.host} as ${cfg.user}...\n`);

const cmd = net.createConnection(21, cfg.host);
let buf = "", state = "GREETING", listing = "";

function send(line) { console.log("  >>", line); cmd.write(line + "\r\n"); }

cmd.on("data", (chunk) => {
  buf += chunk.toString();
  const lines = buf.split("\r\n");
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    console.log("  <<", line);
    const code = parseInt(line.slice(0, 3));
    if      (code === 220 && state === "GREETING")    { state = "USER";      send("USER " + cfg.user); }
    else if (code === 331 && state === "USER")         { state = "PASS";      send("PASS " + cfg.password); }
    else if (code === 230 && state === "PASS")         { state = "PWD";       send("PWD"); }
    else if (code === 257 && state === "PWD") {
      const m = line.match(/"([^"]+)"/);
      console.log("\n  FTP root:", m ? m[1] : "unknown", "\n");
      state = "PASV"; send("PASV");
    }
    else if (code === 227 && state === "PASV") {
      const m = line.match(/(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/);
      if (!m) { send("QUIT"); return; }
      const ph = m[1]+"."+m[2]+"."+m[3]+"."+m[4];
      const pp = parseInt(m[5])*256+parseInt(m[6]);
      listing = "";
      const dc = net.createConnection(pp, ph);
      dc.on("data", d => { listing += d.toString(); });
      dc.on("close", () => {
        console.log("  Folder listing:");
        listing.trim().split("\n").forEach(l => console.log("   ", l.trim()));
        console.log("\n  Use the correct folder name in ftp_config.json remoteDir");
      });
      state = "LIST"; send("LIST");
    }
    else if (code === 226 && state === "LIST") { state = "QUIT"; send("QUIT"); }
    else if (code === 221) { cmd.destroy(); }
    else if (code >= 400)  { console.log("  ERR:", line); send("QUIT"); }
  }
});
cmd.on("error", e => console.error("Error:", e.message));
cmd.on("close", () => console.log("\nDone.\n"));
