// Intentional Browsing: background service worker (Manifest V3).
//
// Where settings come from
//   chrome.storage.managed  Block lists, exceptions, keywords, remote list URLs
//                           and feature toggles, set by an administrator via
//                           enterprise policy (parsed in managed-config.js).
//   chrome.storage.sync     Sites added from the popup (add-only), delay sites,
//                           and overlay appearance.
//   chrome.storage.local    Cached remote lists, overlay image, grace periods,
//                           focused-time and lockdown state.
//
// Tabs are checked by URL as they navigate (tabs.onUpdated) and closed when
// they match. Lookups use Sets with a parent-domain walk, so remote lists with
// hundreds of thousands of domains stay cheap. declarativeNetRequest is
// deliberately not used: its rule limits are far below those list sizes.

'use strict';

importScripts('managed-config.js');

const DEBUG = false;
function debug(...args) {
  if (DEBUG) console.log('[IntentionalBrowsing]', ...args);
}

/** Runs fn once startup has finished (see `ready` at the end of this file). */
function afterReady(fn) {
  ready.then(fn).catch(e => debug('Handler failed:', e));
}

// ─── State ──────────────────────────────────────────────────────────────────
// MV3 service workers stop when idle and start again on the next event, so
// everything below is reloaded from storage on each start (see `ready` at the
// end of this file). Event handlers wait for that before acting.
let config = parseManagedConfig({});
let userBlockedDomains = new Set();
let remoteDomains = new Set();
let remoteListMeta = null;

// ─── URL helpers ────────────────────────────────────────────────────────────
function tryParseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Normalised hostname of a URL string, or '' when it has none. */
function urlHost(url) {
  const u = tryParseUrl(url);
  return u ? normalizeHost(u.hostname) : '';
}

/** Yields a host and each parent domain: a.b.c -> a.b.c, b.c, c */
function* domainChain(host) {
  let h = host;
  while (h) {
    yield h;
    const dot = h.indexOf('.');
    if (dot === -1) return;
    h = h.slice(dot + 1);
  }
}

/** True when the host, or any parent domain of it, is in the set. */
function hostInSet(host, set) {
  if (!host || set.size === 0) return false;
  for (const h of domainChain(host)) {
    if (set.has(h)) return true;
  }
  return false;
}

/** True when a path-prefix rule for the host (or a parent domain) matches. */
function pathRuleMatches(host, pathname, rules) {
  if (!host || rules.size === 0) return false;
  const path = pathname.toLowerCase();
  for (const h of domainChain(host)) {
    const prefixes = rules.get(h);
    if (prefixes && prefixes.some(p => path.startsWith(p))) return true;
  }
  return false;
}

// ─── Managed configuration ──────────────────────────────────────────────────
async function loadManagedConfig() {
  let raw = {};
  try {
    raw = (await chrome.storage.managed.get(null)) || {};
  } catch {
    // No policy for this extension, or no managed storage on this platform.
    raw = {};
  }
  const previous = config;
  config = parseManagedConfig(raw);
  debug('Managed config', config.present ? config.counts : '(none)');
  return previous;
}

/** Applies a policy change without a restart. */
async function onManagedConfigChanged() {
  const previous = await loadManagedConfig();
  if (previous.blocklistUrls.join('\n') !== config.blocklistUrls.join('\n')) {
    refreshRemoteLists();
  }
  if (config.closeIncognitoTabs && !previous.closeIncognitoTabs) {
    closeAllIncognitoTabs();
  }
}

// ─── Managed block list and exceptions ──────────────────────────────────────
/** Hostname used for managed-list matching: normalised, Google folded. */
function managedHost(u) {
  return canonicalizeHost(normalizeHost(u.hostname));
}

/**
 * True for an explicitly allowed destination (allowedSubdomains or
 * allowedPaths). These are deliberate exceptions: they win over blockedSites
 * and are exempt from keyword heuristics.
 */
function isExplicitlyAllowed(url) {
  const u = tryParseUrl(url);
  if (!u) return false;
  const host = managedHost(u);
  return config.allowedHosts.has(host) || pathRuleMatches(host, u.pathname, config.allowedPaths);
}

function isManagedBlocked(url) {
  const u = tryParseUrl(url);
  if (!u) return false;
  const host = managedHost(u);
  if (!host) return false;
  // Exceptions are checked before blocks.
  if (config.allowedHosts.has(host) || pathRuleMatches(host, u.pathname, config.allowedPaths)) {
    return false;
  }
  return hostInSet(host, config.blockedDomains) ||
         pathRuleMatches(host, u.pathname, config.blockedPaths);
}

function isLockdownExtraBlocked(url) {
  const u = tryParseUrl(url);
  if (!u) return false;
  const host = managedHost(u);
  return hostInSet(host, config.lockdownDomains) ||
         pathRuleMatches(host, u.pathname, config.lockdownPaths);
}

// ─── Keyword triggers ───────────────────────────────────────────────────────
// keywordsAnywhere  whole words matched anywhere in the URL
// keywordsSubstring plain substrings matched anywhere in the URL
// keywordsSearch    whole words matched only inside search query parameters
// keywordsSoft      like keywordsSearch, but shows the puzzle overlay instead
//                   of closing the tab (closes it during lockdown)
// keywordsFuzzy     like keywordsSearch, but also tolerates typos
// Folding and matching (look-alike letters, leetspeak, stretched letters,
// typos) live in managed-config.js.
const SEARCH_QUERY_PARAMS = ['q', 'query', 'search', 'search_query', 'p', 'wd', 'text', 's', 'term', 'keyword', 'k', 'kw', 'oq'];

