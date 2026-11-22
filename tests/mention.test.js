// mentionCheck: pages whose address names a blocked site.
'use strict';
const { SAMPLE_POLICY, loadBackground, checker } = require('./helpers');

const on = loadBackground({ ...SAMPLE_POLICY, mentionCheck: true });
const off = loadBackground(SAMPLE_POLICY);
on.run(`setRemoteDomains(new Set(['listed.example', 'other-listed.example']))`);
off.run(`setRemoteDomains(new Set(['listed.example']))`);
on.run(`setUserBlocklist(['mine.example'])`);
const t = checker();
const reason = (b, url) => b.run(`blockReason(${JSON.stringify(url)})`);

t.section('pages that name a blocked site');
for (const url of [
  'https://similar.example/similar/blocked.example/',
  'https://stats.example/website/listed.example/competitors',
  'https://compare.example/competitors/sub.listed.example',
  'https://market.example/domain_profile.cfm?d=other-listed.example',
  'https://downloader.example/?url=https%3A%2F%2Flisted.example%2Fwatch%2Fabc',
  'https://notes.example/page#ref=blocked.example',
  'https://similar.example/similar/mine.example',
  'https://similar.example/similar/WWW.Blocked.Example./'
]) t.expect(`close ${url}`, reason(on, url) === 'mentionCheck');

t.section('stays off unless the policy turns it on');
t.expect('toggle off: allowed', !reason(off, 'https://similar.example/similar/listed.example/'));

t.section('ordinary pages stay allowed');
for (const url of [
  'https://github.com/user/example.com-website',
  'https://docs.example.com/guide/index.html',
  'https://cdn.example.net/assets/app.min.js?v=1.2.3',
  'https://news.example/2026/11/article-about-example.org',
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://en.wikipedia.org/wiki/Example.com',
  'https://shop.example/search?q=listedexample',
  'https://mail.example/?to=someone@example.org'
]) t.expect(`allow ${url}`, !reason(on, url));

t.section('exceptions');
t.expect('a site naming itself is not a mention', !reason(on, 'https://listed-mirror.example/listed-mirror.example'));
t.expect('naming an allowed subdomain of a blocked site', !reason(on, 'https://login.example/?continue=https%3A%2F%2Fallowed.blocked.example%2F'));
t.expect('an allowed destination stays exempt', !reason(on, 'https://forum.example/r/allowed/blocked.example'));

t.finish();
