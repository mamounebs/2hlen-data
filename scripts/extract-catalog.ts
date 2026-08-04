/**
 * One-time catalog extractor for 2hlen.com
 *
 * Run: npx --yes tsx scripts/extract-catalog.ts
 *
 * Reads the WordPress catalog pages (REST) + every detail page (raw HTML),
 * caches every HTTP response under .cache/extractor/, and writes a single
 * deterministic dataset to src/data/listings.json.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

const BASE = 'https://2hlen.com';
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '.cache', 'extractor');
const OUT_DIR = path.join(ROOT, 'src', 'data');
const OUT_FILE = path.join(OUT_DIR, 'listings.json');
const INVALID_FILE = path.join(OUT_DIR, 'listings.invalid.json');
const EXTRACTOR_VERSION = '1.4';

type ListingType =
  | 'hotel'
  | 'apartment'
  | 'car'
  | 'transport'
  | 'transport_region'
  | 'restaurant';

interface CatalogPage {
  id: number;
  type: ListingType;
}

const CATALOG_PAGES: CatalogPage[] = [
  { id: 144, type: 'hotel' },
  { id: 146, type: 'apartment' },
  { id: 432, type: 'car' },
  { id: 505, type: 'transport' },
  { id: 520, type: 'restaurant' },
];

/** v1.4 — one gallery album: heading exactly as written, optional price. */
interface Album {
  title: string;
  price: number | null;
  priceUnit: string | null;
  images: string[];
}

interface Listing {
  id: string;
  type: ListingType;
  isRegion: boolean;
  parentId: string | null;
  category: string | null;
  title: { ar: string; en: string; fr: string };
  city: string | null;
  district: string | null; // v1.3 — homepage `area` value, stored as-is (Arabic)
  rawLocation: string | null;
  description: { original: string | null; language: 'ar' | 'fr' | 'mixed' | null };
  images: string[];
  albums: Album[]; // v1.4 — hotels/apartments; [] elsewhere
  thumbnail: string | null;
  phones: string[]; // v1.2 — restaurant contact numbers; [] for every other type
  location: { lat: null; lng: null };
  price: number | null; // v1.3 — MRU from the homepage arrays; 0 there means unpublished → null
  sourceUrl: string;
  searchText: string;
  metadata: { sourcePageId: number; extractorVersion: string };
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

const stats = {
  cacheHits: 0,
  cacheMisses: 0,
  failedRequests: [] as string[],
  skippedPages: [] as string[],
  missingTranslationKeys: new Set<string>(),
  duplicatesRemoved: 0,
  blockedContactUrls: 0,
  offsiteImagesDropped: 0,
  albumIssues: [] as string[], // v1.4 — parse failures / ambiguities
};

// ---------------------------------------------------------------------------
// HTTP + cache
// ---------------------------------------------------------------------------

const MIN_REQUEST_INTERVAL_MS = 1100; // spec cap is 2 req/sec; server 429s bursts, so pace slower
let lastRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

async function rateLimit(): Promise<void> {
  const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

/** Fetch a URL with caching under .cache/extractor/<sha1(url)>.<ext>. */
async function fetchCached(url: string, ext: 'json' | 'html'): Promise<string | null> {
  const file = path.join(CACHE_DIR, `${sha1(url)}.${ext}`);
  try {
    const cached = await fs.readFile(file, 'utf8');
    stats.cacheHits++;
    return cached;
  } catch {
    // not cached
  }
  stats.cacheMisses++;
  for (let attempt = 0; attempt < 3; attempt++) {
    let backoff = 1000 * 2 ** attempt; // 1s, 2s exponential backoff
    try {
      await rateLimit();
      const res = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; 2hlen-extractor/1.0)' },
      });
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after'));
        backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 20000 * 2 ** attempt; // 20s, 40s for rate limiting
        throw new Error('HTTP 429');
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      await fs.writeFile(file, body, 'utf8');
      return body;
    } catch (err) {
      if (attempt === 2) {
        stats.failedRequests.push(url);
        console.warn(`[skip] failed after 3 attempts: ${url} (${String(err)})`);
        return null;
      }
      await sleep(backoff);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTML utilities (no external dependencies)
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
  ocirc: 'ô',
  icirc: 'î',
  ucirc: 'û',
  euml: 'ë',
  iuml: 'ï',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? m);
}

/** Get an attribute value from a raw opening-tag string. */
function getAttr(tag: string, name: string): string | null {
  const m =
    tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`)) ||
    tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`));
  return m ? m[1] : null;
}

interface ElementBlock {
  start: number;
  openTag: string;
  inner: string;
}

/**
 * Find all elements of `tag` whose class attribute contains `className` as a
 * whole word, returning their inner HTML (nesting-aware for same-tag nesting).
 */
function findElementBlocks(html: string, tag: string, className: string): ElementBlock[] {
  const blocks: ElementBlock[] = [];
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  const classRe = new RegExp(`(^|\\s)${className}(\\s|$)`);
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html)) !== null) {
    const cls = getAttr(m[0], 'class');
    if (!cls || !classRe.test(cls)) continue;
    const innerStart = m.index + m[0].length;
    // walk forward to the matching close tag
    const tokRe = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, 'gi');
    tokRe.lastIndex = innerStart;
    let depth = 1;
    let innerEnd = html.length;
    let t: RegExpExecArray | null;
    while ((t = tokRe.exec(html)) !== null) {
      depth += t[0][1] === '/' ? -1 : 1;
      if (depth === 0) {
        innerEnd = t.index;
        break;
      }
    }
    blocks.push({ start: m.index, openTag: m[0], inner: html.slice(innerStart, innerEnd) });
  }
  return blocks;
}