// Tag, topic and explore pages are searches under another name
// (/explore/<term>, /tag/<term>): the path segment after one of these is
// treated like a search parameter.
const SEARCH_PATH_SEGMENTS = new Set([
  'search', 'explore', 'discover', 'tag', 'tags', 'tagged', 'hashtag', 'hashtags', 'topic', 'topics'
]);

function isTranslationHost(hostname) {
  return hostInSet(canonicalizeHost(normalizeHost(hostname)), config.translationHosts);
}

/** The path segments that follow a search-like segment ("/explore/<term>"). */
function searchPathTerms(pathname) {
  const segments = pathname.split('/').filter(Boolean);
  const terms = [];
  for (let i = 0; i + 1 < segments.length; i++) {
    let s = segments[i];
    try { s = decodeURIComponent(s); } catch {}
    if (SEARCH_PATH_SEGMENTS.has(s.toLowerCase())) terms.push(segments[i + 1]);
  }
  return terms;
}

/**
 * Search-parameter values and search-like path segments; on translation sites
 * also the fragment and every parameter.
 */
function searchTexts(u, includeTranslation) {
  const texts = [];
  for (const param of SEARCH_QUERY_PARAMS) {
    const v = u.searchParams.get(param);
    if (v) texts.push(v);
  }
  texts.push(...searchPathTerms(u.pathname));
  if (includeTranslation && isTranslationHost(u.hostname)) {
    if (u.hash) texts.push(u.hash);
    for (const [, v] of u.searchParams) {
      if (v) texts.push(v);
    }
  }
  return texts;
}

/** The keyword that makes this URL blocked, or ''. */
function keywordTrigger(url) {
  const { keywordsAnywhere, keywordsSubstring, keywordsSearch, keywordsFuzzy } = config;
  if (!keywordsAnywhere.length && !keywordsSubstring.length &&
      !keywordsSearch.length && !keywordsFuzzy.length) return '';

  const u = tryParseUrl(url);
  if (!u) {
    const text = prepareText(String(url));
    return matchWordKeywords(text, keywordsAnywhere) || matchSubstringKeywords(text, keywordsSubstring);
  }
  if (isExplicitlyAllowed(url)) return '';

  const full = prepareText(u.hostname + ' ' + u.pathname + ' ' + u.search + ' ' + u.hash);
  const hit = matchWordKeywords(full, keywordsAnywhere) || matchSubstringKeywords(full, keywordsSubstring);
  if (hit) return hit;
  if (!keywordsSearch.length && !keywordsFuzzy.length) return '';

  for (const raw of searchTexts(u, true)) {
    const text = prepareText(raw);
    const found = matchWordKeywords(text, keywordsSearch) ||
                  matchFuzzyKeywords(text, keywordsFuzzy, config.fuzzyIgnoreWords);
    if (found) return found;
  }
  return '';
}

function containsKeywordTrigger(url) {
  const hit = keywordTrigger(url);
  if (hit) debug('Keyword match:', hit);
  return !!hit;
}

function containsSoftTrigger(url) {
  if (!config.keywordsSoft.length) return false;
  const u = tryParseUrl(url);
  if (!u) return false;
  return searchTexts(u, false).some(raw => matchWordKeywords(prepareText(raw), config.keywordsSoft));
}

// ─── Remote block lists ─────────────────────────────────────────────────────
// Plain-text domain lists (one domain per line, or hosts-file format) fetched
// from the managed blocklistUrls. This is data only; nothing fetched is ever
// executed. The merged list is cached in chrome.storage.local and refreshed
// once a day.
const REMOTE_LIST_MAX_DOMAINS = 1000000;           // memory guard
const REMOTE_LIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REMOTE_LIST_RETRY_MS = 30 * 60 * 1000;       // after a failed refresh
const REMOTE_DOMAIN_RE = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/;

let remoteRefreshInFlight = null;

/** Adds the domains in a list file to `into`. */
function parseDomainList(text, into, limit) {
  let added = 0;
  for (const rawLine of text.split('\n')) {
    if (into.size >= limit) return { added, truncated: true };
    let line = rawLine.trim().toLowerCase();
    if (!line || line[0] === '#' || line[0] === '!' || line.startsWith('//')) continue;
    const comment = line.indexOf('#');
    if (comment !== -1) line = line.slice(0, comment).trim();
    // Hosts-file format: "0.0.0.0 example.com"
    const parts = line.split(/\s+/);
    let domain = parts.length > 1 ? parts[1] : parts[0];
    domain = domain.replace(/^\*\./, '').replace(/^www\./, '');
    if (domain.startsWith('-') || !REMOTE_DOMAIN_RE.test(domain)) continue;
    if (!into.has(domain)) {
      into.add(domain);
      added++;
    }
  }
  return { added, truncated: false };
}

async function loadRemoteListMeta() {
  const r = await chrome.storage.local.get(['remoteListMeta']);
  remoteListMeta = r.remoteListMeta || null;
}

// The domain Set is built from the cache only when a tab URL has to be
// checked. The worker also wakes for alarms and focus changes, which don't
// need it, and rebuilding several hundred thousand entries is not free.
let remoteDomainsLoad = null;
let remoteDomainsGeneration = 0;

function ensureRemoteDomains() {
  if (!remoteDomainsLoad) {
    const generation = remoteDomainsGeneration;
    remoteDomainsLoad = chrome.storage.local.get(['remoteList'])
      .then((r) => {
        if (generation !== remoteDomainsGeneration) return;   // a refresh got there first
        remoteDomains = typeof r.remoteList === 'string' && r.remoteList
          ? new Set(r.remoteList.split('\n'))
          : new Set();
      })
      .catch(() => {});
  }
  return remoteDomainsLoad;
}

