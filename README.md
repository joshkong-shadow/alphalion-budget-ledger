# Alpha Lion Budget Ledger

Daily / weekly / monthly Meta **spend vs budget** by B2O, SHT, DEL and Total, with budget utilization % and the
budgets-by-NVP drop-down. Moved here from a claude.ai artifact on 2026-11-11 so the daily refresh needs no approval clicks.

- **Live page:** https://joshkong-shadow.github.io/alphalion-budget-ledger/ (password; the browser remembers it per device)
- **How it refreshes:** the GitHub Action `refresh-ledger` runs on GitHub's servers every morning. No laptop, no Claude session.

## How it works

```
GitHub Action (early morning Pacific)
  vault.mjs unpack     decrypt stored history (enc/state) into data/
  fetch_moby.mjs       pull today + 2 days back from Moby: spend, budgets, on/off, visitors, NC revenue
  build_ledger.mjs     record how yesterday ended (snapshot), rebuild every ledger document
  vault.mjs pack       re-encrypt changed history files + bundle the page's documents into enc/docs.bin
  commit enc/          GitHub Pages serves the new file; the page decrypts it with the password
```

- Nothing readable is ever committed: `data/` is gitignored; `enc/` holds AES-256-GCM ciphertext. The password IS the key
  (PBKDF2-SHA256, 300k rounds). Wrong password = decryption fails.
- Secrets live in the repo's Actions secrets: `MOBY_MCP_KEY`, `LEDGER_PASSPHRASE`. Josh's local copies:
  `~/.config/moby/key`, `~/.config/moby/budget-ledger-passphrase`.
- **Timing:** GitHub's scheduler often fires hours late, so the workflow tries every 30 min from 10:17 to 14:47 UTC
  (2–7am Pacific in winter) plus afternoon catch-ups; the first attempt of the Pacific day does the work, the rest stop
  (`enc/last_run.json`). A pull before 7am Pacific records exactly how yesterday ended; a later one leaves that day "rebuilt".
- `index.html` is the artifact page unchanged except a password screen and a small loader that serves the same
  `db.doc / db.collection` calls from `enc/docs.bin`.
- Ledger logic, counting rule and known limits: see the `budget-bucket-ledger` skill
  (`~/.claude/skills/budget-bucket-ledger/`). `scripts/fetch_moby.mjs` and `scripts/build_ledger.mjs` are copies of the
  skill's scripts — if the skill changes, copy them here again.

## Manual run
GitHub → Actions → refresh-ledger → Run workflow (always runs, even if today's refresh already happened).

## Budget-history backfill (rare)
Past-day budgets before 2026-10-05 come from Meta's activity log (`data/budgetlog/`). To add more: unpack locally
(`node scripts/vault.mjs unpack`), pull the log as described in the skill, run build, `node scripts/vault.mjs pack`, commit `enc/`.
