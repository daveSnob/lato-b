// Lato B: digest musicale da feed RSS + r/indieheads [FRESH].
// Uso: node digest.mjs  -> scrive lato-b.html (pagina completa) e artifact.html (frammento per Claude Artifact)
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(await readFile(join(DIR, 'config.json'), 'utf8'));
const NOW = Date.now();
const H = 3600e3;
const UA = 'Mozilla/5.0 (LatoB RSS digest)';

// ---------- fetch ----------
async function get(url, retry = true, ua = UA) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': ua, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' }, signal: ctl.signal });
    if (r.status === 429 && retry) {
      // rispetta il limite: aspetta quanto chiede il server (max 60 s) e riprova una volta
      const wait = Math.min(60, Number(r.headers.get('x-ratelimit-reset') || r.headers.get('retry-after')) || 30);
      clearTimeout(t);
      await new Promise(res => setTimeout(res, (wait + 2) * 1000));
      return get(url, false, ua);
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
    const image = (b.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']image\//i) || b.match(/<(?:media:content|media:thumbnail)[^>]+url=["']([^"']+)["']/i) || rawDesc.match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1] || '';
    const pathDate = b.match(/\/(20\d\d)\/(\d\d)\/(\d\d)\//); // feed senza date (The Wire): data dal percorso immagini
    const ts = Date.parse(date) || (pathDate ? Date.parse(`${pathDate[1]}-${pathDate[2]}-${pathDate[3]}T12:00:00Z`) : 0);
    let cover = decode(image);
    const yt = cover.match(/youtube\.com\/embed\/([\w-]{11})/i);
    if (yt) cover = `https://i.ytimg.com/vi/${yt[1]}/hqdefault.jpg`;
    if (!/^https?:\/\//i.test(cover)) cover = '';
    return { title: text(tag(b, 'title')), link: decode(link.trim()), cats, ts, rawDesc, image: cover };
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
for (const r of Object.values(archive)) {
  const yt = String(r.image || '').match(/youtube\.com\/embed\/([\w-]{11})/i);
  if (yt) r.image = `https://i.ytimg.com/vi/${yt[1]}/hqdefault.jpg`;
}

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
      if (section === 'dischi') {
        if (!archive[it.link]) archive[it.link] = { src: feed.name, title: it.title, link: it.link, ts: it.ts || NOW, ex: excerpt(it.rawDesc, it.title), image: it.image };
        else if (it.image && !archive[it.link].image) archive[it.link].image = it.image;
      }
      if (it.ts && NOW - it.ts > win) { if (dbg) console.error('vecchio', it.title, new Date(it.ts).toISOString(), section); continue; }
      seen.add(it.link);
      items.push({ src: feed.name, lang: feed.lang, section, title: it.title, link: it.link, ts: it.ts, ex: excerpt(it.rawDesc, it.title), image: it.image });
      n++;
    }
    status.push({ name: feed.name, url: feed.url, ok: true, n, total: parsed.length });
  } catch (e) { status.push({ name: feed.name, ok: false, err: String(e.message || e) }); }
}));

// ---------- disco del giorno (Bandcamp Daily, rubrica "Album of the Day") ----------
const aotd = [];
try {
  for (const it of parseFeed(await get(cfg.bandcampFeed, true, 'LatoB-digest/1.0'))) {
    // descrizione: <img> copertina + un paragrafo di presentazione
    const paras = [...decode(it.rawDesc).matchAll(/<p>([\s\S]*?)<\/p>/g)].map(p => text(p[1])).filter(p => p && !/^Read full story/i.test(p));
    const image = (decode(it.rawDesc).match(/<img[^>]+src="([^"]+)"/) || [])[1] || it.image || '';
    if (!it.cats.some(c => /album of the day/i.test(c)) && !/\/album-of-the-day\//.test(it.link)) {
      // liste mensili (Best Punk, Best Ambient…), Essential Releases, speciali: in Approfondimenti
      if (it.ts && NOW - it.ts < cfg.windowHours * 2 * H && !blocked({ title: it.title, cats: it.cats }))
        items.push({ src: 'Bandcamp Daily', lang: 'en', section: 'approfondimenti', title: it.title, link: it.link, ts: it.ts, ex: [it.cats[0], paras[0]].filter(Boolean).join(' · '), image });
      continue;
    }
    // titolo "Artista, “Album”"
    const m = it.title.match(/^(.+?),\s*[“"](.+?)[”"]\s*$/);
    aotd.push({ artist: m ? m[1].trim() : '', album: m ? m[2].trim() : it.title, link: it.link, ex: paras[0] || '', image, ts: it.ts });
  }
  status.push({ name: 'Bandcamp Daily', ok: true, n: aotd.length });
} catch (e) { status.push({ name: 'Bandcamp Daily', ok: false, err: String(e.message || e) }); }
aotd.sort((a, b) => b.ts - a.ts);

// ---------- più recensiti ----------
for (const [k, r] of Object.entries(archive)) if (NOW - r.ts > ARCHIVE_DAYS * 24 * H) delete archive[k];
await writeFile(ARCHIVE, JSON.stringify(archive));