function setRemoteDomains(domains) {
  remoteDomainsGeneration++;
  remoteDomains = domains;
  remoteDomainsLoad = Promise.resolve();
}

function remoteDomainCount() {
  return (remoteListMeta && remoteListMeta.count) || 0;
}

async function clearRemoteListCache() {
  setRemoteDomains(new Set());
  remoteListMeta = null;
  await chrome.storage.local.remove(['remoteList', 'remoteListMeta']);
}

function sameList(a, b) {
  return (a || []).join('\n') === (b || []).join('\n');
}

function remoteListNeedsRefresh(now = Date.now()) {
  const urls = config.blocklistUrls;
  if (!urls.length) return remoteListMeta !== null || remoteDomains.size > 0;
  const meta = remoteListMeta;
  if (!meta) return true;
  const attempted = Date.parse(meta.lastAttempt || '') || 0;
  if (sameList(meta.attemptUrls, urls) && now - attempted < REMOTE_LIST_RETRY_MS) return false;
  if (!sameList(meta.urls, urls)) return true;
  const updated = Date.parse(meta.updated || '') || 0;
  return now - updated >= REMOTE_LIST_MAX_AGE_MS;
}

function scheduleRemoteListRefresh() {
  if (remoteListNeedsRefresh()) refreshRemoteLists();
}

/** Downloads every configured list and replaces the cache. Never rejects. */
function refreshRemoteLists() {
  if (remoteRefreshInFlight) return remoteRefreshInFlight;
  remoteRefreshInFlight = downloadRemoteLists()
    .catch((e) => {
      console.warn('[IntentionalBrowsing] Block list refresh failed:', e);
      return { success: false, count: remoteDomainCount() };
    })
    .finally(() => {
      remoteRefreshInFlight = null;
    });
  return remoteRefreshInFlight;
}

async function downloadRemoteLists() {
  const urls = config.blocklistUrls.slice();
  if (!urls.length) {
    await clearRemoteListCache();
    return { success: true, count: 0 };
  }

  const domains = new Set();
  const sources = [];
  let truncated = false;
  for (const url of urls) {
    if (truncated) {
      sources.push({ url, ok: false, error: 'skipped, domain limit reached' });
      continue;
    }
    try {
      const resp = await fetch(url, { cache: 'no-store', credentials: 'omit' });
      if (!resp.ok) {
        sources.push({ url, ok: false, error: 'HTTP ' + resp.status });
        continue;
      }
      const result = parseDomainList(await resp.text(), domains, REMOTE_LIST_MAX_DOMAINS);
      sources.push({ url, ok: true, added: result.added });
      truncated = result.truncated;
    } catch (e) {
      sources.push({ url, ok: false, error: String((e && e.message) || e) });
    }
  }
  for (const s of sources) {
    if (!s.ok) console.warn('[IntentionalBrowsing] Block list not loaded:', s.url, s.error);
  }
  if (truncated) {
    console.warn(`[IntentionalBrowsing] Block lists truncated at ${REMOTE_LIST_MAX_DOMAINS} domains.`);
  }

  const now = new Date().toISOString();
  if (domains.size === 0) {
    // Nothing usable arrived (offline?): keep the previous cache.
    remoteListMeta = { ...(remoteListMeta || {}), lastAttempt: now, attemptUrls: urls, sources };
    await chrome.storage.local.set({ remoteListMeta });
    return { success: false, count: remoteDomainCount() };
  }

  setRemoteDomains(domains);
  remoteListMeta = {
    updated: now, lastAttempt: now, urls, attemptUrls: urls,
    sources, count: domains.size, truncated
  };
  try {
    await chrome.storage.local.set({ remoteList: Array.from(domains).join('\n'), remoteListMeta });
  } catch (e) {
    console.warn('[IntentionalBrowsing] Could not cache block lists:', e);
  }
  return { success: true, count: domains.size };
}

function isRemoteBlocked(url) {
  return hostInSet(urlHost(url), remoteDomains);
}

