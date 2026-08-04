# 2hlen-data

Public data pipeline for the **2hlen** mobile app (whose source lives in a
private repository — GitHub Pages cannot serve from it, hence this repo).

**No secrets live here.** The extractor only reads the public website
[2hlen.com](https://2hlen.com) and republishes its catalog as JSON.

## What it does

Every hour (and on manual dispatch), the [`sync` workflow](.github/workflows/sync.yml):

1. runs `scripts/extract-catalog.ts` — a deterministic, rate-limited
   crawler of the site's catalog pages (copied unchanged from the app
   project, extractor v1.4);
2. passes the result through a **safety gate**
   (`scripts/verify-catalog.mjs`): fewer than 100 records, unparseable
   JSON, or any WhatsApp hostname (`wa.me`, `wa.link`, `whatsapp.link`,
   `*.whatsapp.com`) fails the run — a broken scrape never overwrites a
   good catalog;
3. publishes to `docs/` **only when the catalog actually changed**, as a
   commit named `Catalog update: N records`, together with
   `docs/version.json` (`generatedAt`, `recordCount`, `sha256`).

## Published URLs (GitHub Pages)

Enable Pages once: **Settings → Pages → Deploy from a branch →
`main` / `/docs`**. The files are then served at:

- **https://mamounebs.github.io/2hlen-data/listings.json** — the catalog
  (151 listings: hotels, apartments, cars, transport, restaurants)
- **https://mamounebs.github.io/2hlen-data/version.json** — freshness
  metadata for cheap change detection

## Running locally

```sh
npm install
npm run extract   # writes src/data/listings.json (uses .cache/ if present)
npm run verify    # the same safety gate CI runs
```
