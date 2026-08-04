// SAFETY GATE — a broken scrape must never overwrite a good catalog.
// Fails (exit 1) when the file is unreadable, not valid JSON, has fewer
// than 100 records, or contains any WhatsApp hostname.
import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? 'src/data/listings.json';

let raw;
try {
  raw = readFileSync(path, 'utf8');
} catch (e) {
  console.error(`GATE FAIL: cannot read ${path}: ${e.message}`);
  process.exit(1);
}

let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  console.error(`GATE FAIL: not valid JSON: ${e.message}`);
  process.exit(1);
}

if (!Array.isArray(data) || data.length < 100) {
  console.error(
    `GATE FAIL: ${Array.isArray(data) ? data.length : 'non-array'} records (minimum 100)`,
  );
  process.exit(1);
}

const banned = [
  /wa\.me/i,
  /wa\.link/i,
  /whatsapp\.link/i,
  /api\.whatsapp\.com/i,
  /web\.whatsapp\.com/i,
  /chat\.whatsapp\.com/i,
  /whatsapp:\/\//i,
];
for (const re of banned) {
  if (re.test(raw)) {
    console.error(`GATE FAIL: banned pattern ${re} found in output`);
    process.exit(1);
  }
}

console.log(`GATE OK: ${data.length} records, valid JSON, no banned hostnames.`);
