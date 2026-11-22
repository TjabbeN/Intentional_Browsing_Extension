// Intentional Browsing: managed configuration parsing.
//
// An administrator supplies block lists, exceptions, keywords, remote list
// URLs and feature toggles through chrome.storage.managed (enterprise policy,
// see schema.json and README.md). This file turns whatever arrives there into
// normalised lookup structures. It never throws: malformed entries are
// skipped and counted.
//
// Loaded by the service worker (importScripts) and by the popup.

'use strict';

const MANAGED_LIST_KEYS = [
  'blockedSites', 'allowedSubdomains', 'allowedPaths',
  'keywordsAnywhere', 'keywordsSubstring', 'keywordsSearch', 'keywordsSoft',
  'keywordsFuzzy', 'fuzzyIgnoreWords',
  'blocklistUrls', 'lockdownExtraSites', 'translationHosts', 'archiveOrgTerms'
];

// Used when a toggle is absent from the managed configuration.
const MANAGED_TOGGLE_DEFAULTS = {
  closeIncognitoTabs: false,
  blockExtensionsPage: false,
  scrubHistory: true,
  archiveOrgCheck: false,
  pageCheck: false,
  mentionCheck: false
};

// Translation tools often carry the source text in the URL hash or in
// arbitrary query parameters, so on these hosts keywordsSearch is matched
// against those as well. Used when translationHosts is absent.
const DEFAULT_TRANSLATION_HOSTS = [
  'translate.google.com', 'translate.googleusercontent.com',
  'deepl.com',
  'translate.yandex.com', 'translate.yandex.ru',
  'reverso.net', 'context.reverso.net',
  'linguee.com',
  'translate.com',
  'mymemory.translated.net',
  'papago.naver.com',
  'libretranslate.com'
];

const HOST_RE = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;

/** Lowercases a hostname and drops a trailing dot and a leading "www.". */
function normalizeHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');
}

// Google serves the same properties on every country domain (google.be,
// google.co.uk, ...). Every Google host is folded onto its .com form before
// matching, so one entry covers all of them:
//   google.be             -> google.com
//   <sub>.google.co.uk    -> <sub>.google.com
//   google.de/preferences -> google.com/preferences
const GOOGLE_HOST_RE = /^(?:([a-z0-9-]+)\.)?google\.[a-z]{2,3}(?:\.[a-z]{2})?$/;
function canonicalizeHost(host) {
  const m = host.match(GOOGLE_HOST_RE);
  if (!m) return host;
  return m[1] ? `${m[1]}.google.com` : 'google.com';
}

/**
 * Lists may arrive as real arrays or as a JSON string (a REG_SZ value holding
 * a JSON array). A non-JSON string is read as one entry per line.
 */
function toList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  const s = value.trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return s.split(/\r?\n/);
}

function toBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off'].includes(s)) return false;
  }
  return fallback;
}

/**
 * Parses a site entry: "example.com" (the domain and all its subdomains) or
 * "example.com/path" (URLs whose path starts with /path). Scheme, "www.",
 * port, query and fragment are ignored, and Google country domains are
 * folded onto .com. Returns { host, path } where path is '' when no path was
 * given, or null when the entry is unusable.
 */
function parseSiteEntry(entry) {
  if (typeof entry !== 'string') return null;
  let s = entry.trim().toLowerCase();
  if (!s || /\s/.test(s)) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\*?\.+/, '');
  const cut = s.search(/[?#]/);
  if (cut !== -1) s = s.slice(0, cut);
  const slash = s.indexOf('/');
  const hostPart = slash === -1 ? s : s.slice(0, slash);
  const pathPart = slash === -1 ? '' : s.slice(slash);
  let url;
  try {
    url = new URL('https://' + hostPart + (pathPart || '/'));
  } catch {
    return null;
  }
  const host = normalizeHost(url.hostname);
  if (!host || !HOST_RE.test(host)) return null;
  return { host: canonicalizeHost(host), path: pathPart ? url.pathname.toLowerCase() : '' };
}

// ─── Keyword folding ────────────────────────────────────────────────────────
// Keywords and the text they are checked against go through the same folding,
// so a disguised spelling ends up looking like the plain word:
//   - percent-decoding (twice); "+" becomes a space
//   - compatibility forms and accents: fullwidth, 𝐛𝐨𝐥𝐝, ⓒⓘⓡⓒⓛⓔⓓ, é -> e
//   - invisible characters (zero-width spaces and joiners, soft hyphens)
//   - letters from other alphabets that look Latin (Cyrillic о, Greek ο)
//   - leetspeak (p0rn, $ex), in a second version of the text
//   - anything that is not a letter or digit becomes a space
// On top of that, every keyword list tolerates stretched letters (brrowser,
// pooorn) and letters spelled out with spaces (b r o w s e r);
// keywordsSubstring also sees words glued across separators (gone-wild).
// keywordsFuzzy adds tolerance for typos (borwser, brwser, browsr).

const INVISIBLE_RE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;

// Lowercase look-alikes that survive NFKD, mapped to the Latin letter they
// imitate.
const LOOKALIKES = {
  // Cyrillic
  'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p',
  'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'һ': 'h',
  'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'ӏ': 'l', 'ь': 'b', 'п': 'n', 'г': 'r',
  // Greek
  'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k', 'μ': 'u', 'ν': 'v',
  'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'ω': 'w',
  // Latin letters that NFKD does not decompose
  'ı': 'i', 'ł': 'l', 'ø': 'o', 'đ': 'd', 'ħ': 'h', 'ŀ': 'l', 'ɡ': 'g',
  'ß': 'ss', 'æ': 'ae', 'œ': 'oe'
};
const LOOKALIKE_RE = new RegExp('[' + Object.keys(LOOKALIKES).join('') + ']', 'g');

// Applied only inside tokens that also contain a letter, so plain numbers
// (dates, ids, 1080) stay as they are.
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };

const ALNUM = '[\\p{L}\\p{N}]';
const NOT_ALNUM_RE = /[^\p{L}\p{N}]+/gu;

function decodeTwice(s) {
  try { s = decodeURIComponent(s); } catch {}
  try { s = decodeURIComponent(s); } catch {}
  return s;
}

/** Decoding, case, accents, invisible characters and look-alikes. */
function foldBase(s) {
  s = decodeTwice(String(s == null ? '' : s)).replace(/\+/g, ' ');
  return s.toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(INVISIBLE_RE, '')
    .replace(LOOKALIKE_RE, c => LOOKALIKES[c]);
}

function applyLeet(s) {
  return s.replace(/[\p{L}\p{N}@$]+/gu,
    tok => /\p{L}/u.test(tok) ? tok.replace(/[013457@$]/g, c => LEET[c]) : tok);
}

/** Letters and digits only, single spaces between words. */
function toWords(s) {
  return s.replace(NOT_ALNUM_RE, ' ').trim();
}

/** "b r o w s e r" -> "browser": runs of 3+ one-character words are joined. */
function joinSpelledOut(words) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= 3) out.push(run.join(''));
    else out.push(...run);
    run = [];
  };
  for (const t of words.split(' ')) {
    if ([...t].length === 1) run.push(t);
    else { flush(); out.push(t); }
  }
  flush();
  return out.join(' ');
}

/** The text without spaces, plus the offsets where each word starts. */
function compactWithStarts(words) {
  let text = '';
  const starts = new Set();
  for (const t of words.split(' ')) {
    if (!t) continue;
    starts.add(text.length);
    text += t;
  }
  return { text, starts };
}

/**
 * Prepares text once for every keyword check: plain and leetspeak versions,
 * each also with spelled-out letters joined, and their spaceless forms.
 */
function prepareText(raw) {
  const base = foldBase(raw);
  const plain = toWords(base);
  const leet = toWords(applyLeet(base));
  const variants = Array.from(new Set([plain, leet, joinSpelledOut(plain), joinSpelledOut(leet)]))
    .filter(Boolean);
  return { variants, compacts: variants.map(compactWithStarts) };
}

/** A keyword in folded form ('' when nothing usable is left). */
function foldKeyword(s) {
  return typeof s === 'string' ? toWords(applyLeet(foldBase(s.trim()))) : '';
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Each run of a letter may be stretched: "boobs" -> b+o{2,}b+s+. */
function stretchPattern(s) {
  const chars = [...s];
  let out = '';
  for (let i = 0; i < chars.length;) {
    let j = i;
    while (j < chars.length && chars[j] === chars[i]) j++;
    const n = j - i;
    out += chars[i] === ' ' ? ' ' : escapeRegExp(chars[i]) + (n === 1 ? '+' : `{${n},}`);
    i = j;
  }
  return out;
}

/** Collapses every run of a repeated character to one. */
function squeeze(s) {
  return s.replace(/(.)\1+/gu, '$1');
}

function compileKeyword(raw) {
  const keyword = foldKeyword(raw);
  if (!keyword) return null;
  const pattern = stretchPattern(keyword);
  return {
    keyword,
    word: new RegExp(`(?<!${ALNUM})${pattern}(?!${ALNUM})`, 'u'),   // whole word or phrase
    inner: new RegExp(pattern, 'u'),                                 // anywhere
    glued: new RegExp(stretchPattern(keyword.replace(/ /g, '')), 'gu')  // in spaceless text
  };
}

// Typo tolerance by keyword length (letters, without spaces). Short words get
// none: too many real words are one letter away from them.
function fuzzyBudget(length) {
  if (length >= 10) return 2;
  if (length >= 6) return 1;
  return 0;
}

function compileFuzzyKeyword(raw) {
  const keyword = foldKeyword(raw);
  if (!keyword) return null;
  const compact = keyword.replace(/ /g, '');
  return {
    keyword,
    words: keyword.split(' ').length,
    target: squeeze(compact),
    budget: fuzzyBudget([...compact].length)
  };
}

/**
 * True when a and b are at most `max` edits apart. Edits are insertions,
 * deletions, substitutions and swaps of two neighbouring letters.
 */
function withinEditDistance(a, b, max) {
  a = [...a];
  b = [...b];
  if (Math.abs(a.length - b.length) > max) return false;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return false;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length] <= max;
}