// ─── Pages about a blocked site (mentionCheck) ──────────────────────────────
// Pages that exist to lead to a site often name it in their own URL: lists of
// similar sites, site statistics, domain marketplaces, downloaders. With
// mentionCheck on, every domain named in a URL's path, query or fragment is
// checked against the same block lists as the URL itself.
const EMBEDDED_DOMAIN_RE = /(?:^|[^a-z0-9.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?=$|[^a-z0-9-])/g;

/** Domains named in the path, query and fragment of a parsed URL. */
function embeddedDomains(u) {
  const texts = u.pathname.split('/').filter(Boolean);
  for (const [, v] of u.searchParams) if (v) texts.push(v);
  if (u.hash.length > 1) texts.push(u.hash.slice(1));
  const found = new Set();
  for (let text of texts) {
    try { text = decodeURIComponent(text); } catch {}
    for (const m of text.toLowerCase().matchAll(EMBEDDED_DOMAIN_RE)) {
      found.add(normalizeHost(m[1]));
    }
  }
  return found;
}

/** The blocked domain a URL names, or '' when it names none. */
function blockedMention(url) {
  if (!config.mentionCheck) return '';
  const u = tryParseUrl(url);
  if (!u || !/^https?:$/.test(u.protocol)) return '';
  const own = normalizeHost(u.hostname);
  for (const domain of embeddedDomains(u)) {
    // A site naming itself or its own subdomains is not a mention.
    if (domain === own || own.endsWith('.' + domain) || domain.endsWith('.' + own)) continue;
    const target = 'https://' + domain + '/';
    if (isManagedBlocked(target) || isUserBlocked(target) || isRemoteBlocked(target)) return domain;
  }
  return '';
}

// ─── Sites added from the popup (add-only) ──────────────────────────────────
// Stored in chrome.storage.sync under `userBlockedSites`. Each entry blocks the
// domain and all its subdomains. The popup can only add entries.

/**
 * Normalises user input into a bare hostname:
 * "https://www.Example.com/some/path?x=1" -> "example.com". '' if unusable.
 */
function normalizeBlockEntry(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');  // scheme
  s = s.split('/')[0].split('?')[0].split('#')[0];
  s = s.split('@').pop();                          // userinfo
  s = s.split(':')[0];                             // port
  s = s.replace(/^www\./, '').replace(/\.+$/, '');
  if (!s || !s.includes('.') || /\s/.test(s)) return '';
  if (!/^[a-z0-9.-]+$/.test(s)) return '';
  return s;
}

function setUserBlocklist(list) {
  userBlockedDomains = new Set((Array.isArray(list) ? list : []).map(normalizeBlockEntry).filter(Boolean));
}

async function loadUserBlocklist() {
  const r = await chrome.storage.sync.get(['userBlockedSites']);
  setUserBlocklist(r.userBlockedSites);
}

function isUserBlocked(url) {
  return hostInSet(urlHost(url), userBlockedDomains);
}

async function addUserBlockedSite(site) {
  const domain = normalizeBlockEntry(site);
  if (!domain) return { success: false, reason: 'invalid' };
  const r = await chrome.storage.sync.get(['userBlockedSites']);
  const list = Array.isArray(r.userBlockedSites) ? r.userBlockedSites : [];
  const already = list.includes(domain);
  if (!already) list.push(domain);
  try {
    await chrome.storage.sync.set({ userBlockedSites: list });
  } catch {
    return { success: false, reason: 'storage', count: list.length };
  }
  setUserBlocklist(list);
  return { success: true, domain, already, count: list.length };
}

// ─── Wrapper unwrapping ─────────────────────────────────────────────────────
// Archives, caches, translation proxies and view-source show another page
// under their own URL. The wrapped page is checked as well as the wrapper, so
// a blocked site cannot be reached through one.
const WRAPPER_PREFIXES = ['view-source:', 'blob:', 'filesystem:'];
const WAYBACK_HOSTS = new Set(['web.archive.org', 'wayback.archive.org']);
const ARCHIVE_TODAY_HOSTS = ['archive.today', 'archive.ph', 'archive.is', 'archive.li', 'archive.fo', 'archive.md', 'archive.vn'];
const CACHED_VIEW_HOSTS = new Set(['cachedview.nl', 'cachedview.com', 'freezepage.com']);
const TRANSLATE_PROXY_SUFFIX = '.translate.goog';
const MAX_UNWRAP_DEPTH = 4;

/**
 * Turns a URL embedded in a wrapper ("example.com/x", "https:/example.com",
 * "example.com*") into an absolute URL, or null when it is not one.
 */
function toTargetUrl(value) {
  if (!value) return null;
  let t = String(value).trim();
  if (/^https?%3a/i.test(t)) {
    try { t = decodeURIComponent(t); } catch {}
  }
  t = t.replace(/\*+$/, '')                        // Wayback prefix search: example.com*
       .replace(/^(https?):\/*/i, '$1://');         // collapsed slashes: https:/example.com
  if (!/^https?:\/\//i.test(t)) t = 'https://' + t;
  t = t.replace(/^(https?:\/\/)\*\./i, '$1');       // wildcard host: *.example.com
  const u = tryParseUrl(t);
  return u && u.hostname ? u.href : null;
}

/** The URL a wrapper URL shows, or null when `url` is not a recognised wrapper. */
function unwrapOnce(url) {
  for (const prefix of WRAPPER_PREFIXES) {
    if (url.startsWith(prefix)) return url.slice(prefix.length);
  }
  const u = tryParseUrl(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  const rest = u.pathname + u.search + u.hash;

  // Wayback Machine: /web/[<timestamp or *>[modifier_]/]<url>, /save/<url>, ?url=
  if (WAYBACK_HOSTS.has(host)) {
    const m = rest.match(/^\/web\/(?:[0-9*]+(?:[a-z]{2}_)?\/)?(.+)$/i) ||
              rest.match(/^\/save\/(?:_embed\/)?(.+)$/i);
    return toTargetUrl(m ? m[1] : u.searchParams.get('url'));
  }

  // archive.today family: /<url>, /newest/<url>, /<timestamp>/<url>, ?url=, /<domain>
  if (ARCHIVE_TODAY_HOSTS.some(h => host === h || host.endsWith('.' + h))) {
    const m = rest.match(/\/(https?:\/.+)$/i);
    if (m) return toTargetUrl(m[1]);
    const q = u.searchParams.get('url') || u.searchParams.get('u');
    if (q) return toTargetUrl(q);
    const d = u.pathname.match(/^\/((?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/.*)?)$/i);
    return d ? toTargetUrl(d[1]) : null;
  }

  // Google web cache: ?q=cache:<url> or ?q=cache:<id>:<url>
  if (host === 'webcache.googleusercontent.com') {
    const m = (u.searchParams.get('q') || '').match(/^cache:(?:[a-z0-9_-]+:(?!\/\/))?(.+)$/i);
    return m ? toTargetUrl(m[1]) : null;
  }

  // Google Translate: ?u=<url>
  const canonical = canonicalizeHost(normalizeHost(host));
  if (canonical === 'translate.google.com' || host === 'translate.googleusercontent.com') {
    return toTargetUrl(u.searchParams.get('u'));
  }

  // <label>.translate.goog: dots in the original host become "-", hyphens "--".
  if (host.endsWith(TRANSLATE_PROXY_SUFFIX)) {
    const label = host.slice(0, -TRANSLATE_PROXY_SUFFIX.length);
    const original = label.split('--').map(part => part.replace(/-/g, '.')).join('-');
    return toTargetUrl(u.protocol + '//' + original + rest);
  }

  // Cached-view services: ?q= / ?url= / ?u=
  if (CACHED_VIEW_HOSTS.has(host)) {
    return toTargetUrl(u.searchParams.get('q') || u.searchParams.get('url') || u.searchParams.get('u'));
  }

  // Google redirect and image-result pages that embed their destination.
  if (canonical === 'google.com' && (u.pathname === '/url' || u.pathname === '/imgres')) {
    const t = u.searchParams.get('url') || u.searchParams.get('q') || u.searchParams.get('imgurl');
    if (t && /^https?:\/\//i.test(t)) return toTargetUrl(t);
  }
  return null;
}

/** [raw, ..., innermost]: the URL and every URL it wraps. */
function unwrapChain(rawUrl) {
  const chain = [rawUrl];
  for (let i = 0; i < MAX_UNWRAP_DEPTH; i++) {
    const next = unwrapOnce(chain[chain.length - 1]);
    if (!next || chain.includes(next)) break;
    chain.push(next);
  }
  return chain;
}

// ─── Spiral detection and lockdown ──────────────────────────────────────────
// Blocks that come in a rapid burst (tab closes, wrong puzzle answers) engage
// a 30-minute lockdown. During lockdown soft triggers close the tab instead
// of showing a puzzle, and lockdownExtraSites are closed as well. Lockdown is
// silent: nothing shows when it starts or how long it lasts.
const SPIRAL_WINDOW_MS = 10 * 60 * 1000;
const SPIRAL_THRESHOLD = 3.0;
const LOCKDOWN_DURATION_MS = 30 * 60 * 1000;
const POINTS_HARD_CLOSE = 1.0;
const POINTS_WRONG_PUZZLE = 0.5;

let spiralEvents = [];      // [{ t: ms epoch, p: points }]
let lockdownExpiresAt = 0;  // ms epoch; 0 = inactive

async function loadSpiralState() {
  const r = await chrome.storage.local.get(['spiralEvents', 'lockdownExpiresAt']);
  const now = Date.now();
  spiralEvents = (r.spiralEvents || []).filter(e => now - e.t < SPIRAL_WINDOW_MS);
  lockdownExpiresAt = r.lockdownExpiresAt || 0;
}

function saveSpiralState() {
  chrome.storage.local.set({ spiralEvents, lockdownExpiresAt }).catch(() => {});
}

function isLockdownActive() {
  return Date.now() < lockdownExpiresAt;
}

function recordSpiralEvent(points) {
  // Blocks during lockdown don't count, so lockdown cannot extend itself.
  if (isLockdownActive()) return;
  const now = Date.now();
  spiralEvents = spiralEvents.filter(e => now - e.t < SPIRAL_WINDOW_MS);
  spiralEvents.push({ t: now, p: points });
  const total = spiralEvents.reduce((s, e) => s + e.p, 0);
  if (total >= SPIRAL_THRESHOLD) {
    lockdownExpiresAt = now + LOCKDOWN_DURATION_MS;
    spiralEvents = [];
    debug('Lockdown until', new Date(lockdownExpiresAt).toISOString());
  }
  saveSpiralState();
}

// ─── Blocking ───────────────────────────────────────────────────────────────
/**
 * Why a tab URL must be closed, or '' when it may load. The URL and every
 * page it wraps are checked, innermost first. An explicitly allowed
 * destination stays exempt from keyword heuristics when viewed through a
 * wrapper, just as it is when opened directly.
 */
function blockReason(rawUrl) {
  const chain = unwrapChain(rawUrl).reverse();
  const targetAllowed = isExplicitlyAllowed(chain[0]);
  const lockdown = isLockdownActive();
  for (const u of chain) {
    if (isManagedBlocked(u)) return 'blockedSites';
    if (isUserBlocked(u)) return 'userBlockedSites';
    if (isRemoteBlocked(u)) return 'blocklistUrls';
    if (!targetAllowed && containsKeywordTrigger(u)) return 'keyword';
    if (!targetAllowed && blockedMention(u)) return 'mentionCheck';
    if (lockdown) {
      if (isLockdownExtraBlocked(u)) return 'lockdownExtraSites';
      if (containsSoftTrigger(u)) return 'keywordsSoft (lockdown)';
    }
  }
  return '';
}

function removeTab(tabId) {
  chrome.tabs.remove(tabId).catch(() => {});
}

/**
 * Closes a tab and, with scrubHistory on, removes its URL from history so the
 * blocked page is not offered again by the address bar.
 */
function closeAndScrub(tabId, url) {
  if (config.scrubHistory && typeof url === 'string' && /^https?:\/\//i.test(url)) {
    chrome.history.deleteUrl({ url }).catch(() => {});
  }
  removeTab(tabId);
}

// Tabs already being closed for a block. Several events can arrive for one
// tab before it is gone (URL, title, page signals); the block counts once.
const closingTabs = new Set();

/** Closes a tab for a block: counts it toward lockdown once and scrubs history. */
function closeBlockedTab(tabId, url, reason) {
  if (closingTabs.has(tabId)) return;
  closingTabs.add(tabId);
  debug('Closing tab', tabId, 'reason:', reason);
  recordSpiralEvent(POINTS_HARD_CLOSE);
  closeAndScrub(tabId, url);
}

/** Closes the tab if its URL is blocked. Returns true when it was closed. */
function enforceBlocksOnTab(tabId, rawUrl) {
  if (!rawUrl) return false;
  const reason = blockReason(rawUrl);
  if (!reason) return false;
  closeBlockedTab(tabId, rawUrl, reason);
  return true;
}

// ─── Page check (pageCheck) ─────────────────────────────────────────────────
// Besides the URL, two things a page says about itself are checked:
//   - adult-content labels sites put in their own page code (reported by
//     the content script); these close the tab on their own
//   - the tab title and the page description, matched against
//     keywordsAnywhere and keywordsSubstring like a URL is
// Explicitly allowed destinations are exempt, as they are from keywords.

/** True when the page check applies to this tab URL. */
function pageCheckApplies(url) {
  if (!config.pageCheck || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
  const chain = unwrapChain(url);
  return !isExplicitlyAllowed(chain[chain.length - 1]);
}

/** The keyword found in a page's title or description texts, or ''. */
function pageTextTrigger(texts) {
  const { keywordsAnywhere, keywordsSubstring } = config;
  for (const t of texts) {
    if (typeof t !== 'string' || !t.trim()) continue;
    const text = prepareText(t.slice(0, 2000));
    const hit = matchWordKeywords(text, keywordsAnywhere) || matchSubstringKeywords(text, keywordsSubstring);
    if (hit) return hit;
  }
  return '';
}

/** Checks a tab's title. Returns true when the tab was closed. */
function enforcePageTitle(tabId, url, title) {
  if (!title || !pageCheckApplies(url)) return false;
  const hit = pageTextTrigger([title]);
  if (!hit) return false;
  closeBlockedTab(tabId, url, 'page title: ' + hit);
  return true;
}

/** Checks what the content script found in the page head. */
function enforcePageSignals(tab, signals) {
  if (!tab || !signals || !pageCheckApplies(tab.url)) return;
  if (signals.adultLabel) {
    closeBlockedTab(tab.id, tab.url, 'adult-content label');
    return;
  }
  const hit = pageTextTrigger(Array.isArray(signals.texts) ? signals.texts : []);
  if (hit) closeBlockedTab(tab.id, tab.url, 'page description: ' + hit);
}

// ─── archive.org flagged-item check (archiveOrgCheck) ───────────────────────
// archive.org shows a "content may be inappropriate" notice on flagged items
// and has no account setting to hide them. For item pages (/details/<id>) the
// public metadata API is consulted; the content script also scans the page
// for the notice itself.
const archiveCheckedTabs = new Map();   // tabId -> last URL checked

function archiveMetadataText(m) {
  const parts = [];
  for (const f of [m.subject, m.title, m.description, m.collection, m.creator, m.keywords]) {
    if (Array.isArray(f)) parts.push(f.join(' '));
    else if (typeof f === 'string') parts.push(f);
  }
  return parts.join(' ').toLowerCase();
}

function isArchiveItemFlagged(meta) {
  const m = meta && meta.metadata;
  if (!m) return false;
  if (String(m.noindex).toLowerCase() === 'true') return true;
  if (typeof m.curation === 'string' && /\bdark\b/i.test(m.curation)) return true;
  if (!config.archiveOrgTerms.length) return false;
  const text = archiveMetadataText(m);
  return config.archiveOrgTerms.some(t => text.includes(t));
}

async function checkArchiveItem(tabId, url) {
  if (!config.archiveOrgCheck) return;
  const u = tryParseUrl(url);
  if (!u || (u.hostname !== 'archive.org' && !u.hostname.endsWith('.archive.org'))) return;
  const m = u.pathname.match(/^\/details\/([^/?#]+)/);
  if (!m || isExplicitlyAllowed(url)) return;
  if (archiveCheckedTabs.get(tabId) === url) return;
  archiveCheckedTabs.set(tabId, url);
  try {
    let id = m[1];
    try { id = decodeURIComponent(id); } catch {}
    const resp = await fetch(`https://archive.org/metadata/${encodeURIComponent(id)}`, { credentials: 'omit' });
    if (!resp.ok) return;
    if (isArchiveItemFlagged(await resp.json())) {
      debug('archive.org item flagged, closing tab', tabId);
      recordSpiralEvent(POINTS_HARD_CLOSE);
      closeAndScrub(tabId, url);
    }
  } catch {
    // Network or parse errors are non-fatal; the content-script scan remains.
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  archiveCheckedTabs.delete(tabId);
  closingTabs.delete(tabId);
});

// ─── Delay sites and focused-time charging ──────────────────────────────────
// Delay sites (chrome.storage.sync `websites`) show a countdown overlay. Each
// visit adds delayIncrement seconds to the next wait. Sites with
// minutesPerIncrement > 0 also add delay in proportion to focused time: only
// time where a tab of the site is the active tab of a focused window counts,
// several tabs of one site count once, and background or audio-only tabs are
// free. Time is banked incrementally so it survives service-worker restarts.
const SITE_TIME_ALARM = 'siteTimeFlush';
const SITE_TIME_FLUSH_MIN = 1;
// One accounting slice is capped so sleep or a stalled alarm is not counted.
const SITE_TIME_MAX_SLICE_MS = 3 * 60 * 1000;
const SOFT_TRIGGER_DELAY_S = 15;
const SOFT_TRIGGER_MESSAGE = 'Pause. What are you actually looking for right now?';

async function getDelaySites() {
  const r = await chrome.storage.sync.get(['websites']);
  return Array.isArray(r.websites) ? r.websites : [];
}

/** The delay site whose host (www-insensitive, exact) matches the URL. */
function matchDelaySite(url, websites) {
  const tabHost = urlHost(url);
  if (!tabHost) return null;
  for (const site of websites) {
    if (!site || typeof site.url !== 'string') continue;
    const s = /^https?:\/\//i.test(site.url) ? site.url : 'https://' + site.url;
    if (urlHost(s) === tabHost) return site;
  }
  return null;
}

/** Converts banked seconds into delay increments; remainders carry over. */
async function chargeAccruedTime(carry) {
  const websites = await getDelaySites();
  let changed = false;
  for (const site of websites) {
    const minutes = Number(site.minutesPerIncrement) || 0;
    if (minutes <= 0) continue;
    const unitSeconds = minutes * 60;
    const secs = carry[site.url] || 0;
    if (secs < unitSeconds) continue;
    const units = Math.floor(secs / unitSeconds);
    carry[site.url] = secs - units * unitSeconds;
    site.delay = (Number(site.delay) || 0) + units * (Number(site.delayIncrement) || 0);
    changed = true;
  }
  if (changed) await chrome.storage.sync.set({ websites });
  return carry;
}

/** Banks time since the last flush, then starts timing `nextUrl` (or nothing). */
async function flushSiteTime(nextUrl) {
  const now = Date.now();
  const st = await chrome.storage.local.get(['siteTimeActive', 'siteTimeCarry']);
  const active = st.siteTimeActive || null;
  const carry = st.siteTimeCarry || {};
  if (active && active.url && active.since) {
    const elapsed = now - active.since;
    if (elapsed > 0) {
      carry[active.url] = (carry[active.url] || 0) + Math.min(elapsed, SITE_TIME_MAX_SLICE_MS) / 1000;
    }
  }
  const updatedCarry = await chargeAccruedTime(carry);
  await chrome.storage.local.set({
    siteTimeActive: nextUrl ? { url: nextUrl, since: now } : null,
    siteTimeCarry: updatedCarry
  });
}

async function recomputeFocusedSite() {
  let focusedUrl = null;
  try {
    const win = await chrome.windows.getLastFocused({ populate: false });
    if (win && win.focused && !win.incognito) {
      const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
      if (tab && tab.url) {
        const site = matchDelaySite(tab.url, await getDelaySites());
        if (site && (Number(site.minutesPerIncrement) || 0) > 0) focusedUrl = site.url;
      }
    }
  } catch {
    // The window or tab went away mid-query: treat as nothing focused.
  }
  await flushSiteTime(focusedUrl);
}

/** Resets every delay site to its initial delay once per day. */
async function checkForDailyReset() {
  const r = await chrome.storage.sync.get(['websites', 'lastResetDate']);
  const currentDate = new Date().toISOString().split('T')[0];
  if (r.lastResetDate === currentDate) return;
  const websites = Array.isArray(r.websites) ? r.websites : [];
  const resetWebsites = websites.map(site => {
    const initialDelay = site.initialDelay !== undefined ? site.initialDelay : site.delay;
    return { ...site, initialDelay, delay: initialDelay };
  });
  await chrome.storage.sync.set({ websites: resetWebsites, lastResetDate: currentDate });
  // Drop part-charged time so yesterday's leftovers don't carry over.
  await chrome.storage.local.set({ siteTimeCarry: {} });
}

/** Makes sure content.js is running in the tab, then calls back. */
function ensureContentScriptThen(tabId, callback) {
  chrome.tabs.sendMessage(tabId, { action: 'ping' }, () => {
    if (!chrome.runtime.lastError) {
      callback();
      return;
    }
    // Tabs opened before the extension was installed have no content script.
    chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }, () => {
      if (chrome.runtime.lastError) return;   // e.g. a browser-internal page
      setTimeout(callback, 500);
    });
  });
}

function sendInterceptMessage(tabId, site, customization) {
  chrome.tabs.sendMessage(tabId, { action: 'interceptWebsite', site, customization }, () => {
    void chrome.runtime.lastError;
  });
}

/** Shows the delay overlay on delay sites and the puzzle on soft triggers. */
async function showOverlayIfNeeded(tabId, url) {
  const r = await chrome.storage.sync.get(['websites', 'customization']);
  const websites = Array.isArray(r.websites) ? r.websites : [];
  const site = matchDelaySite(url, websites);
  const softTrigger = !site && containsSoftTrigger(url);
  if (!site && !softTrigger) return;

  // The background image lives in storage.local: a data URL is far larger
  // than sync's per-item quota.
  const customization = { ...(r.customization || {}) };
  const { bgImage } = await chrome.storage.local.get(['bgImage']);
  if (bgImage) customization.backgroundImage = bgImage;

  if (site) {
    ensureContentScriptThen(tabId, () => sendInterceptMessage(tabId, site, customization));
    return;
  }
  const reflectSite = { url, delay: SOFT_TRIGGER_DELAY_S, gracePeriod: 0 };
  const softCustomization = { ...customization, softReflect: true, reflectionMessage: SOFT_TRIGGER_MESSAGE };
  ensureContentScriptThen(tabId, () => sendInterceptMessage(tabId, reflectSite, softCustomization));
}

// ─── Incognito and extensions page ──────────────────────────────────────────
const EXTENSIONS_PAGE_PREFIXES = [
  'chrome://extensions', 'vivaldi://extensions', 'edge://extensions',
  'brave://extensions', 'opera://extensions', 'about:addons'
];

function isExtensionsPage(url) {
  return EXTENSIONS_PAGE_PREFIXES.some(p => url.startsWith(p));
}

async function closeAllIncognitoTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.incognito) removeTab(tab.id);
    }
  } catch {}
}

// ─── Tab events ─────────────────────────────────────────────────────────────
async function handleTabUpdated(tabId, changeInfo, tab) {
  if (tab.incognito && config.closeIncognitoTabs) {
    removeTab(tabId);
    return;
  }
  // Titles arrive separately from URL changes, and change again in
  // single-page apps.
  if (changeInfo.title && enforcePageTitle(tabId, tab.url, changeInfo.title)) return;
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  await ensureRemoteDomains();

  // Check as soon as the URL is known, before the page finishes loading.
  if (changeInfo.url) {
    if (enforceBlocksOnTab(tabId, changeInfo.url)) return;
    checkArchiveItem(tabId, changeInfo.url);
    // Navigating the active tab can move it on or off a timed site.
    if (tab.active) recomputeFocusedSite().catch(() => {});
  }

  if (changeInfo.status !== 'complete' || !tab.url) return;

  if (config.blockExtensionsPage && isExtensionsPage(tab.url)) {
    chrome.tabs.update(tabId, { url: chrome.runtime.getURL('extension-block.html') }).catch(() => {});
    return;
  }

  if (enforceBlocksOnTab(tabId, tab.url)) return;
  if (enforcePageTitle(tabId, tab.url, tab.title)) return;
  checkArchiveItem(tabId, tab.url);
  checkForDailyReset().catch(() => {});

  if (tab.url.startsWith('chrome-extension://') || tab.url === 'about:blank') return;
  showOverlayIfNeeded(tabId, tab.url).catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  afterReady(() => handleTabUpdated(tabId, changeInfo, tab));
});

chrome.tabs.onCreated.addListener((tab) => {
  afterReady(() => {
    if (tab.incognito && config.closeIncognitoTabs) removeTab(tab.id);
  });
});

chrome.tabs.onActivated.addListener(() => afterReady(recomputeFocusedSite));
chrome.windows.onFocusChanged.addListener(() => afterReady(recomputeFocusedSite));
chrome.tabs.onRemoved.addListener(() => afterReady(recomputeFocusedSite));

// ─── Storage changes ────────────────────────────────────────────────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'managed') {
    afterReady(onManagedConfigChanged);
  } else if (area === 'sync' && changes.userBlockedSites) {
    // Additions from the popup take effect immediately.
    setUserBlocklist(changes.userBlockedSites.newValue);
  }
});