const norm = s => ' ' + s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\./g, '').replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
const unquote = s => s.replace(/^[\s‘'"“«]+|[\s’'"”»]+$/g, '').replace(/\s*[([].*?[)\]]\s*/g, ' ').trim();
// artista e album dai titoli strutturati: "Artista – Album", "Artista : Album", "Album by Artista", slug di Pitchfork
function albumKey(r) {
  const t = r.title.replace(/^(album of the week|album review|ep review|review|first listen)\s*:\s*/i, '').replace(/\s+(ep\s+)?review$/i, '');
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
  consensus.push({ artist: label.artist, album: label.album, list, last: Math.max(...list.map(o => o.ts)), ex: (list.find(o => o.ex) || {}).ex || '', image: (list.find(o => o.image) || {}).image || '' });
}
consensus.sort((a, b) => b.list.length - a.list.length || b.last - a.last);

// ---------- YouTube concert: KEXP (Full Performance) e NPR Tiny Desk ----------
// Il feed di un canale dà solo gli ultimi 15 video (KEXP ne pubblica ~6 per sessione), quindi i concerti visti
// si conservano in concerts-cache.json; se la cache è scarsa si usa anche la ricerca nel canale (data approssimata).
const CONC_CACHE = join(DIR, 'concerts-cache.json');
const concWin = (cfg.concertDays || 60) * 24 * H;
let concerts = {};
try { concerts = JSON.parse(await readFile(CONC_CACHE, 'utf8')); } catch {}
const ytLong = id => `https://www.youtube.com/feeds/videos.xml?playlist_id=UULF${id.slice(2)}`; // solo video lunghi, niente Shorts
const REL = { s: 1 / 3600, m: 1 / 60, min: 1 / 60, h: 1, d: 24, w: 168, mo: 720, y: 8760 };
const relTs = t => { const m = (t || '').match(/(\d+)\s*(mo|min|[smhdwy])\w*\s+ago/i); return m ? NOW - Number(m[1]) * REL[m[2].toLowerCase()] * H : 0; };
async function ytSearch(id, q) {
  const r = await fetch(`https://www.youtube.com/channel/${id}/search?query=${encodeURIComponent(q)}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const m = (await r.text()).match(/var ytInitialData = (\{[\s\S]*?\});<\/script>/);
  if (!m) throw new Error('pagina senza dati');
  const out = [];
  (function walk(o) { if (!o || typeof o !== 'object') return; if (o.videoRenderer) { const v = o.videoRenderer; out.push({ vid: v.videoId, title: v.title?.runs?.[0]?.text || '', ts: relTs(v.publishedTimeText?.simpleText) }); } for (const k in o) walk(o[k]); })(JSON.parse(m[1]));
  return out;
}
await Promise.all((cfg.concerts || []).map(async c => {
  const want = t => t.toLowerCase().includes(c.match.toLowerCase()) && !blocked({ title: t, cats: [] });
  const add = (vid, title, ts, approx) => {
    const prev = concerts[vid];
    // la data esatta del feed vince su quella approssimata della ricerca; una data approssimata già salvata non si sposta
    if (prev && (!prev.approx || approx)) return;
    concerts[vid] = approx ? { src: c.name, vid, title, ts, approx: true } : { src: c.name, vid, title, ts };
  };
  let n = 0;
  try {
    for (const it of parseFeed(await get(ytLong(c.id)))) {
      const vid = (it.link.match(/[?&]v=([\w-]{11})/) || [])[1];
      if (vid && want(it.title)) { add(vid, it.title, it.ts || NOW, false); n++; }
    }
    status.push({ name: c.name + ' (YouTube)', ok: true, n });
  } catch (e) { status.push({ name: c.name + ' (YouTube)', ok: false, err: String(e.message || e) }); }
  const have = Object.values(concerts).filter(x => x.src === c.name && NOW - x.ts < concWin).length;
  if (have < (cfg.concertPerSource || 12) && c.search) {
    try { for (const v of await ytSearch(c.id, c.search)) if (v.vid && v.ts && want(v.title)) add(v.vid, v.title, v.ts, true); }
    catch (e) { status.push({ name: c.name + ' (ricerca YouTube)', ok: false, err: String(e.message || e) }); }
  }
}));
for (const [vid, x] of Object.entries(concerts)) if (NOW - x.ts > concWin) delete concerts[vid];
await writeFile(CONC_CACHE, JSON.stringify(concerts));
const concertsBy = Object.fromEntries((cfg.concerts || []).map(c => [c.name,
  Object.values(concerts).filter(x => x.src === c.name).sort((a, b) => b.ts - a.ts).slice(0, cfg.concertPerSource || 12)]));

items.sort((a, b) => b.ts - a.ts);

// ---------- viste editoriali derivate dai dati reali ----------
// Non sono classifiche editoriali inventate: aggregano soltanto citazioni e date già presenti nei feed.
const artistFrom = it => {
  const parsed = albumKey(it);
  if (parsed?.artist) return parsed.artist;
  const m = it.title.match(/^(.+?)\s+[-–—:]\s+.+$/);
  return m ? unquote(m[1]) : '';
};
const emergingMap = new Map();
for (const r of reviews) {
  const artist = artistFrom(r);
  if (!artist || artist.length < 2) continue;
  const key = norm(artist);
  const x = emergingMap.get(key) || { artist, sources: new Set(), last: r.ts, link: r.link, title: r.title };
  x.sources.add(r.src); x.last = Math.max(x.last, r.ts); emergingMap.set(key, x);
}
const emerging = [...emergingMap.values()].filter(x => x.sources.size >= 2).sort((a, b) => b.sources.size - a.sources.size || b.last - a.last).slice(0, 12);
const releaseCandidates = items.filter(i => ['dischi', 'brani'].includes(i.section)).slice(0, 24);
const trendMap = new Map();
for (const r of reviews) {
  const artist = artistFrom(r); if (!artist) continue;
  const key = norm(artist); const x = trendMap.get(key) || { artist, recent: 0, previous: 0, sources: new Set(), link: r.link, title: r.title };
  if (NOW - r.ts < 7 * 24 * H) x.recent++; else if (NOW - r.ts < 30 * 24 * H) x.previous++;
  x.sources.add(r.src); trendMap.set(key, x);
}
const trends = [...trendMap.values()].filter(x => x.recent && x.sources.size >= 2).sort((a, b) => (b.recent - b.previous) - (a.recent - a.previous) || b.recent - a.recent).slice(0, 10);

// ---------- render ----------
const h = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtLong = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: 'numeric', month: 'short' });
const isNew = ts => ts && NOW - ts < cfg.newHours * H;
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const LANG = { it: 'IT', en: 'EN', fr: 'FR' };

const SECTIONS = [
  { id: 'disco-del-giorno', title: 'Disco del giorno', sub: 'La scelta quotidiana di Bandcamp Daily, con i giorni precedenti' },
  { id: 'piu-recensiti', title: 'Più recensiti', sub: `Album recensiti da almeno due riviste negli ultimi ${ARCHIVE_DAYS} giorni` },
  { id: 'concerti', title: 'YouTube concert', sub: `Ultime sessioni complete di KEXP e concerti NPR Tiny Desk (ultimi ${cfg.concertDays || 60} giorni)` },
  { id: 'uscite', title: 'Nuove uscite', sub: 'Album, EP e singoli segnalati dalle fonti monitorate' },
  { id: 'emergenti', title: 'Artisti emergenti', sub: 'Artisti citati da almeno due fonti indipendenti' },
  { id: 'termometro', title: 'Termometro musicale', sub: 'Crescita delle citazioni negli ultimi 7 giorni rispetto ai 30 precedenti' },
  { id: 'dischi', title: 'Dischi', sub: `Recensioni e uscite, ultimi ${cfg.windowHours * 2 / 24} giorni` },
  { id: 'brani', title: 'Brani e video', sub: 'Singoli, anteprime, clip' },
  { id: 'notizie', title: 'Notizie', sub: 'Annunci, tour, ristampe' },
  { id: 'approfondimenti', title: 'Approfondimenti', sub: 'Interviste, speciali, rubriche' },
];

function row(it) {
  return `<li class="it" data-src="${h(slug(it.src))}"${isNew(it.ts) ? ' data-new' : ''}>
  <div class="meta"><span class="src">${h(it.src)}</span><span class="lang">${LANG[it.lang] || ''}</span>${it.ts ? `<time>${h(fmt.format(it.ts))}</time>` : ''}${isNew(it.ts) ? '<span class="pill">nuovo</span>' : ''}</div>
  <div class="body"><a class="t" href="${h(it.link)}" target="_blank" rel="noopener">${h(it.title)}</a>${it.ex ? `<p class="ex">${h(it.ex)}</p>` : ''}</div>
</li>`;
}
function aotdCover(a, big) {
  return IMAGES && a.image ? `<img src="${h(a.image)}" alt="Cover di ${h(a.album)}" loading="${big ? 'eager' : 'lazy'}">` : `<span class="cover-ph" aria-hidden="true">${h(a.album.slice(0, 2))}</span>`;
}
// "Russian Circles - Full Performance (Live on KEXP)" / "CMAT: Tiny Desk Concert" -> artista + etichetta
function concertCard(c) {
  const artist = c.title.replace(/\s*[-–—:|]\s*(Full Performance.*|Tiny Desk Concert.*)$/i, '').replace(/\s*\(Live on KEXP\)\s*$/i, '').trim() || c.title;
  const label = c.src === 'KEXP' ? 'Full Performance · Live on KEXP' : 'Tiny Desk Concert';
  const thumb = IMAGES ? `<img src="https://i.ytimg.com/vi/${h(c.vid)}/hqdefault.jpg" alt="" loading="lazy" width="480" height="360">` : '<span class="ph" aria-hidden="true">▶</span>';
  const when = c.approx ? `<span title="data approssimativa">≈ ${h(fmtDay.format(c.ts))}</span>` : `<time>${h(fmt.format(c.ts))}</time>`;
  return `<li class="card" data-src="${h(slug(c.src))}"${isNew(c.ts) ? ' data-new' : ''}><a href="https://www.youtube.com/watch?v=${h(c.vid)}" target="_blank" rel="noopener"><span class="thumb">${thumb}${isNew(c.ts) ? '<span class="pill solid">nuovo</span>' : ''}</span><span class="ct">${h(artist)}</span></a><span class="cm">${h(label)} · ${when}</span></li>`;
}
function editorialRow(x, label, detail) {
  return `<li class="editorial-row"><div><span class="editorial-label">${h(label)}</span><a class="t" href="${h(x.link)}" target="_blank" rel="noopener">${h(x.artist || x.title)}</a><span class="editorial-detail">${h(detail)}</span></div></li>`;
}
function section(s) {
  let inner, count;
  if (s.id === 'disco-del-giorno') {
    count = aotd.length;
    const [top, ...prev] = aotd;
    inner = top ? `<article class="aotd">
  <a class="aotd-cover" href="${h(top.link)}" target="_blank" rel="noopener">${aotdCover(top, true)}</a>
  <div class="aotd-body">
    <span class="editorial-label">Bandcamp Daily · ${h(fmtDay.format(top.ts))}${isNew(top.ts) ? ' · <span class="pill">nuovo</span>' : ''}</span>
    <h3><a href="${h(top.link)}" target="_blank" rel="noopener">${top.artist ? `<span class="aotd-artist">${h(top.artist)}</span>` : ''}<span class="aotd-album">${h(top.album)}</span></a></h3>
    ${top.ex ? `<p class="ex">${h(top.ex)}</p>` : ''}
    <a class="aotd-read" href="${h(top.link)}" target="_blank" rel="noopener">Leggi la recensione e ascolta →</a>
  </div>
</article>${prev.length ? `<ul class="aotd-prev">${prev.slice(0, 8).map(a => `<li><a href="${h(a.link)}" target="_blank" rel="noopener"><span class="cover">${aotdCover(a)}</span><span class="review-title">${a.artist ? `${h(a.artist)} – ` : ''}${h(a.album)}</span></a><span class="review-meta">${h(fmtDay.format(a.ts))}</span></li>`).join('')}</ul>` : ''}`
      : '<p class="empty">Bandcamp Daily non ha risposto a questo giro: riprova al prossimo aggiornamento.</p>';
  } else if (s.id === 'piu-recensiti') {
    count = consensus.length;
    // data-src elenca tutte le riviste che hanno recensito l'album: il filtro lo mostra se una di queste è scelta
    inner = count ? `<ol class="review-list">${consensus.map(c => `<li class="review-card ca" data-src="${h([...new Set(c.list.map(o => slug(o.src)))].join(' '))}">
  <a href="${h((c.list.find(o => o.image) || c.list[0]).link)}" target="_blank" rel="noopener" title="${h(c.album)}">
    <span class="cover">${c.image ? `<img src="${h(c.image)}" alt="Cover di ${h(c.album)}" loading="lazy">` : `<span class="cover-ph" aria-hidden="true">${h(c.album.slice(0, 2))}</span>`}</span>
    <span class="review-title">${h(c.artist)} – ${h(c.album)}</span>
  </a>
  <span class="review-count"><b>${c.list.length}</b> recensioni</span>
  <span class="review-meta">${c.list.map(o => `<a href="${h(o.link)}" target="_blank" rel="noopener">${h(o.src)}</a>`).join(' · ')}</span>
</li>`).join('')}</ol>`
      : `<p class="empty">Nessun album recensito da più riviste per ora. L'archivio si riempie a ogni aggiornamento: in pochi giorni compariranno i primi.</p>`;
  } else if (s.id === 'concerti') {
    const groups = Object.entries(concertsBy);
    count = groups.reduce((n, [, l]) => n + l.length, 0);
    inner = count ? `<div class="tabs" role="tablist" aria-label="Canale">
${groups.map(([name, l], i) => `  <button type="button" role="tab" data-tab="c-${slug(name)}" aria-selected="${i ? 'false' : 'true'}">${h(name)} <span class="n">${l.length}</span></button>`).join('\n')}
</div>
${groups.map(([name, l], i) => `<div id="c-${slug(name)}" class="tp"${i ? ' hidden' : ''}>${l.length ? `<ul class="cards">${l.map(concertCard).join('')}</ul>` : '<p class="empty">Nessun concerto in questa finestra.</p>'}</div>`).join('\n')}`
      : '<p class="empty">YouTube non ha risposto a questo giro: riprova al prossimo aggiornamento.</p>';
  } else if (s.id === 'uscite') {
    count = releaseCandidates.length;
    inner = count ? `<ul class="editorial-list">${releaseCandidates.map(i => `<li class="editorial-row"><div><span class="editorial-label">${h(i.section === 'dischi' ? 'ALBUM / EP' : 'SINGOLO')}</span><a class="t" href="${h(i.link)}" target="_blank" rel="noopener">${h(i.title)}</a><span class="editorial-detail">${h(i.src)} · ${h(fmt.format(i.ts))}</span></div></li>`).join('')}</ul>` : '<p class="empty">Nessuna uscita segnalata in questa finestra.</p>';
  } else if (s.id === 'emergenti') {
    count = emerging.length;
    inner = count ? `<ul class="editorial-list">${emerging.map(x => editorialRow(x, `${x.sources.size} fonti`, `ultima citazione ${fmt.format(x.last)}`)).join('')}</ul>` : '<p class="empty">Non ci sono ancora artisti con citazioni incrociate sufficienti.</p>';
  } else if (s.id === 'termometro') {
    count = trends.length;
    inner = count ? `<ul class="editorial-list">${trends.map(x => editorialRow(x, `+${x.recent - x.previous} citazioni`, `${x.recent} negli ultimi 7 giorni · ${x.sources.size} fonti`)).join('')}</ul>` : '<p class="empty">Dati insufficienti per calcolare una tendenza verificabile.</p>';
  } else {
    const list = items.filter(i => i.section === s.id);
    count = list.length;
    const newsOnly = s.id === 'notizie';
    inner = list.length ? `<ul class="list">${newsOnly ? list.map(i => `<li class="news-title"><a href="${h(i.link)}" target="_blank" rel="noopener">${h(i.title)}</a>${i.ts ? `<time class="news-time" datetime="${new Date(i.ts).toISOString()}">${h(fmt.format(i.ts))}</time>` : ""}</li>`).join('') : list.map(row).join('')}</ul>` : '<p class="empty">Niente di nuovo in questa finestra.</p>';
  }
  return `<section id="${s.id}" class="sec">
<header class="sh"><h2>${h(s.title)}</h2><span class="count">${count}</span><p>${h(s.sub)}</p></header>
${inner}
</section>`;
}

// fonti selezionabili nel filtro: riviste e i canali dei concerti se hanno voci
const sources = [...new Set([...items.map(i => i.src), ...Object.keys(concertsBy).filter(k => concertsBy[k].length)])]
  .sort((a, b) => a.localeCompare(b, 'it', { sensitivity: 'base' }));
const newCount = items.filter(i => isNew(i.ts)).length + aotd.filter(a => isNew(a.ts)).length;
const failed = status.filter(s => !s.ok);

let IMAGES = true;
const page = () => `<title>Lato B</title>
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
/* indispensabile per i filtri: senza, display:grid di .it/.ca vince sull'attributo hidden e le voci restano visibili */
[hidden]{display:none!important}
.wrap{max-width:1600px;margin:0 auto;padding-block:28px 64px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
a{color:inherit}
a:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.mast{display:grid;gap:10px;border-bottom:3px solid var(--ink);padding-bottom:18px}
.mast h1{font:900 clamp(64px,14vw,132px)/.82 var(--display);letter-spacing:-.01em;margin:0;text-transform:uppercase}
.mast h1 span{color:var(--accent)}
.mast h1:focus{outline:none}
.mast .tag{font:500 13px/1.4 var(--mono);color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:0}
.stats{display:flex;flex-wrap:wrap;gap:6px 18px;font:400 13px/1.4 var(--mono);color:var(--muted);margin:0}
.stats b{color:var(--ink);font-weight:500}
/* indice fisso in alto: una riga sola, scorrevole in orizzontale sul telefono */
body::before{content:"";position:fixed;inset:0 0 auto;height:env(safe-area-inset-top,0px);z-index:10;background:var(--paper)}
nav.toc{position:sticky;top:env(safe-area-inset-top,0px);z-index:5;display:flex;gap:8px;margin:18px 0 6px;padding-block:10px;background:var(--paper);border-bottom:1px solid var(--rule);overflow-x:auto;scrollbar-width:none}
nav.toc::-webkit-scrollbar{display:none}
nav.toc a{flex:none;font:600 13px/1 var(--body);text-decoration:none;padding:8px 12px;border:1px solid var(--rule);border-radius:999px;background:var(--chip)}
nav.toc a:hover{border-color:var(--ink)}
nav.toc a[aria-current="true"]{background:var(--ink);border-color:var(--ink);color:var(--paper)}
.totop{position:fixed;z-index:6;right:calc(16px + env(safe-area-inset-right,0px));bottom:calc(16px + env(safe-area-inset-bottom,0px));font:600 13px/1 var(--body);color:var(--paper);background:var(--accent);border:0;border-radius:999px;padding:12px 16px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.25)}
.totop:hover{filter:brightness(1.1)}
.filters{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:10px 0 0;font:400 12px/1 var(--mono);color:var(--muted)}
.filters button{font:500 12px/1 var(--mono);color:var(--ink);background:transparent;border:1px solid var(--rule);border-radius:4px;padding:6px 8px;cursor:pointer}
/* filtro "mostra solo": le fonti selezionate sono piene; con nessuna selezionata si vede tutto */
.filters button:hover{border-color:var(--ink)}
.filters button[aria-pressed="true"]{background:var(--ink);border-color:var(--ink);color:var(--paper)}
.filters button.only[aria-pressed="true"]{background:var(--hot);border-color:var(--hot);color:var(--paper)}
.filters button.reset{border-style:dashed;color:var(--accent)}
.fnote{margin:14px 0 0;font:400 13px/1.4 var(--mono);color:var(--muted)}
.filter-drawer{margin-top:10px;font:400 12px/1 var(--mono);color:var(--muted)}
.filter-drawer summary{display:inline-block;cursor:pointer;padding:8px 10px;border:1px solid var(--rule);border-radius:999px;background:var(--chip);color:var(--ink);font-weight:600;list-style:none}
.filter-drawer summary::-webkit-details-marker{display:none}
.filter-drawer summary::after{content:' +';color:var(--accent)}
.filter-drawer[open] summary::after{content:' −'}
.filter-drawer .filters{margin-top:10px}
.content-grid{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:32px;align-items:start}
.news-side{position:sticky;top:68px;min-width:0;max-height:calc(100vh - 84px);overflow-y:auto;padding-right:8px;scrollbar-width:thin}
.news-side .sec{margin-top:44px}
.news-side .sh{position:sticky;top:0;z-index:2;background:var(--paper);padding-top:4px}
.news-side .list{margin-top:4px}
.news-side .news-title{padding:12px 0;border-bottom:1px solid var(--rule)}
.news-side .news-title a{font-weight:600;font-size:16px;line-height:1.35;text-decoration:none;display:block}
.news-side .news-title a:hover{text-decoration:underline;text-decoration-color:var(--accent);text-underline-offset:3px}
.news-side .news-time{display:block;margin-top:4px;font:400 12px/1.4 var(--mono);color:var(--muted)}
.review-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:24px 18px;list-style:none;margin:0;padding:0}
.review-card{display:grid;grid-template-columns:96px minmax(0,1fr);grid-template-rows:auto auto auto;gap:5px 12px;align-items:start;min-width:0;padding:14px 0;border-bottom:1px solid var(--rule)}
.review-card a{display:contents;text-decoration:none}
.cover{aspect-ratio:1/1;overflow:hidden;border-radius:4px;background:var(--chip);display:block}
.review-card .cover{grid-column:1;grid-row:1 / span 3}
.cover img{width:100%;height:100%;object-fit:cover;display:block}
.cover-ph{height:100%;display:grid;place-items:center;color:var(--accent);font:900 42px/.9 var(--display);text-transform:uppercase;padding:16px;text-align:center}
.review-title,.review-count,.review-meta{grid-column:2;min-width:0}
.review-title{font-weight:600;font-size:16px;line-height:1.3}
.review-count{display:block;margin-top:2px;font:500 12px/1.4 var(--mono);color:var(--accent)}
.review-meta{display:flex;flex-wrap:wrap;gap:3px 8px;font:400 12px/1.5 var(--mono);color:var(--muted)}
.sec{margin-top:44px;scroll-margin-top:calc(64px + env(safe-area-inset-top,0px))}
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
.n{font:500 12px/1 var(--mono);color:var(--accent)}
.aotd{display:grid;grid-template-columns:minmax(0,320px) 1fr;gap:20px 28px;align-items:start;margin-top:16px}
.aotd-cover{display:block;aspect-ratio:1/1;border-radius:4px;overflow:hidden;background:var(--chip)}
.aotd-cover img{width:100%;height:100%;object-fit:cover;display:block}
.aotd-body{min-width:0;display:grid;gap:10px}
.aotd h3{margin:0}
.aotd h3 a{text-decoration:none;display:grid;gap:4px}
.aotd h3 a:hover .aotd-album{text-decoration:underline;text-decoration-color:var(--accent);text-underline-offset:4px}
.aotd-artist{font:600 18px/1.3 var(--body)}
.aotd-album{font:900 clamp(36px,6vw,56px)/.95 var(--display);text-transform:uppercase;text-wrap:balance;overflow-wrap:anywhere}
.aotd .ex{font-size:16px;color:var(--ink)}
.aotd-read{font:500 13px/1.4 var(--mono);color:var(--accent)}
.aotd-prev{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:18px 14px;margin-top:26px;padding-top:18px;border-top:1px solid var(--rule)}
.aotd-prev a{text-decoration:none;display:grid;gap:6px}
.aotd-prev .review-title{font-size:14px}
.aotd-prev .cover-ph{font-size:30px}
.cons{list-style:none;margin:0;padding:0}
.ca{display:grid;grid-template-columns:56px 1fr;gap:4px 16px;padding:14px 0;border-bottom:1px solid var(--rule)}
.cn{font:900 44px/.9 var(--display);color:var(--accent);font-variant-numeric:tabular-nums}
.cat{margin:0;font-size:17px;line-height:1.35}
.cat b{font-weight:600}
.revs{display:flex;flex-wrap:wrap;gap:4px 8px;margin:6px 0 0;font:400 12px/1.5 var(--mono);color:var(--muted)}
.revs a{color:var(--accent);font-weight:500}
.revs time{margin-left:4px}
.links a{color:var(--accent)}
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:16px 0 14px}
.tabs button{font:600 14px/1 var(--body);color:var(--ink);background:var(--chip);border:1px solid var(--rule);border-radius:999px;padding:9px 14px;cursor:pointer}
.tabs button[aria-selected="true"]{background:var(--ink);color:var(--paper);border-color:var(--ink)}
.tabs .n{margin-left:4px}
.tabs button[aria-selected="true"] .n{color:inherit;opacity:.75}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:22px 18px}
.card{min-width:0}
.card a{text-decoration:none;display:grid;gap:8px}
.thumb{position:relative;display:block;aspect-ratio:16/9;overflow:hidden;border-radius:4px;background:var(--chip)}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.ph{position:absolute;inset:0;display:grid;place-items:center;font-size:28px;color:var(--accent)}
.pill.solid{position:absolute;top:8px;left:8px;background:var(--hot);border-color:var(--hot);color:#fff}
.ct{font-weight:600;font-size:16px;line-height:1.3;text-wrap:pretty}
.card a:hover .ct{text-decoration:underline;text-decoration-color:var(--accent);text-underline-offset:3px}
.cm{display:block;margin-top:4px;font:400 12px/1.5 var(--mono);color:var(--muted)}
.editorial-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:0 24px}
.editorial-row{padding:14px 0;border-bottom:1px solid var(--rule);min-width:0}
.editorial-row .t{display:block;margin-top:2px}
.editorial-label{display:block;font:500 11px/1.3 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--accent)}
.editorial-detail{display:block;margin-top:4px;font:400 12px/1.4 var(--mono);color:var(--muted)}
.note,.empty{color:var(--muted);font-size:13px}
footer{margin-top:56px;padding-top:14px;border-top:3px solid var(--ink);font:400 12px/1.6 var(--mono);color:var(--muted)}
footer ul{display:flex;flex-wrap:wrap;gap:4px 14px}
footer .ko{color:var(--hot)}
@media (max-width:640px){
  .list .it{grid-template-columns:1fr}
  .meta .src{width:auto}
  .aotd{grid-template-columns:1fr}
  .sh h2{font-size:34px}
  .content-grid{grid-template-columns:1fr}
  .news-side{position:static;max-height:none;overflow:visible;padding-right:0}
  .review-list{grid-template-columns:1fr;gap:0}
  .review-card{grid-template-columns:84px minmax(0,1fr);gap:5px 10px}
}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
</style>
<div class="wrap">
<header class="mast">
  <p class="tag">Digest musicale personale · aggiornato ogni ora</p>
  <h1 tabindex="-1">Lato <span>B</span></h1>
  <p class="stats"><span>Aggiornato <b>${h(fmtLong.format(NOW))}</b></span><span><b>${items.length + aotd.length}</b> segnalazioni</span><span><b>${newCount}</b> nelle ultime ${cfg.newHours} ore</span><span><b>${status.filter(s => s.ok).length}</b> fonti attive</span></p>
</header>
<nav class="toc" aria-label="Sezioni">${SECTIONS.filter(s => s.id !== 'notizie').map(s => `<a href="#${s.id}">${h(s.title)}</a>`).join('')}</nav>
<details class="filter-drawer"><summary>Mostra solo: filtri fonti</summary><div class="filters" role="group" aria-label="Mostra solo le fonti selezionate"><span>Fonti:</span>${sources.map(s => `<button type="button" id="f-${slug(s)}" data-src="${slug(s)}" aria-pressed="false">${h(s)}</button>`).join('')}<button type="button" id="f-onlynew" class="only" aria-pressed="false">solo nuovi</button><button type="button" id="f-all" class="reset" hidden>tutte le fonti</button></div></details>
<p class="fnote" id="fnote" hidden></p>
<div class="content-grid"><main>${SECTIONS.filter(s => s.id !== 'notizie').map(section).join('\n')}</main><aside class="news-side" aria-label="Notizie">${section(SECTIONS.find(s => s.id === 'notizie'))}</aside></div>
<footer>
  <p>Fonti: ${status.filter(s => s.ok).map(s => `${h(s.name)} (${s.n})`).join(' · ')}</p>
  ${failed.length ? `<p class="ko">Non raggiunte a questo giro: ${failed.map(s => `${h(s.name)} – ${h(s.err)}`).join(' · ')}</p>` : ''}
  <p>Esclusi in automatico metal e grandi nomi mainstream (lista modificabile in config.json). Finestra: ${cfg.windowHours} ore per notizie e brani, ${cfg.windowHours * 2 / 24} giorni per le recensioni.</p>
</footer>
</div>
<button type="button" class="totop" id="totop" hidden aria-label="Torna all'inizio della pagina">↑ inizio</button>
<script>
(function(){
  // schede di "YouTube concert" (KEXP / NPR Tiny Desk), ricordate tra una visita e l'altra
  var TK='latob-concerti', tabs=document.querySelectorAll('.tabs button[data-tab]'), cur=null;
  try{cur=localStorage.getItem(TK)}catch(e){}
  function showTab(id,keep){
    if(!document.getElementById(id)&&tabs.length)id=tabs[0].dataset.tab;
    tabs.forEach(function(b){var on=b.dataset.tab===id;b.setAttribute('aria-selected',on?'true':'false');document.getElementById(b.dataset.tab).hidden=!on});
    if(!keep)try{localStorage.setItem(TK,id)}catch(e){}
  }
  tabs.forEach(function(b){b.addEventListener('click',function(){showTab(b.dataset.tab)})});
  if(tabs.length)showTab(cur);

  // filtro "mostra solo": sel = fonti scelte (vuoto = tutte). Una voce può avere più fonti (album "Più recensiti").
  // Con un filtro attivo spariscono le sezioni rimaste vuote, con la loro voce nell'indice.
  var KEY='latob-filters', sel={}, onlyNew=false, ITEMS='.it,.card,.ca';
  try{var s=JSON.parse(localStorage.getItem(KEY)||'{}');sel=s.sel||{};onlyNew=!!s.onlyNew}catch(e){}
  var btns=document.querySelectorAll('.filters button[data-src]'), nb=document.getElementById('f-onlynew'), all=document.getElementById('f-all'), note=document.getElementById('fnote');
  for(var k in sel)if(!document.querySelector('.filters button[data-src="'+k+'"]'))delete sel[k]; // fonte non più presente
  btns.forEach(function(b){if(sel[b.dataset.src])sel[b.dataset.src]=b.textContent});
  var visible=function(li){return !li.hidden};
  function apply(){
    var picked=Object.keys(sel), filtering=picked.length>0||onlyNew;
    btns.forEach(function(b){b.setAttribute('aria-pressed',sel[b.dataset.src]?'true':'false')});
    nb.setAttribute('aria-pressed',onlyNew?'true':'false');
    all.hidden=!picked.length;
    document.querySelectorAll(ITEMS).forEach(function(li){
      var srcs=(li.dataset.src||'').split(' ');
      var bySrc=picked.length&&!srcs.some(function(x){return sel[x]});
      var byNew=onlyNew&&!li.classList.contains('ca')&&!li.hasAttribute('data-new'); // "Più recensiti" non ha data di novità
      li.hidden=!!(bySrc||byNew);
    });
    // se la scheda concerti aperta è rimasta vuota, si passa alla prima che ha voci (senza cambiare quella ricordata)
    var open=[].filter.call(tabs,function(b){return b.getAttribute('aria-selected')==='true'})[0];
    if(open&&![].some.call(document.getElementById(open.dataset.tab).querySelectorAll(ITEMS),visible)){
      var alt=[].filter.call(tabs,function(b){return [].some.call(document.getElementById(b.dataset.tab).querySelectorAll(ITEMS),visible)})[0];
      if(alt)showTab(alt.dataset.tab,true);
    }
    document.querySelectorAll('section.sec').forEach(function(sec){
      var show=!filtering||[].some.call(sec.querySelectorAll(ITEMS),visible);
      sec.hidden=!show;
      var a=document.querySelector('nav.toc a[href="#'+sec.id+'"]'); if(a)a.hidden=!show;
    });
    note.hidden=!picked.length;
    if(picked.length)note.textContent='Mostro solo '+picked.map(function(k){return sel[k]}).join(', ')+(onlyNew?' · solo nuovi':'')+': '+document.querySelectorAll('.it:not([hidden]),.card:not([hidden]),.ca:not([hidden])').length+' voci. Tocca di nuovo una fonte per toglierla, o «tutte le fonti».';
    try{localStorage.setItem(KEY,JSON.stringify({sel:sel,onlyNew:onlyNew}))}catch(e){}
  }
  btns.forEach(function(b){b.addEventListener('click',function(){if(sel[b.dataset.src])delete sel[b.dataset.src];else sel[b.dataset.src]=b.textContent;apply()})});
  nb.addEventListener('click',function(){onlyNew=!onlyNew;apply()});
  all.addEventListener('click',function(){sel={};apply()});
  apply();

  // pulsante "torna all'inizio" e sezione corrente evidenziata nell'indice
  var top=document.getElementById('totop'), links=document.querySelectorAll('nav.toc a');
  function onScroll(){top.hidden=window.scrollY<600}
  window.addEventListener('scroll',onScroll,{passive:true});onScroll();
  top.addEventListener('click',function(){window.scrollTo({top:0});document.querySelector('.mast h1').focus({preventScroll:true})});
  if('IntersectionObserver' in window){
    var io=new IntersectionObserver(function(es){es.forEach(function(e){if(!e.isIntersecting)return;
      links.forEach(function(a){var on=a.getAttribute('href')==='#'+e.target.id;a.setAttribute('aria-current',on?'true':'false');if(on&&a.scrollIntoView)a.parentNode.scrollTo({left:a.offsetLeft-16})})})},{rootMargin:'-30% 0px -65% 0px'});
    document.querySelectorAll('.sec').forEach(function(s){io.observe(s)});
  }
})();
</script>
`;

// l'artifact di Claude non carica immagini remote: lì le anteprime dei concerti diventano un segnaposto
IMAGES = false;
await writeFile(join(DIR, 'artifact.html'), page());
IMAGES = true;
await writeFile(join(DIR, 'lato-b.html'), `<!doctype html>\n<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n${page().replace('</style>', '</style></head><body>')}</body></html>\n`);
console.log(JSON.stringify({ items: items.length, bySection: Object.fromEntries(['dischi', 'brani', 'notizie', 'approfondimenti'].map(k => [k, items.filter(i => i.section === k).length])), aotd: aotd.length, status }, null, 1));
