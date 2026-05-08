# Contributing

AI Job Scanner is an open source personal tool and contributions are welcome. Here's how to get involved.

---

## Ways to contribute

### Add support for a new job source

The most impactful contribution. To add a new job alert source (Dice, Glassdoor, ZipRecruiter, Wellfound, etc.):

1. Share a sample email from that source in a GitHub Issue so we can see the format
2. Add the sender address to the Gmail filter instructions in `INSTALLATION.md`
3. Add a format description to the extraction prompt in `extractJobs()` in `scan.js`
4. Add a filter button to the dashboard in `generateReport()` in `scan.js`
5. Test with `node scan.js --test` and a real email
6. Open a PR with a description of the format

### Improve extraction reliability

If you find that certain emails from a supported source aren't being extracted correctly, open an Issue with:
- The source (LinkedIn / Jobright / Built In / Indeed)
- Whether it's a new email format or regression
- A sanitized sample of the email text (remove personal info)

### Mac/Linux compatibility

The scanner works on Mac and Linux with minor changes. A PR that makes the auto-open and scheduling work cross-platform natively would be valuable.

### Documentation improvements

Spotted something unclear in the installation guide? Typos, missing steps, or outdated screenshots? PRs welcome.

---

## Development setup

```bash
git clone https://github.com/yourusername/ai-job-scanner.git
cd ai-job-scanner
cp config.json.template config.json
# Fill in config.json with your details
```

No build step, no package install. Just Node.js.

**Running tests:**
```bash
node scan.js --test   # Full pipeline test with sample data, zero API calls
node --check scan.js  # Syntax check
```

---

## Code style

- No npm dependencies — use Node.js built-ins only
- Functions should be clearly named and do one thing
- Log messages use emoji prefixes for scannability in the terminal
- Keep the HTML dashboard as a single self-contained file

---

## What's not in scope

- A GUI config editor (deliberate choice — see [ARCHITECTURE.md](ARCHITECTURE.md))
- Cloud deployment / serverless version (this is designed for personal hardware)
- Database backend (flat JSON files are intentional)
- Email sending / notifications (out of scope for v1)

---

## Opening issues

Before opening an issue, check if it already exists. When opening a bug report, include:
- Your OS and Node.js version (`node --version`)
- The command you ran
- The full terminal output
- Any debug files created (`debug_email_*.txt`, `rank_debug.txt`)

---

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
