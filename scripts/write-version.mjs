// Writes docs/version.json for the published catalog:
// { generatedAt, recordCount, sha256 } of the listings file.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [src, out] = process.argv.slice(2);
const raw = readFileSync(src);
const data = JSON.parse(raw.toString('utf8'));

writeFileSync(
  out,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      recordCount: data.length,
      sha256: createHash('sha256').update(raw).digest('hex'),
    },
    null,
    2,
  ) + '\n',
);
console.log(`wrote ${out}: ${data.length} records`);
