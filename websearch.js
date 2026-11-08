'use strict';
/**
 * websearch.js — Recherche web profonde + livraison de fichiers.
 *
 * Pipeline :
 *   deepSearch(nom)  -> GitHub/GitLab/Codeberg/archive.org + Homebrew + moteurs + crawl -> candidats scores
 *   verifyCandidate  -> HEAD / GET Range reel : taille, type MIME, nom de fichier
 *   fetchToStore     -> telechargement stream avec plafond + SHA-256
 *
 * Aucune URL n'est inventee : chaque lien renvoye a ete reellement resolu par le serveur.
 * Version sans aucun filtre de blocage de domaines.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ---------------------------------------------------------------- extensions

const DELIVERABLE_EXT = new Set([
  '.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.xz', '.bz2',
  '.exe', '.msi', '.msix', '.appx',
  '.dmg', '.pkg',
  '.deb', '.rpm', '.appimage', '.snap',
  '.apk', '.xapk', '.jar',
  '.iso', '.img',
  '.ttf', '.otf', '.woff', '.woff2',
]);

const EXT_RE = /\.(zip|rar|7z|tar\.gz|tar\.xz|tgz|tar|gz|xz|bz2|exe|msi|msix|appx|dmg|pkg|deb|rpm|appimage|snap|apk|xapk|jar|iso|img|ttf|otf)(\?|#|$)/i;

/** Extension normalisee d'une URL ou d'un nom de fichier. */
function extOf(str) {
  const clean = String(str || '').split(/[?#]/)[0];
  const m = /\.tar\.(gz|xz|bz2)$/i.exec(clean);
  if (m) return '.tar.' + m[1].toLowerCase();
  return path.extname(clean).toLowerCase();
}

function isDeliverable(str) {
  const e = extOf(str);
  return DELIVERABLE_EXT.has(e) || e.startsWith('.tar.');
}

/** Domaines de confiance : bonus de score uniquement (pas de blocage). */
const TRUSTED_HOST_RE = /(^|\.)(github\.com|githubusercontent\.com|gitlab\.com|sourceforge\.net|fosshub\.com|archive\.org|apache\.org|mozilla\.org|videolan\.org|python\.org|nodejs\.org|kernel\.org|debian\.org|ubuntu\.com|flathub\.org|gnu\.org|gnome\.org|kde\.org|brew\.sh|ghcr\.io|fastly\.net)$/i;

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

/** Normalisation « nom de produit » : notepad++ -> notepadplusplus, C# -> csharp. */
function slugNorm(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/\+/g, 'plus')
    .replace(/#/g, 'sharp')
    .replace(/[^a-z0-9]/g, '');
}

/** Similarite de Dice sur bigrammes : 1 = identique, 0 = rien en commun. */
function diceSim(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

  const counts = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const c = counts.get(g) || 0;
    if (c > 0) { counts.set(g, c - 1); hits++; }
  }
  return (2 * hits) / (a.length + b.length - 2);
}

/**
 * Proximite entre le nom demande et un nom trouve : tolere les fautes de frappe
 * (« notepad+ », « photoshoop ») et les noms partiels (« obs » -> « obs-studio »).
 */
function nameCloseness(wanted, found) {
  if (!wanted || !found) return 0;
  if (wanted === found) return 1;
  if (found.includes(wanted) || wanted.includes(found)) {
    const ratio = Math.min(wanted.length, found.length) / Math.max(wanted.length, found.length);
    return 0.72 + 0.28 * ratio;
  }
  return diceSim(wanted, found);
}

/**
 * Noms courants mal ecrits ou abreges par les utilisateurs. Utilises en SECOND
 * essai uniquement : ils ne remplacent jamais la demande d'origine.
 */
const ALIASES = new Map(Object.entries({
  '7zip': '7-zip', '7z': '7-zip', 'sevenzip': '7-zip', 'zip7': '7-zip',
  'npp': 'notepad++', 'notepad': 'notepad++', 'notepadplus': 'notepad++',
  'vscode': 'visual studio code', 'vsc': 'visual studio code', 'vscodium': 'vscodium',
  'obs': 'obs studio', 'obsstudio': 'obs studio',
  'ff': 'firefox', 'mozilla': 'firefox',
  'chrome': 'google chrome', 'chromium': 'chromium',
  'ps': 'photoshop', 'pshop': 'photoshop', 'photoshop': 'gimp',
  'illustrator': 'inkscape', 'premiere': 'shotcut', 'aftereffects': 'blender',
  'rar': 'winrar', 'unrar': '7-zip',
  'torrent': 'qbittorrent', 'utorrent': 'qbittorrent', 'bittorrent': 'qbittorrent',
  'py': 'python', 'node': 'nodejs', 'nodejs': 'node.js',
  'java': 'temurin', 'jdk': 'temurin',
  'ide': 'vscodium', 'editeur': 'notepad++', 'editor': 'notepad++',
  'antivirus': 'clamav', 'nettoyage': 'bleachbit', 'ccleaner': 'bleachbit',
  'compresseurvideo': 'handbrake', 'compression': '7-zip',
  'montagevideo': 'shotcut', 'montage': 'shotcut',
  'retouchephoto': 'gimp', 'retouche': 'gimp', 'dessin': 'krita',
  'musique': 'audacity', 'audio': 'audacity', 'son': 'audacity',
  'lecteurvideo': 'vlc', 'lecteur': 'vlc', 'mediaplayer': 'vlc',
  'bureautique': 'libreoffice', 'office': 'libreoffice', 'word': 'libreoffice',
  'excel': 'libreoffice', 'pdf': 'pdfsam', 'ftp': 'filezilla',
  'ssh': 'putty', 'terminal': 'windows terminal', 'vpn': 'wireguard',
  'emulateur': 'retroarch', 'machinevirtuelle': 'virtualbox', 'vm': 'virtualbox',
  'gravure': 'imgburn', 'cle usb': 'rufus', 'usb': 'rufus', 'iso': 'rufus',
  'screenshot': 'sharex', 'capture': 'sharex', 'enregistrement': 'obs studio',
  'modele3d': 'blender', '3d': 'blender', 'cao': 'freecad',
}));

/**
 * Construit la liste des noms a essayer, du plus probable au plus large.
 * On tente d'abord ce que l'utilisateur a ecrit, puis les alias, puis le brut.
 */
function candidateNames(rawQuery, parsedName) {
  const out = [];
  const add = (n) => {
    const v = String(n || '').trim();
    if (v.length >= 2 && !out.some(x => x.toLowerCase() === v.toLowerCase())) out.push(v);
  };

  add(parsedName);

  const key = slugNorm(parsedName);
  if (ALIASES.has(key)) add(ALIASES.get(key));
  else {
    let bestKey = '', bestSim = 0;
    for (const k of ALIASES.keys()) {
      if (k.length < 4) continue;
      const sim = nameCloseness(key, k);
      if (sim > bestSim) { bestSim = sim; bestKey = k; }
    }
    if (bestSim >= 0.8) { add(bestKey); add(ALIASES.get(bestKey)); }
  }

  for (const word of slugWords(parsedName)) {
    if (ALIASES.has(word)) add(ALIASES.get(word));
  }

  const words = String(parsedName || '').split(/\s+/).filter(Boolean);
  if (words.length > 2) add(words.slice(0, -1).join(' '));
  if (words.length > 1) add(words[0]);

  add(String(rawQuery || '').replace(/[^\p{L}\p{N}+#. -]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60));
  return out.slice(0, 4);
}

function slugWords(str) {
  return String(str || '').toLowerCase().split(/[^a-z0-9+]+/).filter(w => w.length >= 2).map(slugNorm);
}

/** Nom normalise du depot pour une URL GitHub/GitLab, sinon ''. */
function repoOf(url) {
  const m = /(?:github|gitlab)\.com\/([^/]+)\/([^/?#]+)/i.exec(String(url || ''));
  return m ? slugNorm(m[2].replace(/\.git$/, '')) : '';
}

/** Cle de regroupement pour la diversite : le depot pour GitHub, sinon le domaine. */
function groupKey(url) {
  const repo = repoOf(url);
  return repo ? hostOf(url) + '/' + repo : hostOf(url);
}

// ---------------------------------------------------------------- HTTP utils

async function httpGet(url, { timeout = 12000, headers = {}, redirect = 'follow', method = 'GET' } = {}) {
  return fetch(url, {
    method,
    redirect,
    signal: AbortSignal.timeout(timeout),
    headers: { 'User-Agent': UA, 'Accept-Language': 'fr,en;q=0.8', ...headers },
  });
}

async function httpText(url, opts = {}) {
  try {
    const r = await httpGet(url, opts);
    if (!r.ok) return '';
    const ct = r.headers.get('content-type') || '';
    if (!/text\/|json|xml/i.test(ct)) return '';
    return await r.text();
  } catch { return ''; }
}

// ---------------------------------------------------------------- moteurs

/** Deplie les redirections DuckDuckGo (/l/?uddg=...). */
function unwrapDdg(href) {
  if (!href) return '';
  let u = href.startsWith('//') ? 'https:' + href : href;
  const m = /[?&]uddg=([^&]+)/.exec(u);
  if (m) { try { u = decodeURIComponent(m[1]); } catch (_) {} }
  return u.startsWith('http') ? u : '';
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

/** Decode les liens de redirection Bing (/ck/a?...&u=a1<base64url>). */
function unwrapBing(href) {
  const m = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(href);
  if (!m) return href;
  try {
    return Buffer.from(m[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch (_) { return href; }
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Page de defi anti-robot ou coquille vide : inutile d'essayer de la lire. */
function isChallengePage(html) {
  if (!html || html.length < 800) return true;
  // DuckDuckGo rend son captcha en HTTP 202 avec une vraie page : sans ces
  // formulations, le lot etait parse comme un resultat et le repli generique
  // remontait les liens du captcha lui-meme.
  return /captcha|unusual traffic|are you a (robot|human)|challenge-platform|enable javascript to continue/i
    .test(html.slice(0, 5000))
    || /complete the following challenge|made by a human|bots use duckduckgo|verify you are (a )?human|too many requests|access denied|anomal(y|ous) (traffic|activity)/i
      .test(html.slice(0, 5000));
}

/**
 * Bing : chaque resultat est un <li class="b_algo"> contenant <h2><a href>.
 * Extraire les href de toute la page ramenait les feuilles de style, les cartes
 * dictionnaire et les recherches associees — d'ou des resultats hors sujet.
 */
function parseBing(html) {
  const out = [];
  for (const block of html.split(/<li class="b_algo"/i).slice(1)) {
    const a = /<h2[^>]*>\s*(?:<[^>]+>\s*)*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!a) continue;
    const url = unwrapBing(decodeEntities(a[1]));
    if (!/^https?:\/\//i.test(url)) continue;
    const p = /<p[^>]*>([\s\S]{0,600}?)<\/p>/i.exec(block);
    out.push({
      url,
      title: stripTags(a[2]).slice(0, 160),
      snippet: p ? stripTags(p[1]).slice(0, 300) : '',
    });
  }
  return out;
}

/** DuckDuckGo HTML et Lite : liens de resultat identifies par leur classe. */
function parseDdg(html) {
  const out = [];
  const re = /<a[^>]+class="[^"]*(?:result__a|result-link)[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 20) {
    const url = unwrapDdg(decodeEntities(m[1]));
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({ url, title: stripTags(m[2]).slice(0, 160), snippet: '' });
  }
  return out;
}

/** Mojeek : <a class="ob" href> sur le titre de chaque resultat. */
function parseMojeek(html) {
  const out = [];
  const re = /<a[^>]+class="[^"]*ob[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 20) {
    const url = decodeEntities(m[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({ url, title: stripTags(m[2]).slice(0, 160), snippet: '' });
  }
  return out;
}

/** Repli quand le balisage d'un moteur a change : tous les liens sortants. */
function parseGeneric(html, engineHost) {
  const out = [];
  const seen = new Set();
  const re = /href="(https?:\/\/[^"]+|\/ck\/a\?[^"]+)"/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 30) {
    let url = decodeEntities(m[1]);
    if (url.startsWith('/ck/a?')) url = unwrapBing('https://www.bing.com' + url);
    else url = unwrapDdg(unwrapBing(url));
    if (!/^https?:\/\//i.test(url)) continue;
    const h = hostOf(url);
    if (!h || h === engineHost || PORTAL_HOST_RE.test(h)) continue;
    const key = url.split(/[?#]/)[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, title: '', snippet: '' });
  }
  return out;
}

const ENGINES = [
  { name: 'bing', url: (q) => 'https://www.bing.com/search?q=' + q + '&setlang=fr', parse: parseBing },
  { name: 'ddg-html', url: (q) => 'https://html.duckduckgo.com/html/?q=' + q, parse: parseDdg },
  { name: 'ddg-lite', url: (q) => 'https://lite.duckduckgo.com/lite/?q=' + q, parse: parseDdg },
  { name: 'mojeek', url: (q) => 'https://www.mojeek.com/search?q=' + q, parse: parseMojeek },
];

/** Moteurs et portails : des passages, jamais des reponses. Une page d'accueil
 *  de moteur lue comme source ne contient que des menus, et le modele en
 *  concluait qu'il n'avait rien trouve. */
const PORTAL_HOST_RE = /(^|\.)(bing\.com|duckduckgo\.com|mojeek\.com|microsoft\.com|msn\.com|google\.[a-z]{2,3}(\.[a-z]{2,3})?|googleusercontent\.com|gstatic\.com|googleadservices\.com|yahoo\.[a-z]{2,3}(\.[a-z]{2,3})?|ecosia\.org|qwant\.com|startpage\.com|brave\.com|yandex\.[a-z]{2,3}(\.[a-z]{2,3})?|baidu\.com|ask\.com|aol\.com)$/i;

/** Ecarte les liens qui ne sont pas des resultats (moteur lui-meme, redirections). */
function usableHits(hits, engineHost) {
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    const host = hostOf(h.url);
    if (!host || host === engineHost) continue;
    if (PORTAL_HOST_RE.test(host)) continue;
    const key = h.url.split(/[?#]/)[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

async function engineHits(engine, q, timeout) {
  const url = engine.url(q);
  const html = await httpText(url, { timeout });
  if (!html || isChallengePage(html)) return [];

  const host = hostOf(url);
  const hits = usableHits(engine.parse(html), host);
  // Le balisage du moteur a change : on rabat sur tous les liens sortants.
  if (hits.length >= 3) return hits;
  const generique = usableHits(parseGeneric(html, host), host);
  return generique.length > hits.length ? generique : hits;
}

/** Alterne les listes au lieu de les concatener : chaque moteur garde son
 *  premier resultat en tete du melange. */
function interleave(listes) {
  const vues = new Map();
  const out = [];
  const profondeur = Math.max(0, ...listes.map(l => l.length));
  for (let rang = 0; rang < profondeur; rang++) {
    for (const liste of listes) {
      const h = liste[rang];
      if (!h || !h.url) continue;
      const cle = h.url.split(/[?#]/)[0].toLowerCase();
      // Un lien rendu par plusieurs moteurs n'est pas un doublon a jeter : la
      // convergence est le meilleur signal gratuit de qualite d'une adresse.
      // On la compte au lieu de la perdre.
      const deja = vues.get(cle);
      if (deja) { deja.vus = (deja.vus || 1) + 1; continue; }
      const garde = { ...h, vus: 1 };
      vues.set(cle, garde);
      out.push(garde);
    }
  }
  return out;
}

/**
 * Recherche web sans cle API. Les moteurs se completent plus qu'ils ne se
 * remplacent : sur « Notion open source alternative », Bing rend la page
 * d'accueil de Notion, son login et son signup, quand DuckDuckGo rend les
 * comparatifs. On interroge donc les deux principaux en parallele et on
 * entrelace, au lieu de garder le premier qui repond ; les suivants ne servent
 * que si ce melange est vide. Renvoie { url, title, snippet }.
 */
async function webSearch(query, timeout) {
  const q = encodeURIComponent(query);
  const paralleles = await Promise.all(
    ENGINES.slice(0, 2).map(e => engineHits(e, q, timeout).catch(() => []))
  );
  const fusion = interleave(paralleles);
  if (fusion.length >= 3) return fusion;

  let meilleur = fusion;
  for (const engine of ENGINES.slice(2)) {
    const hits = await engineHits(engine, q, timeout).catch(() => []);
    if (hits.length >= 3) return interleave([hits, fusion]);
    if (hits.length > meilleur.length) meilleur = hits;
  }
  // Un moteur qui ne rend qu'un ou deux liens vidait la recherche entiere :
  // on cherche mieux ailleurs, mais on garde le meilleur lot trouve.
  return meilleur;
}

/**
 * Lit une page et en extrait le texte utile, pour donner au modele de la
 * matiere fraiche plutot que sa memoire d'entrainement.
 *
 * On retire d'abord scripts, styles, navigation et pieds de page : sans ca,
 * la moitie du texte extrait serait des menus et des mentions legales.
 */
/** Reseaux sociaux, regies, boutons de partage, moteurs : presents sur toutes
 *  les pages, jamais la reponse a « quel site pour X ? ». */
const HOTES_BRUIT = /^(www\.)?(facebook|fb|twitter|x|t|instagram|linkedin|pinterest|tiktok|snapchat|whatsapp|telegram|vk|mastodon|bsky|threads|youtube|youtu|vimeo|dailymotion|twitch|discord|google|googletagmanager|googleapis|gstatic|doubleclick|googleadservices|bing|duckduckgo|qwant|ecosia|yandex|baidu|paypal|stripe|patreon|buymeacoffee|ko-fi|liberapay|apple|adobe|cloudflare|gravatar|wordpress|blogger|feedburner|creativecommons|w3|schema|addtoany|sharethis|outbrain|taboola|amazon-adsystem)\./i;

/** Ancres qui ne nomment rien : le nom du site vaut mieux que « cliquez ici ». */
const ANCRE_VIDE = /^(ici|la|here|link|lien|source|sources?|site|website|www|read more|lire la suite|en savoir plus|voir|view|click|cliquez|suite|more|\W*|\d+)$/i;

/**
 * Les liens SORTANTS d'une page, avec leur ancre.
 *
 * C'est la correction d'un travers du montage precedent : sur « quels sites
 * pour X ? », les moteurs rendent l'article qui recense les sites, jamais les
 * sites eux-memes. Le modele citait donc l'adresse du recensement. Les vraies
 * adresses sont dans la page, dans ses liens — on les recolte ici.
 *
 * On travaille sur le HTML deja debarrasse de sa navigation, on jette ce qui
 * pointe vers l'hote courant (menu interne) et on ne garde qu'un lien par hote,
 * le premier : dans un classement, c'est celui de la recommandation.
 */
function extractOutlinks(html, baseUrl, max = 40) {
  let hoteBase = '';
  try { hoteBase = new URL(baseUrl).hostname.replace(/^www\./i, ''); } catch (_) { return []; }

  const vus = new Set();
  const out = [];
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < max) {
    const brut = m[1].trim();
    if (!/^https?:\/\//i.test(brut)) continue;

    let u;
    try { u = new URL(brut); } catch (_) { continue; }
    const hote = u.hostname.replace(/^www\./i, '');
    if (!hote || hote === hoteBase || hote.endsWith('.' + hoteBase)) continue;
    if (HOTES_BRUIT.test(u.hostname)) continue;
    if (vus.has(hote)) continue;
    vus.add(hote);

    // Les traceurs de campagne ne servent qu'a l'editeur de la page.
    u.hash = '';
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref|source|campaign)/i.test(p)) u.searchParams.delete(p);
    }

    const ancre = decodeEntities(stripTags(m[2]))
      .replace(/\s+/g, ' ')
      // « AppFlowy website », « Logseq site officiel » : le suffixe vient du
      // gabarit de la page, le nom du site est ce qui le precede.
      .replace(/\s+(web ?site|homepage|site officiel|site web|officiel|home)$/i, '')
      .trim().slice(0, 120);
    out.push({
      url: u.toString(),
      title: (!ancre || ANCRE_VIDE.test(ancre)) ? hote : ancre,
      depuisPage: true,
    });
  }
  return out;
}

async function fetchPageText(url, { timeout = 9000, maxChars = 4000, withLinks = false } = {}) {
  const vide = withLinks ? { texte: '', liens: [] } : '';
  const html = await httpText(url, { timeout });
  if (!html || isChallengePage(html)) return vide;

  const corps = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ')
    // Les sauts de bloc deviennent des retours a la ligne : le texte reste lisible
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');

  // Les liens se lisent avant le desossage des balises, sur un corps deja
  // debarrasse de sa navigation : ce qui reste est cite dans le contenu.
  const liens = withLinks ? extractOutlinks(corps, url) : [];

  const texte = decodeEntities(corps.replace(/<[^>]+>/g, ' '))
    .split('\n')
    .map(l => l.replace(/[ \t]+/g, ' ').trim())
    // Les lignes tres courtes sont presque toujours des restes de menu
    .filter(l => l.length > 40)
    .join('\n')
    .slice(0, maxChars);

  return withLinks ? { texte, liens } : texte;
}

/** Recherche GitHub Releases : la source la plus fiable et structuree. */
async function githubReleases(name, timeout) {
  const results = [];
  const q = encodeURIComponent(name);
  const headers = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;

  const searchJson = await httpText(
    'https://api.github.com/search/repositories?q=' + q + '&sort=stars&order=desc&per_page=5',
    { timeout, headers }
  );
  if (!searchJson) return results;

  let repos = [];
  try { repos = (JSON.parse(searchJson).items || []).slice(0, 5); } catch (_) { return results; }

  const wanted = slugNorm(name);
  const maxStars = Math.max(1, ...repos.map(r => r.stargazers_count || 0));
  const scoredRepos = repos
    .map(repo => {
      const byName = nameCloseness(wanted, slugNorm(repo.name));
      const byFull = nameCloseness(wanted, slugNorm(String(repo.full_name || '').split('/').pop()));
      const inDesc = slugNorm(repo.description).includes(wanted) && wanted.length >= 4 ? 0.55 : 0;
      const nameMatch = Math.max(byName, byFull, inDesc);
      const pop = Math.log10((repo.stargazers_count || 0) + 1) / Math.log10(maxStars + 1);
      const archived = repo.archived ? -0.15 : 0;
      return { repo, nameMatch, rank: nameMatch * 0.7 + pop * 0.3 + archived };
    })
    .filter(r => wanted.length < 3 || r.nameMatch >= 0.4)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 3);

  for (const { repo } of scoredRepos) {
    const before = results.length;
    let releases = [];
    const latestJson = await httpText(
      'https://api.github.com/repos/' + repo.full_name + '/releases/latest',
      { timeout, headers }
    );
    if (latestJson) {
      try {
        const latest = JSON.parse(latestJson);
        if (latest && latest.assets) releases.push(latest);
      } catch (_) {}
    }
    if (!releases.length) {
      const relJson = await httpText(
        'https://api.github.com/repos/' + repo.full_name + '/releases?per_page=5',
        { timeout, headers }
      );
      if (relJson) {
        try {
          const all = JSON.parse(relJson);
          if (Array.isArray(all)) releases = all.filter(r => r && !r.draft && !r.prerelease);
        } catch (_) {}
      }
    }

    for (const rel of releases.slice(0, 2)) {
      for (const asset of (rel.assets || [])) {
        if (!isDeliverable(asset.name)) continue;
        results.push({
          url: asset.browser_download_url,
          filename: asset.name,
          size: asset.size,
          source: 'github',
          origin: 'github.com/' + repo.full_name,
          version: rel.tag_name || '',
          stars: repo.stargazers_count || 0,
        });
      }
      if (results.length >= 30) break;
    }

    // Beaucoup d'outils n'ont aucune release exploitable : scripts Python,
    // projets livres en l'etat, releases sans binaire. Le depot lui-meme reste
    // un livrable legitime — sans cette reprise, ces projets sortaient
    // introuvables alors que GitHub les avait bien renvoyes.
    if (results.length === before) {
      const branch = repo.default_branch || 'main';
      results.push({
        url: 'https://github.com/' + repo.full_name + '/archive/refs/heads/' + branch + '.zip',
        filename: repo.name + '-' + branch + '.zip',
        size: 0,
        source: 'github',
        kind: 'source',
        origin: 'github.com/' + repo.full_name,
        version: branch,
        stars: repo.stargazers_count || 0,
      });
    }
    if (results.length >= 30) break;
  }
  return results;
}

/* ------------------------------------------------- sources supplementaires

   GitHub seul laisse de cote tout ce qui n'y a jamais ete : logiciels
   abandonnes, vieilles versions, projets partis ailleurs. Les sources
   ci-dessous ont ete retenues parce qu'elles repondent reellement a un client
   non-navigateur — SourceForge et F-Droid renvoient 403 ou refusent la
   connexion, inutile de les interroger.
--------------------------------------------------------------------------- */

/**
 * Internet Archive : la meilleure source pour ce qui ne se trouve plus.
 * La recherche est restreinte au titre ET au type "software", sinon une
 * requete comme « winamp » remonte des skins et des jeux sans rapport.
 */
async function archiveOrgFiles(name, timeout) {
  const results = [];
  const q = encodeURIComponent(`title:("${String(name).replace(/"/g, '')}") AND mediatype:(software)`);
  const url = 'https://archive.org/advancedsearch.php?q=' + q
    + '&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=downloads'
    + '&sort%5B%5D=downloads+desc&rows=4&page=1&output=json';

  const brut = await httpText(url, { timeout });
  if (!brut) return results;

  let docs = [];
  try { docs = (JSON.parse(brut).response || {}).docs || []; } catch (_) { return results; }

  for (const doc of docs.slice(0, 3)) {
    const metaBrut = await httpText('https://archive.org/metadata/' + encodeURIComponent(doc.identifier), { timeout });
    if (!metaBrut) continue;

    let meta = null;
    try { meta = JSON.parse(metaBrut); } catch (_) { continue; }

    const fichiers = (meta.files || [])
      .filter(f => f && f.name && isDeliverable(f.name))
      .sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0));

    for (const f of fichiers.slice(0, 3)) {
      results.push({
        url: 'https://archive.org/download/' + encodeURIComponent(doc.identifier) + '/' + encodeURIComponent(f.name),
        filename: f.name,
        size: Number(f.size) || 0,
        source: 'archive',
        origin: 'archive.org/details/' + doc.identifier,
        version: '',
        text: doc.title || '',
      });
    }
    if (results.length >= 12) break;
  }
  return results;
}

/** Depots GitLab : beaucoup de projets libres n'ont jamais migre vers GitHub. */
async function gitlabReleases(name, timeout) {
  const results = [];
  const url = 'https://gitlab.com/api/v4/projects?search=' + encodeURIComponent(name)
    + '&order_by=star_count&sort=desc&per_page=3';

  const brut = await httpText(url, { timeout });
  if (!brut) return results;

  let projets = [];
  try { projets = JSON.parse(brut); } catch (_) { return results; }
  if (!Array.isArray(projets)) return results;

  const voulu = slugNorm(name);
  for (const p of projets.slice(0, 3)) {
    if (!p || !p.id) continue;
    if (voulu.length >= 3 && nameCloseness(voulu, slugNorm(p.name)) < 0.4) continue;

    const relBrut = await httpText(
      'https://gitlab.com/api/v4/projects/' + p.id + '/releases?per_page=2', { timeout }
    );
    let releases = [];
    try { releases = JSON.parse(relBrut || '[]'); } catch (_) { releases = []; }

    let ajoutes = 0;
    for (const rel of (Array.isArray(releases) ? releases : []).slice(0, 2)) {
      for (const lien of (rel.assets && rel.assets.links) || []) {
        if (!lien.url || !isDeliverable(lien.url)) continue;
        results.push({
          url: lien.url,
          filename: lien.name || path.basename(String(lien.url).split(/[?#]/)[0]),
          size: 0,
          source: 'gitlab',
          origin: 'gitlab.com/' + (p.path_with_namespace || p.name),
          version: rel.tag_name || '',
          stars: p.star_count || 0,
        });
        ajoutes++;
      }
    }

    // Meme repli que sur GitHub : sans release exploitable, l'archive du depot
    if (!ajoutes && p.path_with_namespace) {
      const branche = p.default_branch || 'main';
      results.push({
        url: `https://gitlab.com/${p.path_with_namespace}/-/archive/${branche}/${p.path}-${branche}.zip`,
        filename: `${p.path}-${branche}.zip`,
        size: 0,
        source: 'gitlab',
        kind: 'source',
        origin: 'gitlab.com/' + p.path_with_namespace,
        version: branche,
        stars: p.star_count || 0,
      });
    }
  }
  return results;
}

/** Codeberg (Gitea) : refuge d'une partie des projets libres. */
async function codebergReleases(name, timeout) {
  const results = [];
  const brut = await httpText(
    'https://codeberg.org/api/v1/repos/search?q=' + encodeURIComponent(name) + '&limit=3', { timeout }
  );
  if (!brut) return results;

  let depots = [];
  try { depots = (JSON.parse(brut) || {}).data || []; } catch (_) { return results; }

  const voulu = slugNorm(name);
  for (const d of depots.slice(0, 3)) {
    if (!d || !d.full_name) continue;
    if (voulu.length >= 3 && nameCloseness(voulu, slugNorm(d.name)) < 0.4) continue;

    const relBrut = await httpText(
      'https://codeberg.org/api/v1/repos/' + d.full_name + '/releases?limit=2', { timeout }
    );
    let releases = [];
    try { releases = JSON.parse(relBrut || '[]'); } catch (_) { releases = []; }

    let ajoutes = 0;
    for (const rel of (Array.isArray(releases) ? releases : []).slice(0, 2)) {
      for (const a of rel.assets || []) {
        if (!a.browser_download_url || !isDeliverable(a.name || a.browser_download_url)) continue;
        results.push({
          url: a.browser_download_url,
          filename: a.name || '',
          size: a.size || 0,
          source: 'codeberg',
          origin: 'codeberg.org/' + d.full_name,
          version: rel.tag_name || '',
          stars: d.stars_count || 0,
        });
        ajoutes++;
      }
    }

    if (!ajoutes) {
      const branche = d.default_branch || 'main';
      results.push({
        url: `https://codeberg.org/${d.full_name}/archive/${branche}.zip`,
        filename: `${d.name}-${branche}.zip`,
        size: 0,
        source: 'codeberg',
        kind: 'source',
        origin: 'codeberg.org/' + d.full_name,
        version: branche,
        stars: d.stars_count || 0,
      });
    }
  }
  return results;
}

/** Extrait les liens de telechargement direct d'une page HTML. */
function extractFileLinks(html, baseUrl) {
  const found = [];
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && found.length < 60) {
    const href = decodeEntities(m[1]).trim();
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) continue;
    let abs;
    try { abs = new URL(href, baseUrl).toString(); } catch (_) { continue; }
    if (!EXT_RE.test(abs)) continue;
    found.push({
      url: abs,
      filename: decodeURIComponent(path.basename(abs.split(/[?#]/)[0])),
      text: decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim().slice(0, 120),
    });
  }
  return found;
}

/**
 * Repere les pages « Download / Telecharger / Releases » d'un site.
 */
function extractDownloadPages(html, baseUrl, nameNorm) {
  const baseHost = hostOf(baseUrl);
  const found = [];
  const seen = new Set();
  const re = /<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && found.length < 6) {
    const href = decodeEntities(m[1]).trim();
    if (!href || /^(javascript|mailto|tel):/i.test(href)) continue;
    let abs;
    try { abs = new URL(href, baseUrl).toString(); } catch (_) { continue; }
    if (!/^https?:/i.test(abs) || EXT_RE.test(abs)) continue;
    if (seen.has(abs)) continue;

    const text = m[2].replace(/<[^>]+>/g, ' ');
    const looksLikeDownload = /download|telecharg|télécharg|releases?|latest|\/get[/.]|\/dl\//i.test(abs + ' ' + text);
    if (!looksLikeDownload) continue;

    const h = hostOf(abs);
    const sameSite = h === baseHost
      || h.endsWith('.' + baseHost.replace(/^www\./, ''))
      || baseHost.endsWith('.' + h.replace(/^www\./, ''))
      || (nameNorm.length >= 3 && h.replace(/[^a-z0-9]/g, '').includes(nameNorm))
      || /github\.com|sourceforge\.net/i.test(h);
    if (!sameSite) continue;

    seen.add(abs);
    found.push(abs);
  }
  return found;
}

// ---------------------------------------------------------------- scoring

const OS_HINTS = {
  windows: [/win(dows)?/i, /\.exe$/i, /\.msi$/i, /\.msix$/i],
  macos: [/mac(os)?|osx|darwin/i, /\.dmg$/i, /\.pkg$/i],
  linux: [/linux|ubuntu|debian|fedora/i, /\.appimage$/i, /\.deb$/i, /\.rpm$/i, /\.tar\.(gz|xz)$/i],
  android: [/android/i, /\.apk$/i],
};

const OS_EXCLUSIVE = {
  windows: /\.(dmg|pkg|deb|rpm|appimage|apk)(\?|#|$)/i,
  macos: /\.(exe|msi|msix|deb|rpm|appimage|apk)(\?|#|$)/i,
  linux: /\.(exe|msi|msix|dmg|pkg|apk)(\?|#|$)/i,
  android: /\.(exe|msi|dmg|pkg|deb|rpm|appimage)(\?|#|$)/i,
};

function scoreCandidate(cand, { name, os, arch }) {
  const url = cand.url;
  const host = hostOf(url);
  const file = (cand.filename || '') + ' ' + (cand.text || '');
  const nameNorm = slugNorm(name);
  const fileNorm = slugNorm(file);
  let s = 0;

  if (cand.source === 'github') s += 30;
  // Les gestionnaires de paquets ont resolu le logiciel PAR SON NOM : leur URL
  // est l'installateur officiel, pas un resultat a departager. Sans ce bonus,
  // le .dmg exact de Homebrew se faisait noyer sous les paquets de langue et
  // les forks trouves sur GitHub ou archive.org.
  if (cand.source === 'brew-cask') s += 95;
  else if (cand.source === 'brew-formula') s += 70;
  if (TRUSTED_HOST_RE.test(host)) s += 30;
  if (/\/(releases|download|downloads|dist|files)\//i.test(url)) s += 12;

  const repoNorm = repoOf(url);
  if (repoNorm && nameNorm.length >= 3) {
    const close = nameCloseness(nameNorm, repoNorm);
    if (repoNorm === nameNorm) s += 50;
    else if (repoNorm.startsWith(nameNorm)) s += 15;
    else if (close >= 0.6) s += Math.round(close * 20);
  }

  const originNorm = cand.source === 'page' ? slugNorm(cand.origin) : '';
  if (nameNorm.length >= 3 && originNorm.includes(nameNorm)) s += 45;

  if (nameNorm.length >= 3 && host.replace(/[^a-z0-9]/g, '').includes(nameNorm)) s += 50;

  if (nameNorm.length >= 3) {
    if (fileNorm.includes(nameNorm)) s += 25;
    else {
      const closest = Math.max(0, ...slugWords(file).map(w => nameCloseness(nameNorm, w)));
      if (closest >= 0.6) s += Math.round(closest * 18);
    }
  }

  const hints = OS_HINTS[os] || [];
  if (hints.some(re => re.test(file) || re.test(url))) s += 20;
  const excl = OS_EXCLUSIVE[os];
  if (excl && (excl.test(cand.filename || '') || excl.test(url))) s -= 60;

  const both = file + ' ' + url;
  if (arch === 'x64' && /(x64|amd64|win64|x86[_-]64|64[-_ ]?bits?)/i.test(both)) s += 15;
  if (arch === 'arm64' && /(arm64|aarch64|apple[-_]?silicon)/i.test(both)) s += 15;
  if (arch === 'x64' && /(arm64|aarch64|i386|ia32|win32|32[-_ ]?bits?)/i.test(both)) s -= 30;
  if (arch === 'x86' && /(32[-_ ]?bits?|win32|i386|x86)/i.test(both)) s += 15;

  if (/(beta|alpha|nightly|rc\d|preview|debug|symbols|pdbs?\b|\.pdb)/i.test(file)) s -= 40;
  if (/(source|src)[-_.]?(code)?\.(zip|tar\.gz)$/i.test(cand.filename || '')) s -= 20;
  if (/(checksum|sha256|sha512|\.sig|\.asc)$/i.test(cand.filename || '')) s -= 80;

  // Le depot brut depanne quand le projet ne publie aucun binaire, mais une
  // release officielle reste preferable quand elle existe.
  if (cand.kind === 'source') s -= 12;

  if (cand.stars) s += Math.min(15, Math.log10(cand.stars + 1) * 5);

  const v = versionScore(cand.version) || versionScore(cand.filename);
  if (v) s += Math.min(8, v);

  return s;
}

function versionScore(str) {
  const m = /(\d+)(?:[._](\d+))?(?:[._](\d+))?/.exec(String(str || ''));
  if (!m) return 0;
  const major = Math.min(99, parseInt(m[1], 10) || 0);
  const minor = Math.min(99, parseInt(m[2], 10) || 0);
  const patch = Math.min(99, parseInt(m[3], 10) || 0);
  return (major + minor / 100 + patch / 10000) / 20;
}

// ---------------------------------------------------------------- cadrage

function parseTarget(query) {
  const q = String(query || '').toLowerCase();
  let os = null;
  if (/\bmac(os)?\b|osx|macbook|imac|apple silicon/.test(q)) os = 'macos';
  else if (/\blinux\b|ubuntu|debian|fedora|arch\b|mint\b/.test(q)) os = 'linux';
  else if (/\bandroid\b|\bapk\b|telephone|téléphone|mobile/.test(q)) os = 'android';
  else if (/\bwin(dows)?\b|\.exe\b|\bmsi\b/.test(q)) os = 'windows';

  // Aucun systeme cite mais des marqueurs de projet multiplateforme : forcer
  // windows ferait remonter des installeurs .exe qui n'existent pas.
  if (!os) {
    os = /\b(python|script|node|java|source|sources|depot|dépôt|repo|github|gitlab|multiplateforme|cross[- ]?platform)\b/.test(q)
      ? 'any'
      : 'windows';
  }

  let arch = 'x64';
  if (/\barm64\b|aarch64|apple silicon|\bm1\b|\bm2\b|\bm3\b/.test(q)) arch = 'arm64';
  else if (/\b32\s?bits?\b|x86\b|i386/.test(q)) arch = 'x86';

  return { os, arch };
}

const FILLER_WORDS = new Set([
  'salut', 'slt', 'hey', 'coucou', 'bonjour', 'stp', 'svp', 'please', 'merci',
  'frere', 'frère', 'mec', 'bro', 'dis', 'alors', 'pas', 'nn', 'non', 'ya', 'hein',
  'taurais', 'tas', 'aurais', 'est', 'ce', 'que', 'as',
  'donne', 'donnes', 'donner', 'envoie', 'envoi', 'envoies', 'envoyer', 'file',
  'files', 'passe', 'balance', 'refile', 'fournis', 'montre', 'choper', 'chope',
  'je', 'jai', 'tu', 'il', 'me', 'te', 'moi', 'toi', 'veux', 'voudrais', 'aimerais',
  'cherche', 'recherche', 'faut', 'besoin', 'peux', 'pourrais', 'peut',
  'ou', 'trouver', 'telecharger', 'télécharger', 'dl', 'download', 'installer',
  'install', 'installe', 'lien', 'liens', 'url', 'link', 'direct',
  'derniere', 'dernière', 'last', 'latest', 'version', 'maj', 'derniers', 'dernier',
  'logiciel', 'logiciels', 'soft', 'software', 'programme', 'application', 'appli',
  'outil', 'outils', 'tool', 'utilitaire', 'fichier', 'setup',
  'un', 'une', 'le', 'la', 'les', 'des', 'du', 'de', 'pour', 'avec', 'sur', 'en',
  'et', 'a', 'à', 'ce', 'cette', 'truc', 'chose', 'genre',
  'windows', 'win', 'macos', 'mac', 'osx', 'linux', 'ubuntu', 'debian', 'android',
  'x64', 'x86', 'arm64', 'bits', 'bit', 'portable', 'gratuit', 'free', 'complet', 'full',
]);

function isFiller(word) {
  const w = word.toLowerCase();
  if (FILLER_WORDS.has(w)) return true;
  if (w.length >= 5) {
    for (const f of FILLER_WORDS) {
      if (f.length >= 5 && Math.abs(f.length - w.length) <= 2 && nameCloseness(w, f) >= 0.82) return true;
    }
  }
  return false;
}

function parseToolName(query) {
  const cleaned = String(query || '')
    .toLowerCase()
    .replace(/\b(t'aurais|tu aurais|t'as|tu as|est ce que|est-ce que|aurais tu|as tu|j'ai)\b/g, ' ')
    .replace(/[?!.,;:«»"'()[\]]/g, ' ');

  const kept = cleaned
    .split(/\s+/)
    .filter(w => w && !isFiller(w));

  return kept.join(' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

// ---------------------------------------------------------------- verification

async function resolveMirrorRedirect(url, timeout) {
  const html = await httpText(url, { timeout });
  if (!html) return '';

  const meta = /<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'>\s]+)/i.exec(html);
  if (meta) {
    try { return new URL(decodeEntities(meta[1]), url).toString(); } catch (_) {}
  }
  const js = /location\.(?:href|replace)\s*\(?\s*=?\s*["']([^"']+)["']/i.exec(html);
  if (js) {
    try { return new URL(decodeEntities(js[1]), url).toString(); } catch (_) {}
  }
  const base = path.basename(url.split(/[?#]/)[0]);
  if (base.length > 4) {
    const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const a = new RegExp('href=["\']([^"\']*' + esc + '[^"\']*)["\']', 'i').exec(html);
    if (a) {
      try { return new URL(decodeEntities(a[1]), url).toString(); } catch (_) {}
    }
  }
  return '';
}

/** Verifie qu'une URL pointe bien sur un fichier telechargeable reel. */
async function verifyCandidate(cand, { timeout = 12000, depth = 0, retries = 1 } = {}) {
  const probe = (method, extra) => httpGet(cand.url, {
    timeout: timeout + extra,
    method,
    redirect: 'follow',
    headers: method === 'GET' ? { Range: 'bytes=0-0' } : {},
  });

  let res = null;
  for (let attempt = 0; attempt <= retries && !res; attempt++) {
    const extra = attempt * 6000;
    try {
      const r = await probe('HEAD', extra);
      if (r && r.ok) res = r;
    } catch (_) {}
    if (!res) {
      try {
        const r = await probe('GET', extra);
        if (r && (r.ok || r.status === 206)) res = r;
      } catch (_) {}
    }
  }
  if (!res || (!res.ok && res.status !== 206)) return null;

  const finalUrl = res.url || cand.url;

  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (/text\/html|application\/xhtml/.test(ct)) {
    if (depth >= 1 || !isDeliverable(finalUrl)) return null;
    const next = await resolveMirrorRedirect(finalUrl, timeout);
    if (!next || next === finalUrl) return null;
    return verifyCandidate({ ...cand, url: next }, { timeout, depth: depth + 1 });
  }

  const cd = res.headers.get('content-disposition') || '';
  const cdName = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  let filename = cand.filename || path.basename(finalUrl.split(/[?#]/)[0]) || 'fichier';
  if (cdName) {
    try { filename = decodeURIComponent(cdName[1]); } catch (_) { filename = cdName[1]; }
  }

  let size = 0;
  const cr = res.headers.get('content-range');
  if (cr) size = parseInt(cr.split('/')[1], 10) || 0;
  if (!size) size = parseInt(res.headers.get('content-length'), 10) || 0;
  if (!size && cand.size) size = cand.size;

  if (!isDeliverable(filename) && !isDeliverable(finalUrl)) return null;

  return { ...cand, url: finalUrl, filename, size, contentType: ct, verified: true };
}


/**
 * Verifie qu'une PAGE repond vraiment : le moteur peut indexer un domaine mort,
 * une page supprimee ou un lien qui part en 404 apres redirection. Contrairement
 * a verifyCandidate (qui juge un fichier), on accepte ici le HTML et on rend
 * l'adresse finale, celle qui a effectivement repondu.
 * @returns {Promise<{url, status}|null>} null si morte, injoignable ou 4xx/5xx
 */
async function verifyUrl(url, { timeout = 7000 } = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) return null;

  // HEAD d'abord : rien a telecharger. Beaucoup de sites le refusent (405) ou
  // le bloquent, d'ou le GET de repli borne au premier octet.
  const essais = [
    { method: 'HEAD', headers: {} },
    { method: 'GET', headers: { Range: 'bytes=0-2047' } },
  ];
  for (const e of essais) {
    try {
      const r = await httpGet(url, { timeout, method: e.method, redirect: 'follow', headers: e.headers });
      if (!r) continue;
      if (r.ok || r.status === 206) {
        // Certains hebergeurs rendent 200 sur une page de parking ou d'erreur ;
        // on ne va pas plus loin, mais un domaine saisi rend presque toujours
        // une redirection vers un autre hote, ce que l'URL finale revele.
        return { url: r.url || url, status: r.status };
      }
      // 403/405 sur HEAD ne dit rien du site : on laisse le GET trancher.
      if (e.method === 'GET') return null;
    } catch (_) {}
  }
  return null;
}

// ------------------------------------------------ gestionnaires de paquets

/** Lit une API JSON sans jamais faire tomber la recherche. */
async function httpJson(url, timeout) {
  try {
    const t = await httpText(url, { timeout });
    return t ? JSON.parse(t) : null;
  } catch (_) {
    return null;
  }
}

/** Variantes de slug d'un nom de logiciel : « Notepad++ » -> notepad-plus-plus,
 *  notepadplusplus, notepad++. Les catalogues nomment differemment. */
function pkgSlugs(name) {
  const bas = String(name || '').toLowerCase().trim();
  const out = new Set([
    bas.replace(/\s+/g, '-').replace(/[^a-z0-9.+-]/g, ''),
    bas.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
    slugNorm(name),
    bas.replace(/\s+/g, ''),
  ]);
  return [...out].filter(Boolean).slice(0, 4);
}

/** Nom de fichier lisible depuis une URL : %20 redevient espace. */
function baseName(url) {
  const raw = path.basename(String(url || '').split(/[?#]/)[0]);
  try { return decodeURIComponent(raw); } catch (_) { return raw; }
}

/** Homebrew cask : l'URL directe du .dmg/.pkg macOS, trouvee par nom. C'est la
 *  source la plus fiable pour macOS, la ou GitHub ne suffit pas. */
async function brewCask(name, timeout) {
  for (const slug of pkgSlugs(name)) {
    const d = await httpJson(`https://formulae.brew.sh/api/cask/${encodeURIComponent(slug)}.json`, timeout);
    if (d && d.url) {
      return [{
        url: d.url,
        filename: baseName(d.url) || (slug + '.dmg'),
        source: 'brew-cask',
        version: d.version,
        text: `${Array.isArray(d.name) ? d.name[0] : d.name || name} ${d.version || ''} — ${d.homepage || ''}`,
      }];
    }
  }
  return [];
}

/** Homebrew formula : l'archive source officielle (tarball versionne). Utile
 *  pour Linux et pour les outils en ligne de commande. */
async function brewFormula(name, timeout) {
  for (const slug of pkgSlugs(name)) {
    const d = await httpJson(`https://formulae.brew.sh/api/formula/${encodeURIComponent(slug)}.json`, timeout);
    const u = d?.urls?.stable?.url;
    if (u) {
      return [{
        url: u,
        filename: baseName(u) || (slug + '.tar.gz'),
        source: 'brew-formula',
        version: d.versions?.stable,
        text: `${d.full_name || name} ${d.versions?.stable || ''} — ${d.homepage || ''}`,
      }];
    }
  }
  return [];
}

// ---------------------------------------------------------------- recherche

async function searchOneName(name, opts = {}) {
  const timeout = opts.timeout || 12000;
  const maxVerify = opts.maxVerify || 5;
  const { os, arch } = opts;
  const result = { name, os, arch, candidates: [], pages: [], queriesRun: [] };
  if (!name || name.length < 2) return result;

  const pool = [];
  const seen = new Set();
  const push = (c) => {
    if (!c || !c.url || seen.has(c.url)) return;
    seen.add(c.url);
    pool.push(c);
  };

  // --- Passe 1 : depots et archives, interroges en parallele.
  // GitHub seul laisse de cote les logiciels abandonnes, les vieilles
  // versions et les projets qui n'y ont jamais ete publies.
  // GitHub seul laisse de cote les logiciels abandonnes, les vieilles versions
  // et ce qui n'y a jamais ete publie. On ajoute les catalogues qui donnent une
  // URL directe et verifiable, choisis selon le systeme demande.
  const pkgTasks = [
    githubReleases(name, timeout),
    archiveOrgFiles(name, timeout),
    gitlabReleases(name, timeout),
    codebergReleases(name, timeout),
  ];
  if (os === 'macos' || os === 'any') pkgTasks.push(brewCask(name, timeout));
  if (os === 'macos' || os === 'linux' || os === 'any') pkgTasks.push(brewFormula(name, timeout));
  const sources = await Promise.allSettled(pkgTasks);
  for (const src of sources) {
    if (src.status === 'fulfilled' && Array.isArray(src.value)) src.value.forEach(push);
  }

  // --- Passe 2 : moteur de recherche
  const osWord = { windows: 'windows', macos: 'macos', linux: 'linux', android: 'android' }[os] || '';
  const queries = [
    name + ' official site download',
    name + ' github releases',
    name + ' ' + osWord + ' ' + arch + ' installer download',
    name + ' download zip portable',
    // Les forums et les miroirs gardent la trace de ce qui a disparu
    // des sites officiels : vieilles versions, projets abandonnes.
    name + ' download forum mirror archive',
    name + ' old version ancienne version telechargement',
    ...(os === 'any' ? [name + ' github repository source'] : []),
  ];
  const pages = [];
  for (const q of queries) {
    if (pool.length >= 25 && pages.length >= 6) break;
    result.queriesRun.push(q);
    let hits = [];
    try { hits = await webSearch(q, timeout); } catch (_) {}
    for (const h of hits) {
      if (EXT_RE.test(h.url)) {
        push({ url: h.url, filename: path.basename(h.url.split(/[?#]/)[0]), source: 'search', text: h.title });
      } else if (pages.length < 10 && !pages.some(p => p.url === h.url)) {
        pages.push(h);
      }
    }
  }

  // --- Passe 3 : ouverture des pages
  const nameNorm = slugNorm(name);
  const pageScore = (p) => {
    const h = hostOf(p.url);
    return (TRUSTED_HOST_RE.test(h) ? 2 : 0)
      + (nameNorm.length >= 3 && h.replace(/[^a-z0-9]/g, '').includes(nameNorm) ? 3 : 0);
  };
  const sortedPages = pages.sort((a, b) => pageScore(b) - pageScore(a)).slice(0, 6);

  const visited = new Set();
  const queue = sortedPages.map(p => ({ url: p.url, depth: 0 }));
  while (queue.length && result.pages.length < 12) {
    const { url: pageUrl, depth } = queue.shift();
    if (visited.has(pageUrl)) continue;
    visited.add(pageUrl);
    const html = await httpText(pageUrl, { timeout });
    if (!html) continue;
    result.pages.push(pageUrl);

    for (const link of extractFileLinks(html, pageUrl)) {
      push({ ...link, source: 'page', origin: hostOf(pageUrl) });
    }
    if (depth === 0 && pool.length < 8) {
      for (const sub of extractDownloadPages(html, pageUrl, nameNorm)) {
        if (!visited.has(sub)) queue.push({ url: sub, depth: 1 });
      }
    }
  }

  // --- Scoring puis verification
  const scored = pool
    .map(c => ({ ...c, score: scoreCandidate(c, { name, os, arch }) }))
    .sort((a, b) => b.score - a.score);

  const perHost = new Map();
  const ranked = [];
  for (const c of scored) {
    const h = groupKey(c.url);
    const used = perHost.get(h) || 0;
    if (used >= 3) continue;
    perHost.set(h, used + 1);
    ranked.push(c);
    if (ranked.length >= maxVerify * 4) break;
  }

  const verified = [];
  for (const cand of ranked) {
    if (verified.length >= maxVerify) break;
    const v = await verifyCandidate(cand, { timeout });
    if (v) verified.push(v);
  }

  result.candidates = verified.sort((a, b) => b.score - a.score);
  return result;
}

async function deepSearch(query, opts = {}) {
  const target = opts.target || parseTarget(query);
  const parsed = opts.name || parseToolName(query);
  const names = opts.name ? [opts.name] : candidateNames(query, parsed);

  let best = null;
  for (const name of names) {
    let r = await searchOneName(name, { ...opts, os: target.os, arch: target.arch });
    if (!r.candidates.length && (r.pages.length || r.queriesRun.length)) {
      const retry = await searchOneName(name, {
        ...opts, os: target.os, arch: target.arch, timeout: (opts.timeout || 12000) + 6000,
      });
      if (retry.candidates.length) r = retry;
    }
    if (r.candidates.length) {
      const top = r.candidates[0].score || 0;
      if (!best || top > (best.candidates[0]?.score || 0)) best = r;
      if (top >= 150) break;
    } else if (!best) {
      best = r;
    }
  }

  if (best) best.name = parsed || best.name;
  return best || { name: parsed, os: target.os, arch: target.arch, candidates: [], pages: [], queriesRun: [] };
}

// ---------------------------------------------------------------- stockage

function safeFileName(name) {
  return String(name || 'fichier')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120) || 'fichier';
}

function sha256File(abs) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(abs)
      .on('data', c => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

async function fetchToStore(cand, { dir, maxBytes, timeout = 180000, onProgress } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.createHash('sha1').update(cand.url).digest('hex').slice(0, 10);
  const filename = safeFileName(cand.filename);
  const rel = key + '-' + filename;
  const abs = path.join(dir, rel);

  if (fs.existsSync(abs)) {
    const st = fs.statSync(abs);
    if (st.size > 0) {
      return { abs, rel, filename, size: st.size, sha256: await sha256File(abs), url: cand.url, cached: true };
    }
  }

  const res = await httpGet(cand.url, { timeout, redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const total = parseInt(res.headers.get('content-length'), 10) || cand.size || 0;
  if (maxBytes && total > maxBytes) throw new Error('TOO_BIG:' + total);

  const tmp = abs + '.part';
  const out = fs.createWriteStream(tmp);
  const hash = crypto.createHash('sha256');
  let got = 0;
  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      if (maxBytes && got > maxBytes) throw new Error('TOO_BIG:' + got);
      hash.update(chunk);
      if (!out.write(chunk)) await once(out, 'drain');
      if (onProgress && total) onProgress(got, total);
    }
    await new Promise((r, j) => { out.end(err => (err ? j(err) : r())); });
  } catch (e) {
    out.destroy();
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }

  fs.renameSync(tmp, abs);
  return { abs, rel, filename, size: got, sha256: hash.digest('hex'), url: cand.url, cached: false };
}

function packageHints(name, os) {
  const slug = name.toLowerCase().replace(/\s+/g, '');
  if (os === 'macos') return 'brew install --cask ' + slug;
  if (os === 'linux') return 'sudo apt install ' + slug;
  if (os === 'android' || os === 'any') return null;
  return 'winget search ' + name;
}

module.exports = {
  webSearch,
  fetchPageText,
  extractOutlinks,
  stripTags,
  candidateNames,
  deepSearch,
  verifyCandidate,
  verifyUrl,
  fetchToStore,
  parseToolName,
  parseTarget,
  packageHints,
  isDeliverable,
  extOf,
  DELIVERABLE_EXT,
};