function stripScriptsAndStyles(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

/** Inline text: strip tags, decode entities, collapse all whitespace. */
function inlineText(html: string): string {
  const text = decodeEntities(stripScriptsAndStyles(html).replace(/<[^>]+>/g, ' '));
  return text.replace(/\s+/g, ' ').trim();
}

/** Block text: paragraphs preserved as \n\n, intra-paragraph whitespace collapsed. */
function blockText(html: string): string {
  let s = stripScriptsAndStyles(html);
  s = s.replace(/<(?:br|hr)\s*\/?>/gi, '\n');
  s = s.replace(/<\/(?:p|div|h[1-6]|li|ul|ol|blockquote|section|article)\s*>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  const paragraphs = s
    .split(/\n{1,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);
  return paragraphs.join('\n\n').trim();
}

// ---------------------------------------------------------------------------
// String / URL cleaning
// ---------------------------------------------------------------------------

const TRACKING_PARAM_RE = /^(utm_|fbclid$|gclid$)/i;

/** WhatsApp CONTACT endpoints — blocked by hostname, never by filename.
    v1.4 adds the short-link domains used by album booking buttons. */
const BLOCKED_HOSTNAMES = new Set([
  'wa.me',
  'www.wa.me',
  'api.whatsapp.com',
  'web.whatsapp.com',
  'chat.whatsapp.com',
  'wa.link',
  'www.wa.link',
  'whatsapp.link',
  'www.whatsapp.link',
]);

/** Images must live on the site itself. */
const IMAGE_HOSTS = new Set(['2hlen.com', 'www.2hlen.com']);

/** 2hlen's own site-wide numbers (every page footer) — never restaurant numbers. */
const SITE_WIDE_PHONES = new Set([
  '+222 27 73 33 27',
  '+222 37 73 33 27',
  '+222 47 73 33 27',
]);

/** Normalize a tel: number to "+222 XX XX XX XX"; null if not a Mauritanian 8-digit number. */
function normalizePhone(raw: string): string | null {
  const digits = decodeEntities(raw).replace(/\D+/g, '');
  let local: string | null = null;
  if (digits.length === 8) local = digits;
  else if (digits.length === 11 && digits.startsWith('222')) local = digits.slice(3);
  else if (digits.length === 13 && digits.startsWith('00222')) local = digits.slice(5);
  if (local === null) return null;
  return `+222 ${local.slice(0, 2)} ${local.slice(2, 4)} ${local.slice(4, 6)} ${local.slice(6, 8)}`;
}

/** Resolve to an absolute http(s) URL and strip tracking params. Null if not possible. */
function cleanUrl(raw: string | null | undefined, baseUrl: string): string | null {
  if (!raw) return null;
  const src = decodeEntities(raw.trim());
  if (!src || src.startsWith('data:')) return null;
  if (/^(javascript|tel|mailto|whatsapp):/i.test(src)) {
    stats.blockedContactUrls++;
    return null;
  }
  let u: URL;
  try {
    u = new URL(src, baseUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (BLOCKED_HOSTNAMES.has(u.hostname)) {
    // contact links are banned; filenames merely containing "whatsapp" are fine
    stats.blockedContactUrls++;
    return null;
  }
  const toDelete: string[] = [];
  u.searchParams.forEach((_v, k) => {
    if (TRACKING_PARAM_RE.test(k)) toDelete.push(k);
  });
  for (const k of toDelete) u.searchParams.delete(k);
  let href = u.href;
  if (href.endsWith('?')) href = href.slice(0, -1);
  return href;
}

/** Clean an image URL and require it to be hosted on 2hlen.com. */
function cleanImageUrl(raw: string | null | undefined, baseUrl: string): string | null {
  const url = cleanUrl(raw, baseUrl);
  if (!url) return null;
  if (!IMAGE_HOSTS.has(new URL(url).hostname)) {
    stats.offsiteImagesDropped++;
    console.warn(`[img] offsite image dropped: ${url}`);
    return null;
  }
  return url;
}

/** Logos / icons / placeholders / avatars / SVG icons are not gallery content. */
function isJunkImage(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return true;
  }
  if (pathname.endsWith('.svg')) return true;
  return /(logo|icon|favicon|placeholder|avatar|sprite|spinner|loader|blank|pixel|tracking)/.test(
    pathname,
  );
}

/**
 * Remove contact/tracking artifacts from free text so no stored string ever
 * contains wa.me / whatsapp / tel: / mailto: / javascript:.
 * (tel: is matched as a scheme so "Hotel:" is not mangled.)
 */
function sanitizeText(s: string | null): string | null {
  if (s === null) return null;
  const stripForbidden = (t: string): string =>
    t
      .replace(/\S*wa\.me\/\S*/gi, ' ')
      .replace(/\S*wa\.link\/\S*/gi, ' ')
      .replace(/\S*whatsapp\.link\/\S*/gi, ' ')
      .replace(/\S*(?:api|web|chat)\.whatsapp\.com\S*/gi, ' ')
      .replace(/whatsapp:\/\/\S*/gi, ' ')
      .replace(/(^|[^\p{L}])tel:\S*/giu, '$1 ')
      .replace(/mailto:\S*/gi, ' ')
      .replace(/javascript:\S*/gi, ' ');
  const paragraphs: string[] = [];
  for (const p of s.split(/\n{2,}/)) {
    const cleaned = stripForbidden(p).replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    // a paragraph that was mostly a contact link leaves a dangling stub
    // ("book via ...") once the forbidden part is removed — drop it entirely
    if (cleaned !== p.replace(/\s+/g, ' ').trim() && cleaned.length < 30) continue;
    paragraphs.push(cleaned);
  }
  const out = paragraphs.join('\n\n').trim();
  return out.length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// Translations (`const translations = {...}` embedded in each page)
// ---------------------------------------------------------------------------

type Translations = Record<'ar' | 'en' | 'fr', Record<string, string>>;

/** Scan a balanced {...} starting at openIdx, ignoring braces in strings/comments. */
function scanBalancedObject(src: string, openIdx: number): string | null {
  let depth = 0;
  let i = openIdx;
  let state: 'code' | 'sq' | 'dq' | 'tpl' | 'line' | 'block' = 'code';
  for (; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (state === 'code') {
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return src.slice(openIdx, i + 1);
      } else if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'tpl';
      else if (c === '/' && next === '/') state = 'line';
      else if (c === '/' && next === '*') state = 'block';
    } else if (state === 'sq') {
      if (c === '\\') i++;
      else if (c === "'") state = 'code';
    } else if (state === 'dq') {
      if (c === '\\') i++;
      else if (c === '"') state = 'code';
    } else if (state === 'tpl') {
      if (c === '\\') i++;
      else if (c === '`') state = 'code';
    } else if (state === 'line') {
      if (c === '\n') state = 'code';
    } else if (state === 'block') {
      if (c === '*' && next === '/') {
        state = 'code';
        i++;
      }
    }
  }
  return null;
}

function unescapeJsString(s: string): string {
  return s.replace(/\\(.)/g, (_, c) => {
    if (c === 'n') return '\n';
    if (c === 't') return '\t';
    return c;
  });
}

function parseTranslations(html: string): Translations {
  const empty: Translations = { ar: {}, en: {}, fr: {} };
  const declIdx = html.indexOf('const translations');
  if (declIdx === -1) return empty;
  const braceIdx = html.indexOf('{', declIdx);
  if (braceIdx === -1) return empty;
  const objSrc = scanBalancedObject(html, braceIdx);
  if (!objSrc) return empty;
  const result: Translations = { ar: {}, en: {}, fr: {} };
  for (const lang of ['ar', 'en', 'fr'] as const) {
    const langRe = new RegExp(`(?:^|[,{\\s])${lang}\\s*:\\s*\\{`);
    const lm = langRe.exec(objSrc);
    if (!lm) continue;
    const langBrace = objSrc.indexOf('{', lm.index + lm[0].length - 1);
    const sub = scanBalancedObject(objSrc, langBrace);
    if (!sub) continue;
    const pairRe = /([A-Za-z0-9_$]+)\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
    let pm: RegExpExecArray | null;
    while ((pm = pairRe.exec(sub)) !== null) {
      result[lang][pm[1]] = decodeEntities(unescapeJsString(pm[2] ?? pm[3] ?? ''));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// City normalization
// ---------------------------------------------------------------------------

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip Latin accents
    .replace(/[\u064b-\u065f\u0670]/g, '') // strip Arabic diacritics
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** canonical name -> raw spellings (Arabic + Latin, per spec). */
const CITY_SPELLINGS: Array<[string, string[]]> = [
  ['Nouakchott', ['نواكشوط', 'انواكشوط', 'nouakchott']],
  ['Nouadhibou', ['نواذيبو', 'nouadhibou']],
  ['Atar', ['أطار', 'اطار', 'atar']],
  ['Rosso', ['روصو', 'rosso']],
  ['Kaédi', ['كيهيدي', 'kaédi', 'kaedi']],
  ['Zouérat', ['زويرات', 'zouérat', 'zouerat']],
  ['Akjoujt', ['أكجوجت', 'اكجوجت', 'akjoujt']],
  ['Sélibaby', ['سيلبابي', 'sélibaby', 'selibaby']],
  ['Néma', ['النعمة', 'نعمة', 'néma', 'nema']],
  ['Kiffa', ['كيفة', 'كيفه', 'kiffa']],
  ['Aleg', ['ألاك', 'الاك', 'aleg']],
  ['Ouadane', ['وادان', 'ouadane']],
  ['Oujeft', ['أوجفت', 'اوجفت', 'oujeft']],
  ['Chinguetti', ['شنقيط', 'chinguetti']],
  ['Tidjikja', ['تجكجة', 'tidjikja']],
  ['Boutilimit', ['بوتلميت', 'boutilimit']],
  ['Aïoun', ['عيون العتروس', 'aïoun', 'aioun']],
  ['Timbédra', ['تمبدغة', 'timbédra', 'timbedra']],
  ['Bogué', ['بوغي', 'bogué', 'bogue']],
  ['Chami', ['شامي', 'chami']],
  ['Boulenoir', ['بولنوار', 'boulenoir']],
  // v1.1 — towns added from crawled transport-route titles/slugs (spellings
  // taken verbatim from the site's own data; no external inference)
  ['Lexeiba', ['لكسيبا', 'lexeiba']],
  ["M'Bout", ['مبوت', "m'bout", 'mbout']],
  ['Maghama', ['ماغاما', 'maghama']],
  ['Monguel', ['مونغيل', 'monguel']],
  ['Bénichab', ['بنيشاب', 'bénichab', 'benichab']],
  ['Kermesin', ['كرمسين', 'kermesin']],
  ['Mederdra', ['المذرذرة', 'mederdra']],
  ["R'Kiz", ['ركيز', "r'kiz", 'rkiz']],
  ['Wad Naga', ['واد الناقة', 'wad naga']],
  ['Aouinat Ezbel', ['aouinat ezbel']],
  ['Amourj', ['amourj']],
  ['Nbeiket Lahwach', ['nbeiket lahwach']],
  ['Bassiknou', ['bassiknou']],
  ['Timbedgha', ['timbedgha']],
  ['Kankossa', ['كانكوصة', 'kankossa']],
  ['Barkéol', ['باركيول', 'barkéol', 'barkeol']],
  ['Boumdeid', ['بومديد', 'boumdeid']],
  ['Guerou', ['كرو', 'guerou']],
  ['Magtaa Lahjar', ['مقطع الحجار', 'magtaa lahjar']],
  ['Chegar', ['شكار', 'chegar']],
  ['Sangrave', ['سانغراف', 'sangrave']],
  ['Ould Yengé', ['ould yengé', 'ould yenge']],
  ['Ghabou', ['ghabou']],
  ['Tintane', ['tintane']],
  ['Tamchekett', ['tamchekett']],
  ['Koubni', ['koubni']],
  ['Moudjéria', ['موديرية', 'moudjéria', 'moudjeria']],
  ['Tichitt', ['تيشيت', 'tichitt']],
];

/** Built variants: canonical -> normalized token sequences (incl. ال-prefixed forms). */
const CITY_VARIANTS: Array<{ canonical: string; tokens: string[] }> = (() => {
  const out: Array<{ canonical: string; tokens: string[] }> = [];
  const seen = new Set<string>();
  for (const [canonical, spellings] of CITY_SPELLINGS) {
    const forms = new Set<string>();
    for (const raw of spellings) {
      const norm = normalizeForMatch(raw);
      if (!norm) continue;
      forms.add(norm);
      // definite-article variant for Arabic spellings not already carrying ال
      if (/^[\u0600-\u06ff]/.test(norm) && !norm.startsWith('ال')) forms.add(`ال${norm}`);
    }
    for (const form of forms) {
      const key = `${canonical}::${form}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ canonical, tokens: form.split(' ') });
    }
  }
  return out;
})();

/** Earliest whole-token match wins; longest variant wins at equal position. */
function matchCityInText(text: string | null): string | null {
  if (!text) return null;
  const tokens = normalizeForMatch(text).split(' ').filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    let best: { canonical: string; len: number } | null = null;
    for (const { canonical, tokens: vt } of CITY_VARIANTS) {
      if (vt.length > tokens.length - i) continue;
      let ok = true;
      for (let j = 0; j < vt.length; j++) {
        if (tokens[i + j] !== vt[j]) {
          ok = false;
          break;
        }
      }
      if (ok && (!best || vt.length > best.len)) best = { canonical, len: vt.length };
    }
    if (best) return best.canonical;
  }
  return null;
}

/** Search order per spec: rawLocation, then title (ar/en/fr), then slug. */
function resolveCity(
  rawLocation: string | null,
  title: { ar: string; en: string; fr: string },
  slug: string,
): string | null {
  return (
    matchCityInText(rawLocation) ??
    matchCityInText(title.ar) ??
    matchCityInText(title.en) ??
    matchCityInText(title.fr) ??
    matchCityInText(slug.replace(/-/g, ' '))
  );
}

// ---------------------------------------------------------------------------
// Description language detection + search text
// ---------------------------------------------------------------------------

function detectLanguage(text: string | null): 'ar' | 'fr' | 'mixed' | null {
  if (!text) return null;
  const arabic = (text.match(/[\u0600-\u06ff]/g) ?? []).length;
  const latin = (text.match(/[a-zA-Z]/g) ?? []).length;
  const total = arabic + latin;
  if (total === 0) return 'mixed';
  if (arabic / total > 0.7) return 'ar';
  if (latin / total > 0.7) return 'fr';
  return 'mixed';
}

function buildSearchText(l: {
  title: { ar: string; en: string; fr: string };
  city: string | null;
  district: string | null;
  category: string | null;
  description: string | null;
}): string {
  const parts = [
    l.title.ar,
    l.title.en,
    l.title.fr,
    l.city ?? '',
    l.district ?? '', // v1.3
    l.category ?? '',
    (l.description ?? '').slice(0, 200), // 200-char cap keeps the bundle small
  ];
  return parts
    .join(' ')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f\u064b-\u065f\u0670]/g, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Catalog card extraction
// ---------------------------------------------------------------------------

interface Card {
  detailUrl: string;
  thumbnail: string | null;
  h3Text: string;
  key: string | null;
  category: string | null;
}

function extractCards(html: string, pageUrl: string, withCategories: boolean): Card[] {
  const cards: Card[] = [];
  // h2 positions for the cars page (nearest preceding h2 = category)
  const h2s: Array<{ pos: number; text: string }> = [];
  if (withCategories) {
    const h2Re = /<h2\b[^>]*>([\s\S]*?)<\/h2\s*>/gi;
    let hm: RegExpExecArray | null;
    while ((hm = h2Re.exec(html)) !== null) {
      const text = inlineText(hm[1]);
      if (text) h2s.push({ pos: hm.index, text });
    }
  }
  for (const block of findElementBlocks(html, 'div', 'post-card')) {
    const detailUrl = cleanUrl(getAttr(block.openTag, 'data-href'), pageUrl);
    if (!detailUrl) {
      console.warn(`[skip] post-card without usable data-href on ${pageUrl}`);
      continue;
    }
    const imgTag = block.inner.match(/<img\b[^>]*>/i)?.[0] ?? '';
    const imgSrc = getAttr(imgTag, 'src') ?? getAttr(imgTag, 'data-src');
    const h3 = block.inner.match(/<h3\b[^>]*>([\s\S]*?)<\/h3\s*>/i);
    const h3Tag = block.inner.match(/<h3\b[^>]*>/i)?.[0] ?? '';
    let category: string | null = null;
    if (withCategories) {
      for (const h of h2s) {
        if (h.pos < block.start) category = h.text;
        else break;
      }
    }
    cards.push({
      detailUrl,
      thumbnail: cleanImageUrl(imgSrc, pageUrl),
      h3Text: h3 ? inlineText(h3[1]) : '',
      key: getAttr(h3Tag, 'data-translate'),
      category,
    });
  }
  return cards;
}

// ---------------------------------------------------------------------------
// Detail page extraction
// ---------------------------------------------------------------------------

/** Earliest element carrying one of the class names; inline text or null. */
function classText(html: string, classNames: string[]): string | null {
  let best: { start: number; inner: string } | null = null;
  for (const cls of classNames) {
    for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'p']) {
      const block = findElementBlocks(html, tag, cls)[0];
      if (block && (best === null || block.start < best.start)) {
        best = { start: block.start, inner: block.inner };
      }
    }
  }
  return best ? inlineText(best.inner) || null : null;
}

/** "السعر: 2,500 MRU" / "3500 MRU / ليلة" → { 2500, "MRU" } / { 3500, "MRU / ليلة" }. */
function parseAlbumPrice(text: string | null): { price: number | null; priceUnit: string | null } {
  if (!text) return { price: null, priceUnit: null };
  let s = text.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  s = s.replace(/^\s*السعر\s*[::]?\s*/u, '').trim();
  const m = s.match(/(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)/);
  if (!m || m.index === undefined) return { price: null, priceUnit: null };
  const value = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(value) || value <= 0) return { price: null, priceUnit: null }; // 0 = unpublished
  const unit = s
    .slice(m.index + m[1].length)
    .replace(/^[\s:،-]+/u, '')
    .trim();
  return { price: value, priceUnit: unit.length > 0 ? unit : null };
}

/** Cleaned, junk-filtered gallery images inside a block, page order. */
function galleryImagesIn(html: string, pageUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of findElementBlocks(html, 'div', 'gallery-item')) {
    const imgTag = item.inner.match(/<img\b[^>]*>/i)?.[0];
    if (!imgTag) continue;
    const url = cleanImageUrl(getAttr(imgTag, 'src') ?? getAttr(imgTag, 'data-src'), pageUrl);
    if (!url || isJunkImage(url) || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * v1.4 — album structure of hotel/apartment detail pages, document order.
 * Handles the three markup variants used on the site:
 *   .album (.album-title / .price-tag), .apartment-type
 *   (.apartment-title / .apartment-price), and a flat .gallery-section
 *   with a .section-title heading (single album).
 */
function extractAlbums(html: string, pageUrl: string): Album[] {
  const sections = [
    ...findElementBlocks(html, 'section', 'gallery-section'),
    ...findElementBlocks(html, 'div', 'gallery-section'),
  ].sort((a, b) => a.start - b.start);
  if (sections.length === 0) return [];

  const albums: Album[] = [];
  for (const section of sections) {
    const blocks = [
      ...findElementBlocks(section.inner, 'div', 'album'),
      ...findElementBlocks(section.inner, 'div', 'apartment-type'),
    ].sort((a, b) => a.start - b.start);

    if (blocks.length > 0) {
      for (const block of blocks) {
        const title = classText(block.inner, ['album-title', 'apartment-title']);
        const images = galleryImagesIn(block.inner, pageUrl);
        if (!title) {
          stats.albumIssues.push(`album block without a title on ${pageUrl}`);
          continue;
        }
        if (images.length === 0) {
          stats.albumIssues.push(`album "${title}" has no usable images on ${pageUrl}`);
          continue;
        }
        const { price, priceUnit } = parseAlbumPrice(
          classText(block.inner, ['price-tag', 'apartment-price']),
        );
        albums.push({ title, price, priceUnit, images });
      }
    } else {
      /* flat gallery: one album titled by the section heading */
      const images = galleryImagesIn(section.inner, pageUrl);
      if (images.length === 0) continue;
      const title =
        classText(section.inner, ['section-title']) ??
        (() => {
          const h = section.inner.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/i);
          return h ? inlineText(h[1]) || null : null;
        })();
      if (!title) {
        stats.albumIssues.push(`flat gallery without a heading on ${pageUrl}`);
        continue;
      }
      const { price, priceUnit } = parseAlbumPrice(
        classText(section.inner, ['price-tag', 'apartment-price']),
      );
      albums.push({ title, price, priceUnit, images });
    }
  }
  return albums;
}

interface DetailData {
  canonicalTitle: string | null;
  rawLocation: string | null;
  description: string | null;
  gallery: string[];
  albums: Album[];
  phones: string[];
}

function extractDetail(html: string | null, pageUrl: string): DetailData {
  if (!html)
    return {
      canonicalTitle: null,
      rawLocation: null,
      description: null,
      gallery: [],
      albums: [],
      phones: [],
    };

  const nameBlock = findElementBlocks(html, 'h1', 'hotel-name')[0]
    ?? findElementBlocks(html, 'div', 'hotel-name')[0]
    ?? findElementBlocks(html, 'h2', 'hotel-name')[0]
    ?? findElementBlocks(html, 'span', 'hotel-name')[0];
  let canonicalTitle = nameBlock ? inlineText(nameBlock.inner) : null;
  if (!canonicalTitle) {
    const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i);
    canonicalTitle = h1 ? inlineText(h1[1]) : null;
  }

  const locBlock = findElementBlocks(html, 'p', 'hotel-location')[0]
    ?? findElementBlocks(html, 'div', 'hotel-location')[0]
    ?? findElementBlocks(html, 'span', 'hotel-location')[0];
  const rawLocation = locBlock ? inlineText(locBlock.inner) : null;

  const descBlock = findElementBlocks(html, 'div', 'description-content')[0];
  let description: string | null = descBlock ? blockText(descBlock.inner) : null;
  if (!description) {
    // meta description fallback; skip auto-generated excerpts that just echo
    // the nav menu / language switcher ("... FR AR EN ...")
    const metaTag = html.match(/<meta\b[^>]*name=["']description["'][^>]*>/i)?.[0];
    const meta = metaTag ? decodeEntities(getAttr(metaTag, 'content') ?? '') : '';
    const cleanMeta = meta.replace(/\s+/g, ' ').trim();
    if (cleanMeta && !/\bFR AR EN\b/i.test(cleanMeta)) description = cleanMeta;
  }

  const gallery: string[] = [];
  const seen = new Set<string>();
  for (const item of findElementBlocks(html, 'div', 'gallery-item')) {
    const imgTag = item.inner.match(/<img\b[^>]*>/i)?.[0];
    if (!imgTag) continue;
    const url = cleanImageUrl(getAttr(imgTag, 'src') ?? getAttr(imgTag, 'data-src'), pageUrl);
    if (!url || isJunkImage(url) || seen.has(url)) continue;
    seen.add(url);
    gallery.push(url);
  }

  // tel: links are the one permitted SOURCE of phone data (v1.2); the numbers
  // are stored bare ("+222 XX XX XX XX"), never as tel: URLs. Page order kept.
  const phones: string[] = [];
  const phoneSeen = new Set<string>();
  const telRe = /href\s*=\s*["']tel:([^"']+)["']/gi;
  let tm: RegExpExecArray | null;
  while ((tm = telRe.exec(html)) !== null) {
    const normalized = normalizePhone(tm[1]);
    if (!normalized) {
      console.warn(`[tel] unparseable tel: link "${tm[1]}" on ${pageUrl}`);
      continue;
    }
    if (SITE_WIDE_PHONES.has(normalized)) continue; // 2hlen's own footer numbers
    if (phoneSeen.has(normalized)) continue;
    phoneSeen.add(normalized);
    phones.push(normalized);
  }

  return {
    canonicalTitle: canonicalTitle || null,
    rawLocation: rawLocation || null,
    description: description || null,
    gallery,
    albums: extractAlbums(html, pageUrl),
    phones,
  };
}

// ---------------------------------------------------------------------------
// Record building + dedup
// ---------------------------------------------------------------------------

interface BuiltRecord {
  listing: Listing;
  hasResolvedTranslation: boolean;
}

function slugFromUrl(url: string): string | null {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : null;
  } catch {
    return null;
  }
}

function buildRecord(opts: {
  slug: string;
  type: ListingType;
  isRegion: boolean;
  parentId: string | null;
  category: string | null;
  card: Card;
  translations: Translations;
  detail: DetailData;
  sourceUrl: string;
  sourcePageId: number;
  pageRef: string;
}): BuiltRecord {
  const { slug, type, card, translations, detail } = opts;

  const fallbackTitle = card.h3Text || detail.canonicalTitle || '';
  let hasResolvedTranslation = false;
  const title = { ar: fallbackTitle, en: fallbackTitle, fr: fallbackTitle };
  if (card.key) {
    for (const lang of ['ar', 'en', 'fr'] as const) {
      const t = translations[lang][card.key];
      if (t !== undefined && t.trim() !== '') {
        title[lang] = t.trim();
        hasResolvedTranslation = true;
      } else {
        stats.missingTranslationKeys.add(`${card.key} [${lang}] @ ${opts.pageRef}`);
        console.warn(`[i18n] key "${card.key}" missing for "${lang}" on ${opts.pageRef}`);
      }
    }
  } else {
    stats.missingTranslationKeys.add(`<no data-translate> (${slug}) @ ${opts.pageRef}`);
    console.warn(`[i18n] card "${slug}" has no data-translate key on ${opts.pageRef}`);
  }

  const rawLocation = sanitizeText(detail.rawLocation);
  const description = sanitizeText(detail.description);
  const city = opts.type === 'car' ? null : resolveCity(rawLocation, title, slug);
  const thumbnail = card.thumbnail ?? detail.gallery[0] ?? null;

  const listing: Listing = {
    id: slug,
    type,
    isRegion: opts.isRegion,
    parentId: opts.parentId,
    category: opts.category,
    title,
    city,
    district: null, // filled by the v1.3 homepage join
    rawLocation,
    description: { original: description, language: detectLanguage(description) },
    images: detail.gallery,
    albums: type === 'hotel' || type === 'apartment' ? detail.albums : [],
    thumbnail,
    phones: type === 'restaurant' ? detail.phones : [],
    location: { lat: null, lng: null },
    price: null, // filled by the v1.3 homepage join
    sourceUrl: opts.sourceUrl,
    searchText: buildSearchText({
      title,
      city,
      district: null,
      category: opts.category,
      description,
    }),
    metadata: { sourcePageId: opts.sourcePageId, extractorVersion: EXTRACTOR_VERSION },
  };
  return { listing, hasResolvedTranslation };
}

/** more images > longer description > resolved city > translated title */
function richness(r: BuiltRecord): number[] {
  return [
    r.listing.images.length,
    (r.listing.description.original ?? '').length,
    r.listing.city ? 1 : 0,
    r.hasResolvedTranslation ? 1 : 0,
  ];
}

const records = new Map<string, BuiltRecord>();

function addRecord(rec: BuiltRecord): void {
  const existing = records.get(rec.listing.id);
  if (!existing) {
    records.set(rec.listing.id, rec);
    return;
  }
  stats.duplicatesRemoved++;
  const a = richness(existing);
  const b = richness(rec);
  for (let i = 0; i < a.length; i++) {
    if (b[i] !== a[i]) {
      if (b[i] > a[i]) records.set(rec.listing.id, rec); // keeps original position
      return;
    }
  }
  // full tie: keep the first record encountered
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function collectStrings(value: unknown, path0: string, out: Array<[string, string]>): void {
  if (typeof value === 'string') out.push([path0, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => collectStrings(v, `${path0}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectStrings(v, `${path0}.${k}`, out);
  }
}

/**
 * A string fails only if it contains a URL on a blocked hostname or scheme.
 * v1.2 narrowing: tel: links are permitted ONLY as the extraction source of
 * restaurant `phones`, which stores bare "+222 XX XX XX XX" numbers — so a
 * tel:/mailto:/wa.me/whatsapp URL is still banned in every STORED field.
 */
function findBlockedUrl(s: string): string | null {
  const httpRe = /https?:\/\/[^\s"'<>]+/gi;
  let m: RegExpExecArray | null;
  while ((m = httpRe.exec(s)) !== null) {
    try {
      if (BLOCKED_HOSTNAMES.has(new URL(m[0]).hostname)) return `blocked contact URL "${m[0]}"`;
    } catch {
      // not parseable — not a URL match
    }
  }
  if (/(^|[^.\p{L}])wa\.me\//iu.test(s)) return 'blocked wa.me reference';
  if (/(^|[^.\p{L}])wa\.link\//iu.test(s)) return 'blocked wa.link reference';
  if (/whatsapp\.link\//i.test(s)) return 'blocked whatsapp.link reference';
  if (/whatsapp:\/\//i.test(s)) return 'whatsapp:// scheme';
  if (/(^|[^\p{L}])tel:/iu.test(s)) return 'tel: scheme';
  if (/mailto:/i.test(s)) return 'mailto: scheme';
  if (/javascript:/i.test(s)) return 'javascript: scheme';
  return null;
}

function validate(listings: Listing[]): Array<{ id: string; reason: string }> {
  const errors: Array<{ id: string; reason: string }> = [];
  const ids = new Set<string>();
  const urls = new Set<string>();
  const idSet = new Set(listings.map((l) => l.id));

  for (const l of listings) {
    const id = l.id || '<missing id>';
    if (ids.has(l.id)) errors.push({ id, reason: 'duplicate id' });
    ids.add(l.id);
    if (urls.has(l.sourceUrl)) errors.push({ id, reason: `duplicate sourceUrl ${l.sourceUrl}` });
    urls.add(l.sourceUrl);
    if (!l.type) errors.push({ id, reason: 'missing type' });
    if (!l.sourceUrl) errors.push({ id, reason: 'missing sourceUrl' });
    if (!l.title.ar.trim() && !l.title.en.trim() && !l.title.fr.trim())
      errors.push({ id, reason: 'empty title in every language' });
    if (l.type === 'transport' && !l.parentId)
      errors.push({ id, reason: 'transport route without parentId' });
    if (l.parentId !== null && !idSet.has(l.parentId))
      errors.push({ id, reason: `parentId "${l.parentId}" does not resolve` });
    if (
      !(
        l.price === null ||
        (typeof l.price === 'number' && Number.isFinite(l.price) && l.price > 0)
      )
    )
      errors.push({ id, reason: `price must be null or > 0, got ${JSON.stringify(l.price)}` });
    if (
      !(
        l.district === null ||
        (typeof l.district === 'string' && l.district.trim().length > 0)
      )
    )
      errors.push({ id, reason: 'district must be null or a non-empty string' });

    if (l.type !== 'restaurant' && l.phones.length > 0)
      errors.push({ id, reason: 'phones must be empty for non-restaurant records' });
    const seenPhones = new Set<string>();
    for (const p of l.phones) {
      if (!/^\+222 \d{2} \d{2} \d{2} \d{2}$/.test(p))
        errors.push({ id, reason: `phone not normalized "+222 XX XX XX XX": ${p}` });
      if (SITE_WIDE_PHONES.has(p))
        errors.push({ id, reason: `site-wide 2hlen number stored: ${p}` });
      if (seenPhones.has(p)) errors.push({ id, reason: `duplicate phone ${p}` });
      seenPhones.add(p);
    }

    const strings: Array<[string, string]> = [];
    collectStrings(l, 'record', strings);
    for (const [p, s] of strings) {
      const blocked = findBlockedUrl(s);
      if (blocked) errors.push({ id, reason: `${blocked} at ${p}` });
    }

    const seenImages = new Set<string>();
    for (const img of l.images) {
      if (seenImages.has(img)) errors.push({ id, reason: `duplicate image ${img}` });
      seenImages.add(img);
    }

    /* v1.4 — album rules */
    const flat = new Set(l.images);
    for (const a of l.albums) {
      if (typeof a.title !== 'string' || a.title.trim() === '')
        errors.push({ id, reason: 'album with empty title' });
      if (a.images.length === 0)
        errors.push({ id, reason: `album "${a.title}" has no images` });
      for (const img of a.images) {
        if (!flat.has(img))
          errors.push({ id, reason: `album image not in images[]: ${img}` });
      }
      if (
        !(
          a.price === null ||
          (typeof a.price === 'number' && Number.isFinite(a.price) && a.price > 0)
        )
      )
        errors.push({ id, reason: `album "${a.title}" price must be null or > 0` });
    }
    for (const img of [...l.images, ...(l.thumbnail ? [l.thumbnail] : [])]) {
      let ok = false;
      try {
        const u = new URL(img);
        ok = (u.protocol === 'http:' || u.protocol === 'https:') && IMAGE_HOSTS.has(u.hostname);
      } catch {
        ok = false;
      }
      if (!ok) errors.push({ id, reason: `image URL not absolute http(s) on 2hlen.com: ${img}` });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Homepage data join (v1.3) — prices & districts from embedded JS arrays.
// allSearchData is deliberately IGNORED: its city/area values are corrupted.
// ---------------------------------------------------------------------------

const HOMEPAGE_URL = `${BASE}/`;

/** Balanced [...] scan, string/comment-aware like scanBalancedObject. */
function scanBalancedArray(src: string, openIdx: number): string | null {
  let depth = 0;
  let i = openIdx;
  let state: 'code' | 'sq' | 'dq' | 'tpl' | 'line' | 'block' = 'code';
  for (; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (state === 'code') {
      if (c === '[') depth++;
      else if (c === ']') {
        depth--;
        if (depth === 0) return src.slice(openIdx, i + 1);
      } else if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'tpl';
      else if (c === '/' && next === '/') state = 'line';
      else if (c === '/' && next === '*') state = 'block';
    } else if (state === 'sq') {
      if (c === '\\') i++;
      else if (c === "'") state = 'code';
    } else if (state === 'dq') {
      if (c === '\\') i++;
      else if (c === '"') state = 'code';
    } else if (state === 'tpl') {
      if (c === '\\') i++;
      else if (c === '`') state = 'code';
    } else if (state === 'line') {
      if (c === '\n') state = 'code';
    } else if (state === 'block') {
      if (c === '*' && next === '/') {
        state = 'code';
        i++;
      }
    }
  }
  return null;
}

/** String property at any depth of a flat-ish entry source. */
function jsStringProp(objSrc: string, key: string): string | null {
  const m = objSrc.match(
    new RegExp(
      `(?:^|[,{\\s])${key}\\s*:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)')`,
    ),
  );
  if (!m) return null;
  const value = decodeEntities(unescapeJsString(m[1] ?? m[2] ?? '')).trim();
  return value.length > 0 ? value : null;
}

function jsNumberProp(objSrc: string, key: string): number | null {
  const m = objSrc.match(new RegExp(`(?:^|[,{\\s])${key}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
  return m ? Number(m[1]) : null;
}

/** Top-level object sources of `const <name> = [...]`; null if absent. */
function parseJsArrayEntries(html: string, name: string): string[] | null {
  const decl = new RegExp(`const\\s+${name}\\s*=\\s*\\[`).exec(html);
  if (!decl) return null;
  const arrSrc = scanBalancedArray(html, decl.index + decl[0].length - 1);
  if (!arrSrc) return null;
  const objs: string[] = [];
  let i = 1;
  while (i < arrSrc.length - 1) {
    if (arrSrc[i] === '{') {
      const obj = scanBalancedObject(arrSrc, i);
      if (!obj) break;
      objs.push(obj);
      i += obj.length;
    } else i++;
  }
  return objs;
}

/** The site's own city → districts reference (const areaData = {...}). */
function parseAreaData(html: string): Array<[string, string[]]> | null {
  const decl = /const\s+areaData\s*=\s*\{/.exec(html);
  if (!decl) return null;
  const objSrc = scanBalancedObject(html, decl.index + decl[0].length - 1);
  if (!objSrc) return null;
  const out: Array<[string, string[]]> = [];
  const cityRe = /"((?:[^"\\]|\\.)+)"\s*:\s*\[((?:[^\]])*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = cityRe.exec(objSrc)) !== null) {
    const districts: string[] = [];
    const strRe = /"((?:[^"\\]|\\.)*)"/g;
    let s: RegExpExecArray | null;
    while ((s = strRe.exec(m[2])) !== null) {
      const v = decodeEntities(unescapeJsString(s[1])).trim();
      if (v) districts.push(v);
    }
    out.push([decodeEntities(unescapeJsString(m[1])).trim(), districts]);
  }
  return out;
}

/** lowercase origin+pathname, no trailing slash — the join key. */
function normalizeLink(u: string | null): string | null {
  if (!u) return null;
  try {
    const url = new URL(decodeEntities(u.trim()), BASE);
    let s = `${url.origin}${url.pathname}`.toLowerCase();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

async function processCard(opts: {
  card: Card;
  type: ListingType;
  isRegion: boolean;
  parentId: string | null;
  sourcePageId: number;
  translations: Translations;
  pageRef: string;
}): Promise<{ slug: string; detailHtml: string | null } | null> {
  const { card } = opts;
  const slug = slugFromUrl(card.detailUrl);
  if (!slug) {
    stats.skippedPages.push(card.detailUrl);
    console.warn(`[skip] cannot derive slug from ${card.detailUrl}`);
    return null;
  }
  const detailHtml = await fetchCached(card.detailUrl, 'html');
  if (detailHtml === null) stats.skippedPages.push(card.detailUrl);
  const detail = extractDetail(detailHtml, card.detailUrl);
  addRecord(
    buildRecord({
      slug,
      type: opts.type,
      isRegion: opts.isRegion,
      parentId: opts.parentId,
      category: card.category,
      card,
      translations: opts.translations,
      detail,
      sourceUrl: card.detailUrl,
      sourcePageId: opts.sourcePageId,
      pageRef: opts.pageRef,
    }),
  );
  return { slug, detailHtml };
}

async function ensureGitignore(): Promise<void> {
  const gitignorePath = path.join(ROOT, '.gitignore');
  if (!existsSync(gitignorePath)) return; // only if .gitignore already exists
  const content = await fs.readFile(gitignorePath, 'utf8');
  const hasEntry = content
    .split('\n')
    .some((line) => line.trim() === '.cache/' || line.trim() === '.cache');
  if (!hasEntry) {
    const sep = content.endsWith('\n') || content === '' ? '' : '\n';
    await fs.writeFile(gitignorePath, `${content}${sep}.cache/\n`, 'utf8');
    console.log('[setup] added .cache/ to .gitignore');
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await ensureGitignore();

  // previous output (if any) — used only for the "images recovered" summary line
  let previous: Listing[] | null = null;
  try {
    previous = JSON.parse(await fs.readFile(OUT_FILE, 'utf8'));
  } catch {
    previous = null;
  }

  for (const page of CATALOG_PAGES) {
    const restUrl = `${BASE}/wp-json/wp/v2/pages/${page.id}?_fields=id,slug,link,content`;
    const body = await fetchCached(restUrl, 'json');
    if (body === null) {
      stats.skippedPages.push(restUrl);
      console.warn(`[skip] catalog page ${page.id} unavailable`);
      continue;
    }
    let html: string;
    let pageLink: string;
    try {
      const json = JSON.parse(body);
      html = json.content?.rendered ?? '';
      pageLink = json.link ?? BASE;
    } catch (err) {
      stats.skippedPages.push(restUrl);
      console.warn(`[skip] catalog page ${page.id}: invalid JSON (${String(err)})`);
      continue;
    }
    const translations = parseTranslations(html);
    const cards = extractCards(html, pageLink, page.type === 'car');
    console.log(`[catalog] page ${page.id} (${page.type}): ${cards.length} cards`);

    for (const card of cards) {
      if (page.type === 'transport') {
        // 505 cards are REGIONS; each region page holds the actual route cards.
        const region = await processCard({
          card,
          type: 'transport_region',
          isRegion: true,
          parentId: null,
          sourcePageId: page.id,
          translations,
          pageRef: `page ${page.id}`,
        });
        if (!region || region.detailHtml === null) continue;
        // Recurse exactly ONE level: extract the region's route cards.
        const regionTranslations = parseTranslations(region.detailHtml);
        const routeCards = extractCards(region.detailHtml, card.detailUrl, false);
        console.log(`[region] ${region.slug}: ${routeCards.length} routes`);
        for (const routeCard of routeCards) {
          await processCard({
            card: routeCard,
            type: 'transport',
            isRegion: false,
            parentId: region.slug,
            sourcePageId: page.id,
            translations: regionTranslations,
            pageRef: `region ${region.slug}`,
          });
        }
      } else {
        await processCard({
          card,
          type: page.type,
          isRegion: false,
          parentId: null,
          sourcePageId: page.id,
          translations,
          pageRef: `page ${page.id}`,
        });
      }
    }
  }

  // ------------------------------------------------------- v1.3 homepage join
  const homepageHtml = await fetchCached(HOMEPAGE_URL, 'html');
  if (homepageHtml === null) {
    console.error('FATAL: homepage unavailable — cannot join prices/districts');
    process.exitCode = 1;
    return;
  }

  const byUrl = new Map<string, Listing>();
  for (const r of records.values()) {
    const key = normalizeLink(r.listing.sourceUrl);
    if (key) byUrl.set(key, r.listing);
  }

  const join = {
    gainedPrice: new Map<string, number[]>(),
    gainedDistrict: new Map<string, number>(),
    cityFilled: [] as string[],
    cityConflicts: [] as string[],
    unresolvedCities: new Set<string>(),
    unmatchedEntries: [] as string[],
    matchedIds: new Set<string>(),
    duplicates: [] as string[],
  };

  /* transportData is parsed for match-reporting only: nothing is changed
     for transport in this pass (per spec). allSearchData is never read. */
  const JOIN_ARRAYS: Array<{ name: string; apply: boolean }> = [
    { name: 'hotelsData', apply: true },
    { name: 'apartmentsData', apply: true },
    { name: 'carsData', apply: true },
    { name: 'transportData', apply: false },
    { name: 'restaurantsData', apply: true },
  ];

  for (const { name, apply } of JOIN_ARRAYS) {
    const entries = parseJsArrayEntries(homepageHtml, name);
    if (entries === null) {
      console.warn(`[join] array ${name} not found on homepage`);
      continue;
    }
    console.log(`[join] ${name}: ${entries.length} entries${apply ? '' : ' (report-only)'}`);
    for (const src of entries) {
      const link = jsStringProp(src, 'link') ?? jsStringProp(src, 'l');
      const label = jsStringProp(src, 'ar') ?? link ?? '<no link>';
      const key = normalizeLink(link);
      const rec = key ? byUrl.get(key) : undefined;
      if (!rec) {
        join.unmatchedEntries.push(`${name}: ${label} (${link ?? 'no link'})`);
        continue;
      }
      if (join.matchedIds.has(rec.id)) {
        join.duplicates.push(`${name}: ${label} → ${rec.id} (already matched)`);
      }
      join.matchedIds.add(rec.id);
      if (!apply) continue;

      const price = jsNumberProp(src, 'price');
      if (price !== null && price > 0 && rec.price === null) {
        // price 0 in the source means "no price published" → stays null
        rec.price = price;
        const arr = join.gainedPrice.get(rec.type) ?? [];
        arr.push(price);
        join.gainedPrice.set(rec.type, arr);
      }
      const area = jsStringProp(src, 'area');
      if (area && rec.district === null) {
        rec.district = area; // stored exactly as the site has it
        join.gainedDistrict.set(rec.type, (join.gainedDistrict.get(rec.type) ?? 0) + 1);
      }
      const cityAr = jsStringProp(src, 'city');
      if (cityAr) {
        const canonical = matchCityInText(cityAr);
        if (!canonical) join.unresolvedCities.add(cityAr);
        else if (rec.city === null) {
          rec.city = canonical;
          join.cityFilled.push(`${rec.id}: ${canonical} (from "${cityAr}")`);
        } else if (rec.city !== canonical) {
          join.cityConflicts.push(
            `${rec.id}: ours "${rec.city}" ≠ array "${cityAr}" → ${canonical} (kept ours)`,
          );
        }
      }
    }
  }

  /* transportCitiesData — REPORT ONLY */
  const tcEntries = parseJsArrayEntries(homepageHtml, 'transportCitiesData');
  const tcReport: string[] = [];
  const tcMatchedRoutes = new Set<string>();
  if (tcEntries) {
    const allListings = Array.from(records.values()).map((r) => r.listing);
    for (const src of tcEntries) {
      const region = byUrl.get(normalizeLink(jsStringProp(src, 'l')) ?? '');
      const cityAr = jsStringProp(src, 'ar');
      const canonical = cityAr ? matchCityInText(cityAr) : null;
      const p = jsNumberProp(src, 'p');
      const a = jsStringProp(src, 'a');
      const route =
        region && canonical
          ? allListings.find(
              (l) =>
                l.type === 'transport' &&
                l.parentId === region.id &&
                l.city === canonical,
            )
          : undefined;
      if (route) tcMatchedRoutes.add(route.id);
      const adds: string[] = [];
      if (p !== null && p > 0) adds.push(`price ${p}`);
      if (a) adds.push(`district "${a}"`);
      tcReport.push(
        `  ${cityAr ?? '?'}${canonical ? ` → ${canonical}` : ' (no canonical city)'} @ ${region?.id ?? 'unknown-region'} → ${route ? route.id : 'NO ROUTE MATCH'}${adds.length ? ` (would add ${adds.join(', ')})` : ' (nothing to add)'}`,
      );
    }
  }

  const siteAreaData = parseAreaData(homepageHtml);

  /* city/district changed → recompute the search index */
  for (const r of records.values()) {
    const l = r.listing;
    l.searchText = buildSearchText({
      title: l.title,
      city: l.city,
      district: l.district,
      category: l.category,
      description: l.description.original,
    });
  }

  const listings = Array.from(records.values()).map((r) => r.listing);
  const output = `${JSON.stringify(listings, null, 2)}\n`;
  await fs.mkdir(OUT_DIR, { recursive: true });

  const errors = validate(listings);
  if (errors.length > 0) {
    await fs.writeFile(INVALID_FILE, output, 'utf8');
    console.error(`\nVALIDATION FAILED — wrote ${path.relative(ROOT, INVALID_FILE)}`);
    for (const e of errors) console.error(`  ${e.id}: ${e.reason}`);
    process.exitCode = 1;
  } else {
    await fs.writeFile(OUT_FILE, output, 'utf8');
    console.log(`\nWrote ${path.relative(ROOT, OUT_FILE)} (${listings.length} records)`);
  }

  // ------------------------------------------------------------------ summary
  const byType = new Map<string, number>();
  for (const l of listings) byType.set(l.type, (byType.get(l.type) ?? 0) + 1);
  const regions = listings.filter((l) => l.type === 'transport_region').length;
  const routes = listings.filter((l) => l.type === 'transport').length;
  const withCity = listings.filter((l) => l.city !== null).length;
  const withDesc = listings.filter((l) => l.description.original !== null).length;
  const withImages = listings.filter((l) => l.images.length > 0).length;
  const totalImages = listings.reduce((sum, l) => sum + l.images.length, 0);

  console.log('\n===== SUMMARY =====');
  console.log(`total:                    ${listings.length}`);
  for (const [t, n] of byType) console.log(`  ${t.padEnd(22)}  ${n}`);
  console.log(`regions vs routes:        ${regions} regions / ${routes} routes`);
  console.log(`cities resolved:          ${withCity}`);
  console.log(`city null:                ${listings.length - withCity}`);
  console.log(`with description:         ${withDesc}`);
  console.log(`without description:      ${listings.length - withDesc}`);
  console.log(`with images:              ${withImages}`);
  console.log(`without images:           ${listings.length - withImages}`);
  console.log(
    `avg images/listing:       ${listings.length ? (totalImages / listings.length).toFixed(2) : '0'}`,
  );
  console.log(`duplicates removed:       ${stats.duplicatesRemoved}`);
  console.log(`blocked contact urls:     ${stats.blockedContactUrls}`);
  console.log(`offsite images dropped:   ${stats.offsiteImagesDropped}`);
  console.log(`missing translation keys: ${stats.missingTranslationKeys.size}`);
  console.log(`skipped pages:            ${stats.skippedPages.length}`);
  console.log(`failed requests:          ${stats.failedRequests.length}`);
  console.log(`cache hits/misses:        ${stats.cacheHits}/${stats.cacheMisses}`);
  console.log(`duration:                 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  console.log(`validation errors:        ${errors.length}`);

  const thumbsNow = listings.filter((l) => l.thumbnail !== null).length;
  const zeroImages = listings.filter((l) => l.images.length === 0);
  if (previous) {
    const prevImages = previous.reduce((sum, l) => sum + l.images.length, 0);
    const prevThumbs = previous.filter((l) => l.thumbnail !== null).length;
    console.log(
      `images recovered vs previous run: ${totalImages - prevImages >= 0 ? '+' : ''}${totalImages - prevImages} gallery, ${thumbsNow - prevThumbs >= 0 ? '+' : ''}${thumbsNow - prevThumbs} thumbnails`,
    );
  } else {
    console.log('images recovered vs previous run: n/a (no previous output)');
  }
  console.log(`listings still with zero images:  ${zeroImages.length}`);
  console.log(`new city-null count:              ${listings.length - withCity}`);

  const restaurants = listings.filter((l) => l.type === 'restaurant');
  const restaurantsWithPhones = restaurants.filter((r) => r.phones.length > 0);
  console.log(
    `restaurants with phone numbers:   ${restaurantsWithPhones.length}/${restaurants.length}`,
  );
  for (const r of restaurants) {
    console.log(`  ${r.id}: ${r.phones.length > 0 ? r.phones.join(', ') : '(none)'}`);
  }

  // ---------------------------------------------------- v1.3 join report
  console.log('\n===== v1.3 HOMEPAGE JOIN =====');
  const typeOrder = ['hotel', 'apartment', 'car', 'transport_region', 'transport', 'restaurant'];
  console.log(`records with price:       ${listings.filter((l) => l.price !== null).length}`);
  for (const t of typeOrder) {
    const prices = listings
      .filter((l) => l.type === t && l.price !== null)
      .map((l) => l.price as number)
      .sort((a, b) => a - b);
    if (prices.length === 0) continue;
    const median =
      prices.length % 2 === 1
        ? prices[(prices.length - 1) / 2]
        : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2;
    console.log(
      `  ${t.padEnd(18)} ${String(prices.length).padStart(3)}  min ${prices[0]}  max ${prices[prices.length - 1]}  median ${median}`,
    );
  }
  console.log(`records with district:    ${listings.filter((l) => l.district !== null).length}`);
  for (const t of typeOrder) {
    const n = listings.filter((l) => l.type === t && l.district !== null).length;
    if (n > 0) console.log(`  ${t.padEnd(18)} ${n}`);
  }
  console.log(`cities filled from null:  ${join.cityFilled.length}`);
  for (const s of join.cityFilled) console.log(`  + ${s}`);
  console.log(`city conflicts:           ${join.cityConflicts.length}`);
  for (const s of join.cityConflicts) console.log(`  ! ${s}`);
  if (join.unresolvedCities.size > 0) {
    console.log(
      `array cities with no canonical mapping (nothing filled): ${Array.from(join.unresolvedCities).join(', ')}`,
    );
  }
  console.log(`array entries matching no record: ${join.unmatchedEntries.length}`);
  for (const s of join.unmatchedEntries) console.log(`  - ${s}`);
  const COVERED_TYPES = new Set(['hotel', 'apartment', 'car', 'restaurant', 'transport_region']);
  const unmatchedRecords = listings.filter(
    (l) => COVERED_TYPES.has(l.type) && !join.matchedIds.has(l.id),
  );
  console.log(`records matched by no array entry: ${unmatchedRecords.length}`);
  for (const l of unmatchedRecords) console.log(`  - ${l.type}: ${l.id}`);
  if (join.duplicates.length > 0) {
    console.log(`duplicate entry hits:     ${join.duplicates.length}`);
    for (const s of join.duplicates) console.log(`  ~ ${s}`);
  }

  console.log('\ndistricts per city (our records):');
  const districtsByCity = new Map<string, Set<string>>();
  for (const l of listings) {
    if (l.district === null) continue;
    const key = l.city ?? '(sans ville)';
    if (!districtsByCity.has(key)) districtsByCity.set(key, new Set());
    districtsByCity.get(key)!.add(l.district);
  }
  for (const [c, ds] of Array.from(districtsByCity.entries()).sort((a, b) =>
    a[0].localeCompare(b[0], 'fr'),
  )) {
    console.log(
      `  ${c}: ${Array.from(ds)
        .sort((a, b) => a.localeCompare(b, 'fr'))
        .join(' | ')}`,
    );
  }
  if (siteAreaData) {
    console.log('\nsite areaData reference (city → districts):');
    for (const [c, ds] of siteAreaData) console.log(`  ${c}: ${ds.join(' | ')}`);
  } else {
    console.log('\nsite areaData: not found on homepage');
  }

  console.log('\ntransportCitiesData (REPORT ONLY — transport unchanged this pass):');
  console.log(
    `  entries: ${tcEntries ? tcEntries.length : 0}, routes it could match: ${tcMatchedRoutes.size}/${routes}`,
  );
  for (const s of tcReport) console.log(s);

  // ---------------------------------------------------- v1.4 album report
  console.log('\n===== v1.4 ALBUMS =====');
  const withAlbums = listings.filter((l) => l.albums.length > 0);
  const multiAlbum = listings.filter((l) => l.albums.length > 1);
  console.log(
    `records with albums:      ${withAlbums.length} (hotels ${withAlbums.filter((l) => l.type === 'hotel').length}, apartments ${withAlbums.filter((l) => l.type === 'apartment').length})`,
  );
  console.log(
    `with more than one album: ${multiAlbum.length} (hotels ${multiAlbum.filter((l) => l.type === 'hotel').length}, apartments ${multiAlbum.filter((l) => l.type === 'apartment').length})`,
  );
  const titleCounts = new Map<string, number>();
  for (const l of listings) {
    for (const t of new Set(l.albums.map((a) => a.title))) {
      titleCounts.set(t, (titleCounts.get(t) ?? 0) + 1);
    }
  }
  console.log(`distinct album titles:    ${titleCounts.size}`);
  for (const [t, n] of Array.from(titleCounts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ar'))) {
    console.log(`  ${String(n).padStart(3)}×  ${t}`);
  }
  console.log('album price vs record price:');
  let priceDiffs = 0;
  for (const l of listings) {
    for (const a of l.albums) {
      if (a.price !== null && a.price !== l.price) {
        priceDiffs++;
        console.log(`  ${l.id}: album "${a.title}" ${a.price} vs record ${l.price ?? 'null'}`);
      }
    }
  }
  if (priceDiffs === 0) console.log('  (none)');
  console.log(`album parse issues:       ${stats.albumIssues.length}`);
  for (const s of stats.albumIssues) console.log(`  ! ${s}`);

  console.log('\n===== PREVIEW (first two of each type) =====');
  for (const t of ['hotel', 'apartment', 'car', 'transport_region', 'transport', 'restaurant']) {
    for (const l of listings.filter((x) => x.type === t).slice(0, 2)) {
      console.log(JSON.stringify(l, null, 2));
    }
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