// ─── Keyword matching ───────────────────────────────────────────────────────
// Each returns the folded keyword that matched, or '' for no match.

/** Whole-word keywords (keywordsAnywhere, keywordsSearch, keywordsSoft). */
function matchWordKeywords(prepared, keywords) {
  for (const k of keywords) {
    for (const v of prepared.variants) {
      if (k.word.test(v)) return k.keyword;
    }
  }
  return '';
}

/**
 * Substring keywords: inside any word, or glued across word boundaries when
 * the match starts at the beginning of a word ("gone-wild" matches gonewild,
 * "winter course" does not match intercourse).
 */
function matchSubstringKeywords(prepared, keywords) {
  for (const k of keywords) {
    for (const v of prepared.variants) {
      if (k.inner.test(v)) return k.keyword;
    }
    for (const c of prepared.compacts) {
      k.glued.lastIndex = 0;
      let m;
      while ((m = k.glued.exec(c.text)) !== null) {
        if (c.starts.has(m.index)) return k.keyword;
        k.glued.lastIndex = m.index + 1;
      }
    }
  }
  return '';
}

/**
 * Typo-tolerant keywords (keywordsFuzzy). Compares each keyword with every
 * run of words of about the same word count, so split words ("brow ser") are
 * covered too. Candidates listed in fuzzyIgnoreWords never match.
 */
function matchFuzzyKeywords(prepared, keywords, ignore) {
  if (!keywords.length) return '';
  for (const v of prepared.variants) {
    const words = v.split(' ');
    for (const k of keywords) {
      for (let w = Math.max(1, k.words - 1); w <= k.words + 1; w++) {
        for (let i = 0; i + w <= words.length; i++) {
          const candidate = squeeze(words.slice(i, i + w).join(''));
          if (!candidate || ignore.has(candidate)) continue;
          if (withinEditDistance(candidate, k.target, k.budget)) return k.keyword;
        }
      }
    }
  }
  return '';
}

