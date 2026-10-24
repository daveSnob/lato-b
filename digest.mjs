// Lato B: digest musicale da feed RSS + r/indieheads [FRESH].
// Uso: node digest.mjs  -> scrive lato-b.html (pagina completa) e artifact.html (frammento per Claude Artifact)
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(await readFile(join(DIR, 'config.json'), 'utf8'));
const blowup = JSON.parse(await readFile(join(DIR, 'blowup.json'), 'utf8'));
const NOW = Date.now();
const H = 3600e3;
const UA = 'Mozilla/5.0 (LatoB RSS digest)';

// ---------- fetch ----------
async function get(url, retry = true) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' }, signal: ctl.signal });
    if (r.status === 429 && retry) {
      // rispetta il limite: aspetta quanto chiede il server (max 60 s) e riprova una volta
      const wait = Math.min(60, Number(r.headers.get('x-ratelimit-reset') || r.headers.get('retry-after')) || 30);
      clearTimeout(t);
      await new Promise(res => setTimeout(res, (wait + 2) * 1000));
      return get(url, false);
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

// ---------- parsing ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', eacute: 'é', egrave: 'è', agrave: 'à', ograve: 'ò', ugrave: 'ù', igrave: 'ì', laquo: '«', raquo: '»' };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e.toLowerCase()] ?? m;
  });
}
const cdata = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? cdata(m[1]).trim() : '';
}
const text = html => decode(decode(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function parseFeed(xml) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map(b => {
    let link = tag(b, 'link');
    if (!link) { const m = b.match(/<link[^>]*href="([^"]+)"/i); link = m ? m[1] : ''; }
    const cats = [...b.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)].map(m => text(cdata(m[1])))
      .concat([...b.matchAll(/<category[^>]*term="([^"]+)"/gi)].map(m => decode(m[1])));
    const date = tag(b, 'pubDate') || tag(b, 'dc:date') || tag(b, 'published') || tag(b, 'updated');
    const rawDesc = tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded') || tag(b, 'content');
    const pathDate = b.match(/\/(20\d\d)\/(\d\d)\/(\d\d)\//); // feed senza date (The Wire): data dal percorso immagini
    const ts = Date.parse(date) || (pathDate ? Date.parse(`${pathDate[1]}-${pathDate[2]}-${pathDate[3]}T12:00:00Z`) : 0);
    return { title: text(tag(b, 'title')), link: decode(link.trim()), cats, ts, rawDesc };
  });
}

function excerpt(raw, title) {
  let s = text(raw)
    .replace(/The post .* appeared first on .*$/i, '')
    .replace(/L['’]articolo .* proviene da .*$/i, '')
    .replace(/Continue reading.*$/i, '').replace(/\[…\]|\[\.\.\.\]/g, '…').trim();
  if (!s || s === title) return '';
  if (s.length > 230) s = s.slice(0, 230).replace(/\s+\S*$/, '') + '…';
  return s;
}

// ---------- filtri ----------
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const genreRe = new RegExp(`(^|[^\\p{L}])(${cfg.blockGenres.map(esc).join('|')})([^\\p{L}]|$)`, 'iu');
const artistRe = new RegExp(`(^|[^\\p{L}])(${cfg.blockArtists.map(esc).join('|')})([^\\p{L}]|$)`, 'u');
const blocked = it => genreRe.test(it.title + ' | ' + it.cats.join(' | ')) || artistRe.test(it.title);

// ---------- classificazione ----------
const RE = {
  dischi: /\b(reviews?|recension[ei]|chroniques?|album of the week|albums|disques?|reviewed|disco della settimana|best new music)\b/i,
  brani: /\b(ascolta|guarda|anteprima|premiere|video|clip|vidéos?|track|tracks|song|songs|single|singolo|brano|listen|watch|shares|new music|morceau|titre inédit)\b/i,
  notizie: /\b(news|notizie|brevi|infos?|announces?|annuncia|tour|reissue|ristampa|festival|dies|morto|morta|lineup)\b/i,
};
function classify(it, feed) {
  const cats = it.cats.join(' | ');
  const linkHint = /\/(reviews?|recensioni|chroniques?)\//i.test(it.link);
  const songTitle = /^track:|\b(new (song|single|track|video)|shares?|nuovo singolo|nuovo brano|ascolta|guarda il video|premiere|anteprima|unveils?)\b/i.test(it.title);
  if (feed.kind === 'dischi' || feed.kind === 'brani') return feed.kind;
  if (feed.kind === 'approfondimenti') return 'approfondimenti';
  if (feed.kind === 'notizie') return songTitle ? 'brani' : 'notizie';
  if (RE.dischi.test(cats) || linkHint || /\breview\b/i.test(it.title)) return 'dischi';
  if (RE.brani.test(cats) || songTitle) return 'brani';
  if (RE.notizie.test(cats)) return 'notizie';
  if (feed.name === 'OndaRock' && / - /.test(it.title)) return 'dischi'; // "Artista - Titolo" = recensione
  if (RE.notizie.test(it.title)) return 'notizie';
  return 'approfondimenti';
}

// ---------- raccolta ----------
// archivio delle recensioni (45 giorni) per "Più recensiti": i feed mostrano solo le ultime
const ARCHIVE = join(DIR, 'reviews-db.json');
const ARCHIVE_DAYS = 45;
let archive = {};
try { archive = JSON.parse(await readFile(ARCHIVE, 'utf8')); } catch {}

const status = [];
const seen = new Set();
const items = [];
await Promise.all(cfg.feeds.map(async feed => {
  try {
    const parsed = parseFeed(await get(feed.url));
    let n = 0;
    for (const it of parsed) {
      if (!it.title || !it.link || seen.has(it.link)) { if (process.env.DEBUG === feed.name) console.error('vuoto/dup', it.title, it.link); continue; }
      const section = classify(it, feed);
      const win = (section === 'dischi' ? cfg.windowHours * 2 : cfg.windowHours) * H;
      const dbg = process.env.DEBUG === feed.name;
      if (blocked(it)) { if (dbg) console.error('bloccato', it.title); continue; }
      if (section === 'dischi' && !archive[it.link]) archive[it.link] = { src: feed.name, title: it.title, link: it.link, ts: it.ts || NOW, ex: excerpt(it.rawDesc, it.title) };
      if (it.ts && NOW - it.ts > win) { if (dbg) console.error('vecchio', it.title, new Date(it.ts).toISOString(), section); continue; }
      seen.add(it.link);
      items.push({ src: feed.name, lang: feed.lang, section, title: it.title, link: it.link, ts: it.ts, ex: excerpt(it.rawDesc, it.title) });
      n++;
    }
    status.push({ name: feed.name, url: feed.url, ok: true, n, total: parsed.length });
  } catch (e) { status.push({ name: feed.name, ok: false, err: String(e.message || e) }); }
}));

const fresh = [];
const freshSeen = new Set();
let redditOk = false;
let redditErr = '';
for (const url of cfg.reddit) {
  if (fresh.length) break; // basta una richiesta andata a buon fine, per non farsi limitare
  if (url !== cfg.reddit[0]) await new Promise(r => setTimeout(r, 3000));
  try {
    for (const it of parseFeed(await get(url))) {
      const m = it.title.match(/^\s*\[\s*(fresh[^\]]*)\]\s*(.+)$/i);
      if (!m || freshSeen.has(it.link)) continue;
      if (it.ts && NOW - it.ts > cfg.windowHours * H) continue;
      if (blocked({ title: m[2], cats: [] })) continue;
      freshSeen.add(it.link);
      const content = decode(it.rawDesc);
      const ext = (content.match(/<a href="([^"]+)">\[link\]<\/a>/) || [])[1];
      const kind = m[1].toUpperCase().replace(/\s+/g, ' ');
      fresh.push({ kind, title: m[2].trim(), thread: it.link, ext: ext && !/reddit\.com/.test(ext) ? decode(ext) : '', ts: it.ts });
    }
    redditOk = true;
  } catch (e) { redditErr = String(e.message || e); }
}
// Reddit limita spesso le richieste (HTTP 429): in quel caso si riusano gli ultimi [FRESH] scaricati
const CACHE = join(DIR, 'fresh-cache.json');
let freshStale = 0;
if (redditOk && fresh.length) await writeFile(CACHE, JSON.stringify({ at: NOW, fresh }));
else {
  try {
    const c = JSON.parse(await readFile(CACHE, 'utf8'));
    fresh.push(...c.fresh.filter(f => NOW - f.ts < cfg.windowHours * H));
    freshStale = c.at;
  } catch {}
}
status.push(redditOk && !freshStale ? { name: 'r/indieheads', ok: true, n: fresh.length } : { name: 'r/indieheads', ok: false, err: (redditErr || 'nessun post') + (freshStale ? ' (uso la copia precedente)' : '') });

// ---------- più recensiti ----------
for (const [k, r] of Object.entries(archive)) if (NOW - r.ts > ARCHIVE_DAYS * 24 * H) delete archive[k];
await writeFile(ARCHIVE, JSON.stringify(archive));

const norm = s => ' ' + s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\./g, '').replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
const unquote = s => s.replace(/^[\s‘'"“«]+|[\s’'"”»]+$/g, '').replace(/\s*[([].*?[)\]]\s*/g, ' ').trim();
// artista e album dai titoli strutturati: "Artista – Album", "Artista : Album", "Album by Artista", slug di Pitchfork
function albumKey(r) {
  const t = r.title.replace(/^(album of the week|album review|ep review|review)\s*:\s*/i, '').replace(/\s+(ep\s+)?review$/i, '');
  let m = t.match(/^(.+?)\s+[-–—:]\s+(.+)$/);
  // "Album (2026) Etichetta" (Distorsioni): via anno ed etichetta
  if (m && !/\breview\b/i.test(t)) return { artist: unquote(m[1]), album: unquote(m[2].replace(/\s*\((19|20)\d\d\).*$/, '').replace(/\s*\/\s*rece$/i, '')) };
  m = t.match(/^(.+?)\s+by\s+(.+)$/);
  if (m && r.src === 'The Quietus') return { artist: unquote(m[2]), album: unquote(m[1]) };
  if (r.src === 'Pitchfork') {
    const slug = (r.link.match(/\/reviews\/albums\/([^/]+)/) || [])[1] || '';
    const albumSlug = norm(unquote(t)).trim().replace(/ /g, '-');
    if (albumSlug && slug.endsWith('-' + albumSlug)) return { artist: slug.slice(0, -albumSlug.length - 1).replace(/-/g, ' '), album: unquote(t) };
  }
  return null;
}
const reviews = Object.values(archive).filter(r => !blocked({ title: r.title, cats: [] })).map(r => ({ ...r, hay: norm(`${r.title} ${r.link.split('/').filter(Boolean).slice(-2).join(' ').replace(/-/g, ' ')} ${r.ex}`) }));
const consensus = [];
const claimed = new Set();
for (const r of reviews.filter(r => albumKey(r)).sort((a, b) => b.ts - a.ts)) {
  if (claimed.has(r.link)) continue;
  const { artist, album } = albumKey(r);
  const na = norm(artist), nb = norm(album);
  if (na.trim().length < 2 || nb.trim().length < 2) continue;
  const bySrc = new Map();
  for (const o of reviews) if (!claimed.has(o.link) && o.hay.includes(na) && o.hay.includes(nb) && !bySrc.has(o.src)) bySrc.set(o.src, o);
  if (bySrc.size < 2) continue;
  const list = [...bySrc.values()].sort((a, b) => a.ts - b.ts);
  list.forEach(o => claimed.add(o.link));
  // il nome scritto da una rivista è più fedele di quello ricavato dallo slug di Pitchfork
  const better = list.map(o => o.src !== 'Pitchfork' && albumKey(o)).find(Boolean);
  const label = better || { artist: r.src === 'Pitchfork' ? artist.replace(/\b\w/g, c => c.toUpperCase()) : artist, album };
  consensus.push({ artist: label.artist, album: label.album, list, last: Math.max(...list.map(o => o.ts)), ex: (list.find(o => o.ex) || {}).ex || '' });
}
consensus.sort((a, b) => b.list.length - a.list.length || b.last - a.last);

items.sort((a, b) => b.ts - a.ts);
fresh.sort((a, b) => b.ts - a.ts);

// ---------- render ----------
const h = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtLong = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: 'numeric', month: 'short' });
const isNew = ts => ts && NOW - ts < cfg.newHours * H;
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const LANG = { it: 'IT', en: 'EN', fr: 'FR' };

const SECTIONS = [
  { id: 'piu-recensiti', title: 'Più recensiti', sub: `Album recensiti da almeno due riviste negli ultimi ${ARCHIVE_DAYS} giorni` },
  { id: 'dischi', title: 'Dischi', sub: `Recensioni e uscite, ultimi ${cfg.windowHours * 2 / 24} giorni` },
  { id: 'brani', title: 'Brani e video', sub: 'Singoli, anteprime, clip' },
  { id: 'fresh', title: 'Fresh su r/indieheads', sub: 'Post taggati [FRESH], [FRESH ALBUM], [FRESH EP]…' },
  { id: 'notizie', title: 'Notizie', sub: 'Annunci, tour, ristampe' },
  { id: 'approfondimenti', title: 'Approfondimenti', sub: 'Interviste, speciali, rubriche' },
  { id: 'blowup', title: 'Blow Up', sub: blowup.issue },
];

function row(it) {
  return `<li class="it" data-src="${h(slug(it.src))}"${isNew(it.ts) ? ' data-new' : ''}>
  <div class="meta"><span class="src">${h(it.src)}</span><span class="lang">${LANG[it.lang] || ''}</span>${it.ts ? `<time>${h(fmt.format(it.ts))}</time>` : ''}${isNew(it.ts) ? '<span class="pill">nuovo</span>' : ''}</div>
  <div class="body"><a class="t" href="${h(it.link)}" target="_blank" rel="noopener">${h(it.title)}</a>${it.ex ? `<p class="ex">${h(it.ex)}</p>` : ''}</div>
</li>`;
}
function freshRow(f) {
  const [artist, ...rest] = f.title.split(/\s+[-–—]\s+/);
  const label = rest.length ? `<b>${h(artist)}</b> – ${h(rest.join(' – '))}` : `<b>${h(f.title)}</b>`;
  return `<li class="fr"${isNew(f.ts) ? ' data-new' : ''}>
  <span class="kind">${h(f.kind.replace('FRESH', '').trim() || 'TRACK')}</span>
  <span class="ft">${label}</span>
  <span class="links">${f.ext ? `<a href="${h(f.ext)}" target="_blank" rel="noopener">ascolta</a>` : ''}<a href="${h(f.thread)}" target="_blank" rel="noopener">thread</a>${f.ts ? `<time>${h(fmt.format(f.ts))}</time>` : ''}</span>
</li>`;
}
function section(s) {
  let inner, count;
  if (s.id === 'fresh') {
    const isLong = f => /ALBUM|\bEP\b|MIXTAPE/.test(f.kind);
    const long = fresh.filter(isLong);
    const short = fresh.filter(f => !isLong(f));
    count = fresh.length;
    inner = (freshStale ? `<p class="note">Reddit non ha risposto: questi sono i post scaricati ${h(fmt.format(freshStale))}.</p>` : '') + (count ? `<div class="fresh-cols">
  <div><h3>Album, EP, mixtape <span class="n">${long.length}</span></h3><ul class="frl">${long.map(freshRow).join('') || `<li class="empty">Nessun album nelle ultime ${cfg.windowHours} ore.</li>`}</ul></div>
  <div><h3>Brani, video, live <span class="n">${short.length}</span></h3><ul class="frl">${short.map(freshRow).join('') || `<li class="empty">Nessun brano nelle ultime ${cfg.windowHours} ore.</li>`}</ul></div>
</div>` : '<p class="empty">Reddit non ha risposto a questo giro: riprova al prossimo aggiornamento.</p>');
  } else if (s.id === 'piu-recensiti') {
    count = consensus.length;
    inner = count ? `<ol class="cons">${consensus.map(c => `<li class="ca">
  <div class="cn" aria-label="${c.list.length} recensioni">${c.list.length}</div>
  <div class="body"><p class="cat"><b>${h(c.artist)}</b> – ${h(c.album)}</p>${c.ex ? `<p class="ex">${h(c.ex)}</p>` : ''}
  <p class="revs">${c.list.map(o => `<a href="${h(o.link)}" target="_blank" rel="noopener">${h(o.src)}</a><time>${h(fmtDay.format(o.ts))}</time>`).join('<span aria-hidden="true">·</span>')}</p></div>
</li>`).join('')}</ol>`
      : `<p class="empty">Nessun album recensito da più riviste per ora. L'archivio si riempie a ogni aggiornamento: in pochi giorni compariranno i primi.</p>`;
  } else if (s.id === 'blowup') {
    count = blowup.items.length;
    inner = `<ul class="bu">${blowup.items.map(b => `<li><a href="${h(b.url)}" target="_blank" rel="noopener">${h(b.title)}</a><span class="tag">${h(b.tag)}</span></li>`).join('')}</ul><p class="note">${h(blowup.note)}</p>`;
  } else {
    const list = items.filter(i => i.section === s.id);
    count = list.length;
    inner = list.length ? `<ul class="list">${list.map(row).join('')}</ul>` : '<p class="empty">Niente di nuovo in questa finestra.</p>';
  }
  return `<section id="${s.id}" class="sec">
<header class="sh"><h2>${h(s.title)}</h2><span class="count">${count}</span><p>${h(s.sub)}</p></header>
${inner}
</section>`;
}

const sources = [...new Set(items.map(i => i.src))].sort();
const newCount = items.filter(i => isNew(i.ts)).length + fresh.filter(f => isNew(f.ts)).length;
const failed = status.filter(s => !s.ok);

const page = `<title>Lato B</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@700;900&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* Layout: una colonna da "scaletta" — testata da manifesto, indice a chip, sezioni come elenchi con colonna meta a sinistra */
:root{
  --paper:#EDEFEA; --ink:#16181B; --muted:#5B6168; --rule:#D0D4CD; --accent:#2338C4; --hot:#B93A0E; --chip:#E1E4DE;
  --display:"Big Shoulders Display", "Arial Narrow", Impact, sans-serif;
  --body:"IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
  --mono:"IBM Plex Mono", ui-monospace, Consolas, monospace;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--paper:#111316;--ink:#E6E8E3;--muted:#99A0A7;--rule:#2A2E33;--accent:#97A6FF;--hot:#FF8A5B;--chip:#1C1F23;color-scheme:dark}}
:root[data-theme="dark"]{--paper:#111316;--ink:#E6E8E3;--muted:#99A0A7;--rule:#2A2E33;--accent:#97A6FF;--hot:#FF8A5B;--chip:#1C1F23;color-scheme:dark}
body{background:var(--paper);color:var(--ink);font:15px/1.5 var(--body)}
.wrap{max-width:980px;margin:0 auto;padding-block:28px 64px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
a{color:inherit}
a:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.mast{display:grid;gap:10px;border-bottom:3px solid var(--ink);padding-bottom:18px}
.mast h1{font:900 clamp(64px,14vw,132px)/.82 var(--display);letter-spacing:-.01em;margin:0;text-transform:uppercase}
.mast h1 span{color:var(--accent)}
.mast .tag{font:500 13px/1.4 var(--mono);color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:0}
.stats{display:flex;flex-wrap:wrap;gap:6px 18px;font:400 13px/1.4 var(--mono);color:var(--muted);margin:0}
.stats b{color:var(--ink);font-weight:500}
nav.toc{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 6px}
nav.toc a{font:600 13px/1 var(--body);text-decoration:none;padding:8px 12px;border:1px solid var(--rule);border-radius:999px;background:var(--chip)}
nav.toc a:hover{border-color:var(--ink)}
.filters{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:10px 0 0;font:400 12px/1 var(--mono);color:var(--muted)}
.filters button{font:500 12px/1 var(--mono);color:var(--ink);background:transparent;border:1px solid var(--rule);border-radius:4px;padding:6px 8px;cursor:pointer}
.filters button[aria-pressed="false"]{color:var(--muted);text-decoration:line-through;opacity:.6}
.filters button.only[aria-pressed="true"]{background:var(--hot);border-color:var(--hot);color:var(--paper)}
.sec{margin-top:44px}
.sh{display:grid;grid-template-columns:auto auto 1fr;align-items:baseline;gap:4px 12px;border-bottom:1px solid var(--ink);padding-bottom:8px}
.sh h2{font:900 40px/1 var(--display);text-transform:uppercase;margin:0;text-wrap:balance}
.sh .count{font:500 14px/1 var(--mono);color:var(--accent)}
.sh p{grid-column:1/-1;margin:0;color:var(--muted);font-size:13px}
ul{list-style:none;margin:0;padding:0}
.list .it{display:grid;grid-template-columns:170px 1fr;gap:4px 20px;padding:14px 0;border-bottom:1px solid var(--rule)}
.meta{display:flex;flex-wrap:wrap;gap:4px 8px;align-content:start;font:400 12px/1.4 var(--mono);color:var(--muted)}
.meta .src{color:var(--ink);font-weight:500;width:100%}
.lang{border:1px solid var(--rule);border-radius:3px;padding:0 4px;font-size:10px;letter-spacing:.06em}
.pill{font:500 10px/1.6 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--hot);border:1px solid currentColor;border-radius:3px;padding:0 5px}
.body{min-width:0}
.t{font-weight:600;font-size:16px;line-height:1.35;text-decoration:none;text-wrap:pretty}
.t:hover{text-decoration:underline;text-decoration-color:var(--accent);text-underline-offset:3px}
.ex{margin:4px 0 0;color:var(--muted);font-size:14px;max-width:65ch}
.fresh-cols{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-top:6px}
.fresh-cols>div{min-width:0}
.fresh-cols h3{font:700 22px/1 var(--display);text-transform:uppercase;letter-spacing:.02em;margin:14px 0 6px;display:flex;gap:8px;align-items:baseline}
.n{font:500 12px/1 var(--mono);color:var(--accent)}
.fr{display:grid;grid-template-columns:62px 1fr;gap:2px 10px;padding:9px 0;border-bottom:1px solid var(--rule)}
.kind{font:500 10px/1.8 var(--mono);letter-spacing:.06em;color:var(--accent);text-transform:uppercase}
.ft{min-width:0;overflow-wrap:anywhere}
.ft b{font-weight:600}
.fr[data-new] .ft::after{content:"nuovo";margin-left:8px;font:500 10px/1 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--hot)}
.links{grid-column:2;display:flex;gap:12px;font:400 12px/1.4 var(--mono);color:var(--muted)}
.cons{list-style:none;margin:0;padding:0}
.ca{display:grid;grid-template-columns:56px 1fr;gap:4px 16px;padding:14px 0;border-bottom:1px solid var(--rule)}
.cn{font:900 44px/.9 var(--display);color:var(--accent);font-variant-numeric:tabular-nums}
.cat{margin:0;font-size:17px;line-height:1.35}
.cat b{font-weight:600}
.revs{display:flex;flex-wrap:wrap;gap:4px 8px;margin:6px 0 0;font:400 12px/1.5 var(--mono);color:var(--muted)}
.revs a{color:var(--accent);font-weight:500}
.revs time{margin-left:4px}
.links a{color:var(--accent)}
.bu li{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--rule)}
.bu a{font-weight:600;text-decoration:none}
.bu a:hover{text-decoration:underline}
.bu .tag{font:400 12px/1.6 var(--mono);color:var(--muted);white-space:nowrap}
.note,.empty{color:var(--muted);font-size:13px}
footer{margin-top:56px;padding-top:14px;border-top:3px solid var(--ink);font:400 12px/1.6 var(--mono);color:var(--muted)}
footer ul{display:flex;flex-wrap:wrap;gap:4px 14px}
footer .ko{color:var(--hot)}
@media (max-width:640px){
  .list .it{grid-template-columns:1fr}
  .meta .src{width:auto}
  .fresh-cols{grid-template-columns:1fr;gap:0}
  .sh h2{font-size:34px}
}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
</style>
<div class="wrap">
<header class="mast">
  <p class="tag">Digest musicale personale · aggiornato ogni 12 ore</p>
  <h1>Lato <span>B</span></h1>
  <p class="stats"><span>Aggiornato <b>${h(fmtLong.format(NOW))}</b></span><span><b>${items.length + fresh.length}</b> segnalazioni</span><span><b>${newCount}</b> nelle ultime ${cfg.newHours} ore</span><span><b>${status.filter(s => s.ok).length}</b> fonti attive</span></p>
</header>
<nav class="toc" aria-label="Sezioni">${SECTIONS.map(s => `<a href="#${s.id}">${h(s.title)}</a>`).join('')}</nav>
<div class="filters" role="group" aria-label="Filtra per fonte"><span>Fonti:</span>${sources.map(s => `<button type="button" id="f-${slug(s)}" data-src="${slug(s)}" aria-pressed="true">${h(s)}</button>`).join('')}<button type="button" id="f-onlynew" class="only" aria-pressed="false">solo nuovi</button></div>
${SECTIONS.map(section).join('\n')}
<footer>
  <p>Fonti: ${status.filter(s => s.ok).map(s => `${h(s.name)} (${s.n})`).join(' · ')}</p>
  ${failed.length ? `<p class="ko">Non raggiunte a questo giro: ${failed.map(s => `${h(s.name)} – ${h(s.err)}`).join(' · ')}</p>` : ''}
  <p>Esclusi in automatico metal e grandi nomi mainstream (lista modificabile in config.json). Finestra: ${cfg.windowHours} ore per notizie e brani, ${cfg.windowHours * 2 / 24} giorni per le recensioni.</p>
</footer>
</div>
<script>
(function(){
  var KEY='latob-filters', off={}, onlyNew=false;
  try{var s=JSON.parse(localStorage.getItem(KEY)||'{}');off=s.off||{};onlyNew=!!s.onlyNew}catch(e){}
  var btns=document.querySelectorAll('.filters button[data-src]'), nb=document.getElementById('f-onlynew');
  function apply(){
    btns.forEach(function(b){b.setAttribute('aria-pressed',off[b.dataset.src]?'false':'true')});
    nb.setAttribute('aria-pressed',onlyNew?'true':'false');
    document.querySelectorAll('.it').forEach(function(li){li.hidden=!!off[li.dataset.src]||(onlyNew&&!li.hasAttribute('data-new'))});
    document.querySelectorAll('.fr').forEach(function(li){li.hidden=onlyNew&&!li.hasAttribute('data-new')});
    try{localStorage.setItem(KEY,JSON.stringify({off:off,onlyNew:onlyNew}))}catch(e){}
  }
  btns.forEach(function(b){b.addEventListener('click',function(){off[b.dataset.src]=!off[b.dataset.src];if(!off[b.dataset.src])delete off[b.dataset.src];apply()})});
  nb.addEventListener('click',function(){onlyNew=!onlyNew;apply()});
  apply();
})();
</script>
`;

await writeFile(join(DIR, 'artifact.html'), page);
await writeFile(join(DIR, 'lato-b.html'), `<!doctype html>\n<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n${page.replace('</style>', '</style></head><body>')}</body></html>\n`);
console.log(JSON.stringify({ items: items.length, bySection: Object.fromEntries(['dischi', 'brani', 'notizie', 'approfondimenti'].map(k => [k, items.filter(i => i.section === k).length])), fresh: fresh.length, status }, null, 1));
