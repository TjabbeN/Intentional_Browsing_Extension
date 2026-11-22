# Intentional Browsing Extension

A Manifest V3 extension for Chromium browsers (Chrome, Edge, Vivaldi, Brave)
that adds friction to sites you visit on autopilot and blocks sites you have
decided to stay away from. Block lists and protection settings are supplied by
an administrator through enterprise policy, so they can't be switched off in a
weak moment. Your own day-to-day settings stay in the popup.

## Features

**Mindful delays (popup, add-only).** For each site you add, a full-page
overlay counts down before the page can be used. Then a circle has to be held
down for three seconds; letting go early starts it over.
- The countdown and the hold only count time while the tab is visible and its
  window has focus. Holding Space or Enter works like holding the mouse.
- Every completed visit adds a few seconds to the next delay. Delays go back
  to their starting value once a day.
- An optional grace period skips the overlay for a while after a visit.
- Optional time charging adds delay in proportion to the time the site
  actually spends in the foreground.
- You can set the overlay's background colour (five presets or any custom
  colour) or a full-screen image, kept at your screen's resolution. Over an
  image, the panel behind the text is see-through by an amount you choose.
- Sites added here can't be removed from the popup.

**Blocking (managed).** Tabs whose URL matches a blocked site are closed.
- A domain covers all of its subdomains. A `host/path` entry covers that path
  prefix.
- Matching ignores `www.`, case and a trailing dot.
- Google country domains are folded onto `google.com`, so one entry covers
  google.be, google.co.uk and the rest.
- Exceptions (allowed subdomains and paths) are checked first and are exempt
  from keyword rules.
- Remote domain lists (plain text or hosts-file format, hundreds of thousands
  of domains) are downloaded daily and cached locally.
- Keyword rules can match anywhere in the URL, as substrings, or only inside
  search queries. On translation sites they also cover the text being
  translated.
- Keywords see through disguised spellings: accents, fullwidth and styled
  letters, invisible characters, look-alike letters from other alphabets,
  leetspeak, stretched letters and letters spelled out with spaces.
  Substring keywords also match words glued across separators. Optional
  fuzzy keywords also tolerate typos.
- Pages shown through a wrapper are also checked as the page they show. This
  covers the Wayback Machine, archive.today and its mirrors, the Google cache,
  Google Translate and its website proxies, Google redirect links and
  `view-source:`.

**Block a site (popup, add-only).** You can add a domain to your own block
list at any time. It applies immediately and can't be removed from the popup.

**Soft triggers.** Selected search terms show a reflection overlay with a
maths or typing puzzle instead of closing the tab.

**Spiral lockdown.** Several blocks in quick succession (tab closes, wrong
puzzle answers) start a 30-minute lockdown. During lockdown soft triggers
close the tab, and extra lockdown-only sites are blocked too. Lockdown is
silent: nothing shows when it starts or how long it lasts.

**Optional protections (managed).**
- Close incognito tabs.
- Replace the extensions page with a locked page.
- Remove blocked pages from history.
- Close flagged archive.org items.
- Check pages by their adult-content labels, tab title and description.
- Close pages whose address names a blocked site.

When no managed configuration is present, only the delay sites and the sites
added in the popup are active. The popup then shows "No managed configuration
found".

## Managed settings

All keys are optional. Arrays are lists of strings. Entries are trimmed and
lowercased, and malformed entries are skipped without breaking the rest. An
array may also be delivered as a JSON string, e.g. `"[\"example.com\"]"`.
Changes apply immediately, without a browser restart.

