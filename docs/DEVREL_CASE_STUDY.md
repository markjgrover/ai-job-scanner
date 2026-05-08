# Developer Relations Case Study: AI Job Scanner

## How I used AI tooling to solve a real operational problem — and what it taught me about developer experience

---

### The problem statement

I was spending 1–2 hours per day on a manual, inconsistent process:

1. Open job alert emails from LinkedIn, Jobright, Built In, and Indeed
2. Read each listing individually
3. Decide subjectively whether it matched my skills
4. Copy interesting ones into Claude for evaluation
5. Try to remember which ones I'd already reviewed yesterday
6. Track applications in a notes file that had no structure

As someone who has spent a decade helping organizations eliminate exactly this kind of operational friction, the irony was not lost on me.

---

### Why this is a DevRel story

Developer Relations is fundamentally about **empathy with technical practitioners** — understanding what they're actually trying to accomplish, meeting them where they are, and removing the friction between intent and outcome.

Building this tool required me to practice exactly those skills on myself:

**I had to understand the real problem.** The surface problem was "too many job emails." The actual problem was a broken evaluation loop — no consistent scoring methodology, no deduplication, no pipeline visibility. Solving the surface problem (unsubscribing from alerts) would have made things worse.

**I had to design for my own developer experience.** Every architectural choice — zero npm dependencies, a single config file, a test mode that costs nothing to run — was made with the question: "What would frustrate me if I came back to this in three months?" That's the same question good DevRel asks about every SDK, every sample app, every getting-started guide.

**I had to iterate in public.** This project went through multiple failed FTP implementations, a JavaScript syntax error that took eight debugging sessions to isolate, and several prompt engineering iterations before the extraction was reliable. Documenting that process honestly is more valuable than presenting a polished artifact.

---

### Technical architecture decisions through a DevRel lens

Every architecture decision in this project maps to a principle I'd apply when building developer tooling for others.

**Zero npm dependencies**

The instinct is to reach for libraries. The better instinct is to ask: "What does this dependency actually cost the developer who installs my tool three months from now?" Supply chain risk, version conflicts, security advisories, breaking changes — these are real costs that rarely show up in the initial implementation but compound over time.

For a tool that handles OAuth tokens and runs on a personal machine, the right call was to write the FTP client, the HTTPS wrapper, and the base64 decoder by hand. It's more code. It's also more trustworthy.

*DevRel principle: Dependencies are a tax on your users. Charge it deliberately.*

**Config file over code editing**

Early versions required editing `scan.js` directly to change the resume, password, or salary floor. This is fine when you're the only user. It's a barrier the moment you ask someone else to use your tool.

Moving everything to `config.json` was a one-day refactor that transformed the tool from "something I built for myself" to "something anyone can use." The README now reads differently. The installation guide is cleaner. The contribution bar is lower.

*DevRel principle: The distance between "clone" and "working" determines adoption. Minimize it.*

**Test mode that costs nothing**

`node scan.js --test` runs the entire pipeline — HTML generation, dashboard rendering, FTP upload — with five hardcoded sample jobs and zero API calls. It costs nothing and takes five seconds.

This was built out of necessity (I was burning API credits debugging UI issues) but it's good developer experience by any measure. A sample mode that lets developers explore your tool without credentials, without spending money, and without waiting for external services is one of the highest-ROI investments in developer tooling.

*DevRel principle: Remove every barrier between curiosity and a working demo.*

**Honest documentation**

The installation guide acknowledges that Google will show a "this app isn't verified" warning and explains why it's expected. The troubleshooting section lists the actual errors users will encounter. The architecture doc explains the tradeoffs of FTP over SFTP, flat JSON over a database, and per-email extraction over batching.

Good documentation doesn't pretend the happy path is the only path. It treats the developer as an intelligent adult who deserves to understand the system they're running.

*DevRel principle: Trust is built by explaining the why, not just the how.*

---

### What I'd do differently at scale

This tool is built for one user on one machine. If I were building it for a team or a community:

**Configuration would live in the cloud, not a local file.** A team using this would need shared job tracking, shared scoring criteria, and the ability to update the resume without deploying a new file. That points toward a lightweight backend — probably a serverless function reading from a managed config store.

**The scoring prompt would be version-controlled and testable.** Right now the ranking prompt lives inside `scan.js`. For a team, you'd want to be able to A/B test prompt variants, track which version produced which scores, and roll back changes that degraded quality. Prompt engineering at scale is an engineering discipline, not a configuration task.

**Observability would be first-class.** The current tool logs to the terminal and saves debug files. At scale, you'd want structured logging, run metrics (jobs processed / API latency / FTP upload time), and alerting when extraction quality drops.

**The onboarding flow would be a CLI wizard, not a README.** The Gmail OAuth setup is the most friction-heavy part of the installation. A well-designed CLI that walks through each step, validates credentials as they're entered, and gives immediate feedback would cut setup time in half.

---

### Results

- Daily job search time: **~90 minutes → under 5 minutes**
- Jobs evaluated across first week: **94**
- #1 ranked match on first run: **applied within 24 hours, currently in process**
- Cost per daily run: **~$0.05–0.15 in API credits**
- Time to first working version: **one afternoon**

---

### The broader pattern

The same architecture — ingest unstructured data, extract structure with an LLM, score against a configurable rubric, present ranked output, track actions — appears constantly in enterprise contexts:

- Matching candidates to open roles based on skills scoring
- Routing support tickets to the right team based on content classification
- Scoring RFP responses against weighted evaluation criteria
- Surfacing personalized learning recommendations from skills gap data

Building this for a personal use case produced a reusable template. That's usually how the best developer tools start.

---

*This project is open source at [github.com/yourusername/ai-job-scanner](https://github.com/yourusername/ai-job-scanner). Contributions welcome.*