function parseListUrl(entry) {
  if (typeof entry !== 'string') return null;
  try {
    const u = new URL(entry.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

function addPathRule(map, host, path) {
  const prefixes = map.get(host);
  if (!prefixes) map.set(host, [path]);
  else if (!prefixes.includes(path)) prefixes.push(path);
}

/**
 * Normalises the raw contents of chrome.storage.managed. Always returns a
 * complete config object, including when raw is empty or malformed.
 */
function parseManagedConfig(raw) {
  raw = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const has = key => raw[key] !== undefined && raw[key] !== null;

  const cfg = {
    present: MANAGED_LIST_KEYS.concat(Object.keys(MANAGED_TOGGLE_DEFAULTS)).some(has),
    blockedDomains: new Set(),
    blockedPaths: new Map(),      // host -> [path prefixes]
    allowedHosts: new Set(),      // exact hostnames
    allowedPaths: new Map(),      // host -> [path prefixes]
    lockdownDomains: new Set(),
    lockdownPaths: new Map(),
    translationHosts: new Set(),
    keywordsAnywhere: [],         // compiled keywords, whole words
    keywordsSubstring: [],        // compiled keywords, substrings
    keywordsSearch: [],           // compiled keywords, whole words, search parameters only
    keywordsSoft: [],             // compiled keywords, whole words, search parameters only
    keywordsFuzzy: [],            // compiled fuzzy keywords, search parameters only
    fuzzyIgnoreWords: new Set(),  // folded, squeezed, spaceless
    blocklistUrls: [],
    archiveOrgTerms: [],
    counts: {},
    skipped: {}
  };
  for (const [key, fallback] of Object.entries(MANAGED_TOGGLE_DEFAULTS)) {
    cfg[key] = toBool(raw[key], fallback);
  }

  const skip = key => { cfg.skipped[key] = (cfg.skipped[key] || 0) + 1; };

  // Site lists: a bare domain covers its subdomains; host/path is a prefix.
  const parseSites = (key, domains, paths) => {
    for (const item of toList(raw[key])) {
      const e = parseSiteEntry(item);
      if (!e) { skip(key); continue; }
      if (!e.path || e.path === '/') domains.add(e.host);
      else addPathRule(paths, e.host, e.path);
    }
  };
  parseSites('blockedSites', cfg.blockedDomains, cfg.blockedPaths);
  parseSites('lockdownExtraSites', cfg.lockdownDomains, cfg.lockdownPaths);

  // Exceptions: exact hostnames, and host/path prefixes.
  for (const item of toList(raw.allowedSubdomains)) {
    const e = parseSiteEntry(item);
    if (!e || e.path) { skip('allowedSubdomains'); continue; }
    cfg.allowedHosts.add(e.host);
  }
  for (const item of toList(raw.allowedPaths)) {
    const e = parseSiteEntry(item);
    if (!e || !e.path) { skip('allowedPaths'); continue; }
    addPathRule(cfg.allowedPaths, e.host, e.path);
  }

  const translationSource = has('translationHosts') ? toList(raw.translationHosts) : DEFAULT_TRANSLATION_HOSTS;
  for (const item of translationSource) {
    const e = parseSiteEntry(item);
    if (!e || e.path) { skip('translationHosts'); continue; }
    cfg.translationHosts.add(e.host);
  }

  // Entries that fold to the same keyword are kept once.
  const parseKeywords = (key, compile) => {
    const byKeyword = new Map();
    for (const item of toList(raw[key])) {
      const k = compile(item);
      if (!k) { skip(key); continue; }
      if (!byKeyword.has(k.keyword)) byKeyword.set(k.keyword, k);
    }
    return Array.from(byKeyword.values());
  };
  cfg.keywordsAnywhere = parseKeywords('keywordsAnywhere', compileKeyword);
  cfg.keywordsSubstring = parseKeywords('keywordsSubstring', compileKeyword);
  cfg.keywordsSearch = parseKeywords('keywordsSearch', compileKeyword);
  cfg.keywordsSoft = parseKeywords('keywordsSoft', compileKeyword);
  cfg.keywordsFuzzy = parseKeywords('keywordsFuzzy', compileFuzzyKeyword);

  for (const item of toList(raw.fuzzyIgnoreWords)) {
    const w = foldKeyword(item);
    if (!w) { skip('fuzzyIgnoreWords'); continue; }
    cfg.fuzzyIgnoreWords.add(squeeze(w.replace(/ /g, '')));
  }

  const urls = new Set();
  for (const item of toList(raw.blocklistUrls)) {
    const u = parseListUrl(item);
    if (!u) { skip('blocklistUrls'); continue; }
    urls.add(u);
  }
  cfg.blocklistUrls = Array.from(urls);

  const terms = new Set();
  for (const item of toList(raw.archiveOrgTerms)) {
    const t = typeof item === 'string' ? item.trim().toLowerCase() : '';
    if (!t) { skip('archiveOrgTerms'); continue; }
    terms.add(t);
  }
  cfg.archiveOrgTerms = Array.from(terms);

  const pathRuleCount = map => Array.from(map.values()).reduce((n, list) => n + list.length, 0);
  cfg.counts = {
    blockedSites: cfg.blockedDomains.size + pathRuleCount(cfg.blockedPaths),
    allowedSubdomains: cfg.allowedHosts.size,
    allowedPaths: pathRuleCount(cfg.allowedPaths),
    keywordsAnywhere: cfg.keywordsAnywhere.length,
    keywordsSubstring: cfg.keywordsSubstring.length,
    keywordsSearch: cfg.keywordsSearch.length,
    keywordsSoft: cfg.keywordsSoft.length,
    keywordsFuzzy: cfg.keywordsFuzzy.length,
    fuzzyIgnoreWords: cfg.fuzzyIgnoreWords.size,
    blocklistUrls: cfg.blocklistUrls.length,
    lockdownExtraSites: cfg.lockdownDomains.size + pathRuleCount(cfg.lockdownPaths),
    translationHosts: cfg.translationHosts.size,
    archiveOrgTerms: cfg.archiveOrgTerms.length
  };
  return cfg;
}