| Key | Type | Meaning | Example |
|---|---|---|---|
| `blockedSites` | array | Domains (with subdomains) or `host/path` prefixes to close. | `["example.com", "example.org/path"]` |
| `allowedSubdomains` | array | Exact hostnames that stay allowed under a blocked parent. Deeper subdomains are not included. | `["docs.example.com"]` |
| `allowedPaths` | array | `host/path` prefixes that stay allowed on a blocked domain (subdomains of the host included). | `["example.com/help"]` |
| `keywordsAnywhere` | array | Whole words or phrases anywhere in the URL. Anything that is not a letter or digit counts as a space. | `["examplekeyword", "example phrase"]` |
| `keywordsSubstring` | array | Plain substrings anywhere in the URL, also inside longer words. | `["examplesubstring"]` |
| `keywordsSearch` | array | Whole words or phrases inside search parameters (`q`, `query`, `search`, `search_query`, `p`, `wd`, `text`, `s`, `term`, `keyword`, `k`, `kw`, `oq`) and in the path segment after `/search/`, `/explore/`, `/tag/` and similar. | `["example search"]` |
| `keywordsSoft` | array | Like `keywordsSearch`, but shows the puzzle overlay instead of closing the tab (closes during lockdown). | `["example soft"]` |
| `keywordsFuzzy` | array | Like `keywordsSearch`, but typos are tolerated too: none up to 5 letters, 1 for 6–9 letters, 2 from 10 letters (spaces not counted). Split words count as typos too. | `["examplekeyword"]` |
| `fuzzyIgnoreWords` | array | Real words that `keywordsFuzzy` must never match because they are a typo away from a keyword. | `["exampleword"]` |
| `blocklistUrls` | array | URLs of plain-text domain lists. `#` and `!` start comments; `0.0.0.0 host` lines and `*.` prefixes are understood. | `["https://lists.example.com/domains.txt"]` |
| `lockdownExtraSites` | array | Same format as `blockedSites`, blocked only during lockdown. | `["search.example.com"]` |
| `translationHosts` | array | Hosts where `keywordsSearch` also scans the URL fragment and every parameter. Unset means the built-in list of common translation sites. | `["translate.example.com"]` |
| `archiveOrgTerms` | array | With `archiveOrgCheck`: substrings looked for in an archive.org item's title, subject, description, collection, creator and keywords. | `["exampleterm"]` |
| `closeIncognitoTabs` | boolean | Close incognito tabs. The extension must be allowed in incognito. Default `false`. | `true` |
| `blockExtensionsPage` | boolean | Replace the extensions page with a locked page. Default `false`. | `true` |
| `scrubHistory` | boolean | Delete closed pages from history. Default `true`. | `true` |
| `archiveOrgCheck` | boolean | Close archive.org items that are flagged in their metadata (noindex, darkened, or an `archiveOrgTerms` match) or that show a content warning. Default `false`. | `true` |
| `pageCheck` | boolean | Close pages that carry an adult-content label, or whose tab title or description matches `keywordsAnywhere` or `keywordsSubstring`. Default `false`. | `true` |
| `mentionCheck` | boolean | Close pages whose address names a blocked site in its path, query or fragment (lists of similar sites, site statistics, domain marketplaces, downloaders). Checked against all block lists; explicitly allowed destinations are exempt. Default `false`. | `true` |

**Order of checks.** For a tab URL, and for every page it wraps, innermost
first, the extension checks these in turn:

1. Exceptions, then `blockedSites`.
2. Sites added in the popup.
3. Remote lists.
4. Keyword rules. These are skipped for explicitly allowed destinations, also
   when viewed through a wrapper.
5. During lockdown only: `lockdownExtraSites` and `keywordsSoft`.

With `pageCheck` on, a page that passes these checks is also checked by what
it says about itself:

- An adult-content label in the page code (the RTA label, or a `rating` meta
  tag such as `adult` or `mature`) closes the tab.
- The tab title and the page description (`description`, Open Graph and
  Twitter title and description tags) are matched against `keywordsAnywhere`
  and `keywordsSubstring`, the same way a URL is. Titles are checked again
  when they change, and the description when a single-page app rewrites it.
- Explicitly allowed destinations are exempt.

Search-parameter keyword rules also apply to the path segment after a
search-like segment (`search`, `explore`, `discover`, `tag`, `tags`, `tagged`,
`hashtag`, `hashtags`, `topic`, `topics`): `/explore/<term>` and
`/tag/<term>` are searches under another name.

**How keywords are matched.** Keywords and URLs are folded the same way
before comparison: percent-decoded, lowercased, accents and invisible
characters removed, fullwidth and styled letters turned into plain ones,
look-alike Cyrillic and Greek letters mapped to Latin, and everything that is
not a letter or digit turned into a space. Leetspeak (`0`→o, `1`→i, `3`→e,
`4`/`@`→a, `5`/`$`→s, `7`→t) is applied in a second version of the text, and
only to words that also contain a letter. On top of that:

- Any letter may be repeated: `browser` also matches `brrowser`, and `boobs`
  matches `booobs` but not `bobs`.
- Three or more single letters in a row are read as one word: `b r o w s e r`.
- `keywordsSubstring` also matches across separators when the match starts at
  the beginning of a word: `gone-wild` matches `gonewild`, `winter course`
  does not match `intercourse`.
- `keywordsFuzzy` compares each keyword with every run of words of about the
  same word count, so split words (`brow ser`) and typos (`borwser`, `brwser`)
  match. Short keywords get no typo tolerance because too many real words are
  one letter away from them.

Exceptions override `blockedSites` and keyword rules. They don't override
remote lists or sites added in the popup.

A wrapper that is itself listed in `blockedSites` stays blocked for every page
it shows. Leave a wrapper out of the list to allow it for pages that aren't
blocked.

### Windows registry (Vivaldi, Chrome, Edge)

Extension policy lives under the browser's policy root:

```
HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Vivaldi\3rdparty\extensions\<EXTENSION-ID>\policy
HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\3rdparty\extensions\<EXTENSION-ID>\policy
HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Microsoft\Edge\3rdparty\extensions\<EXTENSION-ID>\policy
```

