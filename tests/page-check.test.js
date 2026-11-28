// Page check (titles, descriptions, labels) and tag paths as searches.
'use strict';
const { SAMPLE_POLICY, loadBackground, checker } = require('./helpers');

const on = loadBackground({ ...SAMPLE_POLICY, pageCheck: true });
const off = loadBackground(SAMPLE_POLICY);
const t = checker();
const reason = (b, url) => b.run(`blockReason(${JSON.stringify(url)})`);
const title = (b, id, url, text) => b.run(`enforcePageTitle(${id}, ${JSON.stringify(url)}, ${JSON.stringify(text)})`);
const signals = (b, id, url, s, frameId = 0) => {
  const before = b.removed.length;
  b.run(`MESSAGE_HANDLERS.pageSignals({ signals: ${JSON.stringify(s)} }, { tab: { id: ${id}, url: ${JSON.stringify(url)} }, frameId: ${frameId} })`);
  return b.removed.length > before;
};

t.section('tag and explore paths count as searches');
t.expect('block /explore/sex', !!reason(on, 'https://photos.example/explore/sex'));
t.expect('block /tag/br0wser', !!reason(on, 'https://blog.example.com/tag/br0wser/'));
t.expect('block /hashtag/nsfw', !!reason(on, 'https://example.com/hashtag/nsfw'));
t.expect('block /search/new%20browser', !!reason(on, 'https://example.com/search/new%20browser'));
t.expect('allow /explore/paris', !reason(on, 'https://photos.example/explore/paris'));
t.expect('allow /questions/tagged/javascript', !reason(on, 'https://stackoverflow.com/questions/tagged/javascript'));
t.expect('allow /topics/photography', !reason(on, 'https://github.com/topics/photography'));
t.expect('allow /sexton/ (not a tag segment)', !reason(on, 'https://example.com/sexton/'));
t.expect('allow /tag with no term', !reason(on, 'https://example.com/blog/tag'));

t.section('tab title');
t.expect('close "Debbie Does Dallas - Wikidata"', title(on, 1, 'https://www.wikidata.org/wiki/Q579826', 'Debbie Does Dallas - Wikidata'));
t.expect('nothing with pageCheck off', !title(off, 1, 'https://www.wikidata.org/wiki/Q579826', 'Debbie Does Dallas - Wikidata'));
t.expect('close disguised "N.u.d.e photos"', title(on, 2, 'https://example.com/a', 'N.u.d.e photos'));
t.expect('allow an ordinary title', !title(on, 3, 'https://example.com/a', 'Weather forecast Brussels'));
t.expect('allowed path stays exempt', !title(on, 4, 'https://forum.example/r/allowed/x', 'NSFW thread'));
t.expect('non-web pages are ignored', !title(on, 5, 'vivaldi://history', 'nsfw'));
t.expect('allowed path stays exempt through an archive', !title(on, 6, 'https://web.archive.org/web/2024/https://forum.example/r/allowed/', 'nsfw'));

t.section('page signals from the content script');
t.expect('close on an adult label', signals(on, 10, 'https://example.com/', { adultLabel: true, texts: [] }));
t.expect('close on a description keyword', signals(on, 11, 'https://example.com/', { adultLabel: false, texts: ['Free hentai gallery'] }));
t.expect('allow an ordinary description', !signals(on, 12, 'https://example.com/', { adultLabel: false, texts: ['Recipes for every day'] }));
t.expect('close on an English version\'s title', signals(on, 16, 'https://it.wikipedia.org/wiki/Voce', { adultLabel: false, texts: ['Voce italiana', 'Hentai – inglese'] }));
t.expect('close on an English version\'s address', signals(on, 17, 'https://it.wikipedia.org/wiki/Voce', { adultLabel: false, texts: ['/wiki/Nude_photography'] }));
t.expect('allow an ordinary article in another language', !signals(on, 18, 'https://it.wikipedia.org/wiki/Roma', { adultLabel: false, texts: ['Rome – inglese', '/wiki/Rome', 'Rome – olandese', '/wiki/Rome', 'Capitali europee', 'Città d\'Italia'] }));
t.expect('ignore sub-frames', !signals(on, 13, 'https://example.com/', { adultLabel: true, texts: [] }, 2));
t.expect('ignore labels with pageCheck off', !signals(off, 14, 'https://example.com/', { adultLabel: true, texts: [] }));
t.expect('ignore labels on an allowed path', !signals(on, 15, 'https://forum.example/r/allowed/', { adultLabel: true, texts: [] }));

t.section('one block counts once toward lockdown');
const d = loadBackground({ ...SAMPLE_POLICY, pageCheck: true });
d.run(`enforcePageTitle(20, 'https://example.com/a', 'nsfw'); enforcePageTitle(20, 'https://example.com/a', 'nsfw again');`);
d.run(`MESSAGE_HANDLERS.pageSignals({ signals: { adultLabel: true, texts: [] } }, { tab: { id: 20, url: 'https://example.com/a' }, frameId: 0 })`);
const events = d.run('spiralEvents.length');
t.expect(`three triggers on one tab: ${events} spiral event, ${d.removed.length} close`, events === 1 && d.removed.length === 1);
t.expect('history is scrubbed for the closed page', d.scrubbed.includes('https://example.com/a'));

t.section('ordinary tag and search pages are untouched');
on.run('spiralEvents = []; lockdownExpiresAt = 0;');
for (const url of [
  'https://www.wikipedia.org/', 'https://nl.wikipedia.org/wiki/Brussel',
  'https://github.com/topics/javascript', 'https://stackoverflow.com/questions/tagged/python',
  'https://www.instagram.com/explore/tags/sunset/', 'https://www.youtube.com/hashtag/cooking',
  'https://www.etsy.com/search/home-and-living', 'https://medium.com/tag/programming',
  'https://www.flickr.com/search/?text=mountains', 'https://www.bol.com/nl/nl/s/?searchtext=fiets',
  'https://www.coolblue.be/nl/zoeken?query=laptop', 'https://www.nytimes.com/topic/subject/climate-change'
]) t.expect(`allow ${url}`, !reason(on, url));

t.finish();