// ─── Messages ───────────────────────────────────────────────────────────────
function managedStatus() {
  const toggles = {};
  for (const key of Object.keys(MANAGED_TOGGLE_DEFAULTS)) toggles[key] = config[key];
  return { present: config.present, counts: config.counts, skipped: config.skipped, toggles };
}

const MESSAGE_HANDLERS = {
  refreshBlocklist: () => refreshRemoteLists(),

  getBlocklistStatus: () => ({
    configured: config.blocklistUrls.length,
    count: remoteDomainCount(),
    lastUpdated: (remoteListMeta && remoteListMeta.updated) || null,
    failed: ((remoteListMeta && remoteListMeta.sources) || []).filter(s => !s.ok).length,
    truncated: !!(remoteListMeta && remoteListMeta.truncated)
  }),

  getManagedStatus: () => managedStatus(),

  // Asked by the content script on archive.org item pages.
  getContentSettings: (request, sender) => ({
    archiveScan: config.archiveOrgCheck && !isExplicitlyAllowed(sender.url || ''),
    pageCheck: !!(sender.tab && pageCheckApplies(sender.tab.url))
  }),

  // Sent by the content script in the top frame when pageCheck is on.
  pageSignals: (request, sender) => {
    if (sender.tab && sender.frameId === 0) enforcePageSignals(sender.tab, request.signals);
    return {};
  },

  spiralEvent: (request) => {
    if (request.kind === 'wrongPuzzle') recordSpiralEvent(POINTS_WRONG_PUZZLE);
    return {};
  },

  addUserBlockedSite: (request) => addUserBlockedSite(request.site),

  getUserBlockedCount: () => ({ count: userBlockedDomains.size }),

  closeTab: (request, sender) => {
    const tab = sender.tab;
    if (!tab) return {};
    if (request.scrub) {
      // Block-initiated (archive.org page scan): scrub and count it.
      recordSpiralEvent(POINTS_HARD_CLOSE);
      closeAndScrub(tab.id, tab.url);
    } else {
      // The overlay's close button: history stays as it is.
      removeTab(tab.id);
    }
    return {};
  }
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const handler = request && MESSAGE_HANDLERS[request.action];
  if (!handler) return false;
  ready
    .then(() => handler(request, sender))
    .then(sendResponse, () => sendResponse({ success: false, reason: 'error' }));
  return true;
});

// ─── Lifecycle ──────────────────────────────────────────────────────────────
chrome.runtime.onStartup.addListener(() => afterReady(checkForDailyReset));

chrome.runtime.onInstalled.addListener(() => {
  afterReady(() => {
    if (config.closeIncognitoTabs) return closeAllIncognitoTabs();
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm || alarm.name !== SITE_TIME_ALARM) return;
  afterReady(() => {
    scheduleRemoteListRefresh();
    return recomputeFocusedSite();
  });
});

// Creating an alarm that already exists would restart its period.
chrome.alarms.get(SITE_TIME_ALARM).then((alarm) => {
  if (!alarm) chrome.alarms.create(SITE_TIME_ALARM, { periodInMinutes: SITE_TIME_FLUSH_MIN });
});

// ─── Startup ────────────────────────────────────────────────────────────────
// Never rejects: a failed step leaves that part empty rather than wedging
// every event handler.
const ready = Promise.all([
  loadManagedConfig(),
  loadUserBlocklist(),
  loadSpiralState(),
  loadRemoteListMeta()
].map(step => step.catch(e => console.warn('[IntentionalBrowsing] Startup step failed:', e))))
  .then(() => {
    scheduleRemoteListRefresh();
  });