- Toggles are `REG_DWORD` values (1 or 0).
- A list is a subkey named after the key. Its `REG_SZ` values are named `1`,
  `2`, `3` and so on, with no gaps, because reading stops at the first missing
  number. Alternatively a list can be one `REG_SZ` value holding a JSON array.
- Value names are case-sensitive: `blockedSites`, not `blockedsites`.

`config/config.template.reg` has every key with placeholder values. Copy it
outside the repository, replace `<EXTENSION-ID>` and the example values, then
import it as an administrator (`reg import my-config.reg`). Its first line
deletes the previous configuration, so removed entries don't linger. Afterwards, `vivaldi://policy` (or
`chrome://policy`) lists the values in the extension's section.

To install the extension so it can't be removed, force-install it with the
`ExtensionSettings` policy. For example, under
`HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Vivaldi\ExtensionSettings\<EXTENSION-ID>`:

```
"installation_mode"="force_installed"
"update_url"="https://clients2.google.com/service/update2/crx"
```

On Windows machines that aren't domain-joined, Chromium only force-installs
extensions that come from the Chrome Web Store.

On macOS and Linux, extension policy uses the same keys in the platform's
policy format (a configuration profile or a JSON policy file with a
`3rdparty.extensions.<EXTENSION-ID>` section).

## Permissions

Wording suitable for the Chrome Web Store privacy form:

- **`tabs`**: Reads the URL of each tab as it navigates, so it can be compared
  with the block lists and delay sites. Closes blocked tabs, and replaces the
  extensions page when that protection is on.
- **`storage`**: Keeps the user's delay sites, sites added in the popup,
  overlay appearance and timers (`storage.sync` / `storage.local`). Reads the
  administrator's configuration from `storage.managed`.
- **`unlimitedStorage`**: The downloaded domain lists are cached locally so
  they don't have to be fetched on every browser start. A typical list set is
  close to 10 MB, the default local storage quota.
- **`scripting`**: Injects the extension's own content script (the delay
  overlay) into tabs that were already open when the extension was installed
  or updated. Declared content scripts don't run in those tabs. No remote or
  dynamically generated code is ever injected.
- **`history`**: Removes the URL of a blocked page from browsing history
  (`history.deleteUrl`), so the address bar doesn't suggest it again. History
  is never read.
- **`alarms`**: A once-a-minute alarm records time spent on timed delay sites
  and triggers the daily refresh of the domain lists.
- **`<all_urls>` (host permission)**: The delay overlay must work on any site
  the user chooses, which can't be known in advance, and the page check reads
  page titles, descriptions and labels when the administrator enables it. It
  is also used to download the administrator's list URLs and, when enabled,
  archive.org's public item metadata.

The extension contains no remote code: no `eval`, no `new Function`, and
nothing downloaded is ever executed. The remote lists are plain-text data.

## Privacy policy

Intentional Browsing does not collect, sell or transmit personal data.

- All processing happens in the browser. Tab URLs are compared with local
  lists and are never sent anywhere.
- Only when the administrator enables `pageCheck`: the tab title, the page's
  description tags and its adult-content labels are read and compared with
  the same local lists. They are not stored and never leave the browser.
- An overlay background image you choose is stored in the browser's local
  extension storage only.
- Settings and timers are stored in the browser's extension storage. Settings
  in `storage.sync` travel with the user's own browser sync account, if sync
  is on.
- The only network requests are:
  1. Downloads of the list URLs configured by the administrator
     (`blocklistUrls`), at most once a day plus manual refreshes, sent without
     cookies.
  2. Only when the administrator enables `archiveOrgCheck`: a request to
     archive.org's public metadata API for the archive.org item being opened.
     That site is already being visited, so it receives no information it
     doesn't already get.
- There are no analytics, no telemetry and no third-party services.

## Development

```
extension/    the extension itself: exactly what goes into the Web Store zip
tests/        tests that run the extension code in Node with a stubbed chrome API
tools/        build script and the fuzzy-keyword dictionary check
config/       policy template with placeholder values
```

Requires Node 18 or later.

```
npm install          # once
npm test             # keyword matching, page check and content-script tests
npm run build        # tests, then dist/intentional-browsing-<version>.zip
npm run check:fuzzy  # dictionary words that fuzzy keywords would catch
```

The build uses `extension/` only, checks that every file the manifest names
exists, and refuses to run if a `.reg` file is inside `extension/`.

Personal policy files (`*.reg`) are ignored by git; only the template is part
of the repository. To try changes in the browser, load `extension/` as an
unpacked extension. The unpacked build has its own extension ID, so its
policy goes under that ID.

## License

GPL-3.0. See [LICENSE](LICENSE).
