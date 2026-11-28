// Runs content.js in jsdom pages and checks what it reports for pageCheck.
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { EXT, checker } = require('./helpers');

const SRC = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');
const t = checker();

function runPage(html, settings, url = 'https://example.com/page') {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const sent = [];
  dom.window.chrome = {
    runtime: {
      id: 'test',
      lastError: undefined,
      sendMessage: (msg, cb) => {
        sent.push(msg);
        if (msg.action === 'getContentSettings' && cb) cb(settings);
        else if (cb) cb({});
      },
      onMessage: { addListener() {} }
    },
    storage: {
      sync: { get: (k, cb) => cb({}) },
      local: { get: (k, cb) => cb({}) },
      onChanged: { addListener() {} }
    }
  };
  dom.window.eval(SRC);
  return { dom, sent, signals: () => sent.filter((m) => m.action === 'pageSignals').map((m) => m.signals) };
}

const page = (head) => `<!doctype html><html><head><title>t</title>${head}</head><body><p>hi</p></body></html>`;
const ON = { pageCheck: true, archiveScan: false };

t.section('labels and descriptions');
let r = runPage(page('<meta name="RATING" content="RTA-5042-1996-1400-1577-RTA">'), ON);
t.expect('RTA label found', r.signals()[0] && r.signals()[0].adultLabel === true);

r = runPage(page('<meta http-equiv="PICS-Label" content=\'(pics-1.1 "http://www.rsac.org" l r (rta-5042-1996-1400-1577-rta))\'>'), ON);
t.expect('RTA label inside a PICS label found', r.signals()[0].adultLabel === true);

r = runPage(page('<meta name="rating" content="adult">'), ON);
t.expect('rating=adult found', r.signals()[0].adultLabel === true);

r = runPage(page('<meta name="rating" content="General">'), ON);
t.expect('rating=General is not a label', r.signals()[0].adultLabel === false);

r = runPage(page('<meta name="description" content="Daily news"><meta property="og:title" content="Story">' +
  '<meta name="twitter:description" content="More"><meta name="keywords" content="ignored">' +
  '<meta name="viewport" content="width=device-width">'), ON);
const s = r.signals()[0];
t.expect('description, og:title and twitter:description collected; keywords and viewport not',
  s.adultLabel === false && JSON.stringify(s.texts) === JSON.stringify(['Daily news', 'Story', 'More']));

t.section('other-language versions and categories');
const wikiPage = (body) => `<!doctype html><html lang="it"><head><title>Voce - Wikipedia</title></head><body>${body}</body></html>`;
r = runPage(wikiPage(`
  <ul>
    <li class="interlanguage-link"><a href="https://de.wikipedia.org/wiki/Beispiel" title="Beispiel – tedesco" lang="de" hreflang="de">Deutsch</a></li>
    <li class="interlanguage-link"><a href="https://en.wikipedia.org/wiki/Example_topic" title="Example topic – inglese" lang="en" hreflang="en">English</a></li>
    <li class="interlanguage-link"><a href="https://nl.wikipedia.org/wiki/Voorbeeld_onderwerp" title="Voorbeeld onderwerp – olandese" lang="nl" hreflang="nl">Nederlands</a></li>
    <li class="interlanguage-link"><a href="https://fr.wikipedia.org/wiki/Exemple" title="Exemple – francese" lang="fr" hreflang="fr">Français</a></li>
  </ul>
  <div id="catlinks"><ul><li><a href="/wiki/Categoria:Uno">Categoria uno</a></li><li><a href="/wiki/Categoria:Due">Categoria due</a></li></ul></div>
`), ON, 'https://it.wikipedia.org/wiki/Voce');
let texts = r.signals()[0].texts;
t.expect('English and Dutch titles collected', texts.includes('Example topic – inglese') && texts.includes('Voorbeeld onderwerp – olandese'));
t.expect('their addresses collected', texts.includes('/wiki/Example_topic') && texts.includes('/wiki/Voorbeeld_onderwerp'));
t.expect('other languages skipped', !texts.some((x) => /Beispiel|Exemple/.test(x)));
t.expect('categories collected', texts.includes('Categoria uno') && texts.includes('Categoria due'));

r = runPage(wikiPage(`<a href="/en/" hreflang="en-GB" title="English (UK)">EN</a>` +
  Array.from({ length: 40 }, (_, i) => `<a href="https://en.example/p${i}" hreflang="en" title="T${i}">x</a>`).join('')),
  ON, 'https://example.com/nl/');
texts = r.signals()[0].texts;
t.expect('regional codes like en-GB count as English', texts.includes('English (UK)'));
t.expect(`version links capped (${texts.length} texts)`, texts.length <= 40);

r = runPage(wikiPage(`<a href="/wiki/Voce" hreflang="en" title="Same page">EN</a>`), ON, 'https://it.wikipedia.org/wiki/Voce');
t.expect('a link to the page itself adds only its title', JSON.stringify(r.signals()[0].texts) === JSON.stringify(['Same page']));

t.section('when it runs');
r = runPage(page('<meta name="description" content="x">'), { pageCheck: false, archiveScan: false });
t.expect('nothing reported with pageCheck off', r.signals().length === 0);

r = runPage(page(''), ON, 'file:///C:/notes.html');
t.expect('no settings request on non-web pages', r.sent.length === 0);

r = runPage(page('<meta name="description" content="Home">'), ON);
r.dom.window.document.querySelector('meta[name=description]').setAttribute('content', 'Changed later');
setTimeout(() => {
  const all = r.signals();
  t.expect(`a changed description is reported again (${all.length} reports)`,
    all.length === 2 && all[1].texts[0] === 'Changed later');
  r.dom.window.document.head.appendChild(r.dom.window.document.createElement('link'));
  setTimeout(() => {
    t.expect('no repeat report when nothing changed', r.signals().length === 2);
    t.finish();
  }, 700);
}, 700);
