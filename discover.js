/**
 * discover.js — moteur de decouverte de projets.
 *
 * websearch.js repond a « donne-moi VLC » : un produit nomme, un fichier a livrer.
 * Ce module repond a « trouve-moi des bots Discord de gestion » : une CATEGORIE.
 * Il n'y a pas de binaire a telecharger, mais une liste de vrais projets, classee.
 *
 * Trois principes tires des essais reels :
 *
 * 1. Les moteurs de recherche grand public bloquent ou renvoient du bruit a un
 *    client non-navigateur (Mojeek 403, DuckDuckGo 202, Bing qui repond
 *    « discord.com » a « discord moderation bot »). On s'appuie donc d'abord sur
 *    des API qui repondent vraiment : GitHub, npm, Hacker News, Stack Exchange.
 *    Le web generique reste branche, mais en source d'appoint.
 *
 * 2. Les requetes partent en anglais. « gestion » ne trouve rien sur GitHub ;
 *    « management » trouve tout. Le francais sert a comprendre, pas a chercher.
 *
 * 3. Le classement recompense la corroboration : un projet cite par GitHub ET
 *    une liste curee ET un forum passe devant un depot isole tres etoile.
 *
 * Aucune cle requise. GITHUB_TOKEN est utilise s'il existe (quotas x30).
 */

const WS = require('./websearch');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ---------------------------------------------------------------- utilitaires

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ''; }
}

function norm(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–');
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Execute fn sur items avec au plus `limit` appels simultanes. */
async function mapLimit(items, limit, fn) {
  const out = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try { out[i] = await fn(items[i], i); } catch (_) { out[i] = null; }
    }
  });
  await Promise.all(workers);
  return out.filter(Boolean);
}

async function httpJson(url, { timeout = 12000, headers = {} } = {}) {
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
    });
    if (!r.ok) return { ok: false, status: r.status, data: null };
    return { ok: true, status: r.status, data: await r.json() };
  } catch (_) {
    return { ok: false, status: 0, data: null };
  }
}

async function httpText(url, { timeout = 12000, headers = {} } = {}) {
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': UA, 'Accept-Language': 'fr,en;q=0.8', ...headers },
    });
    if (!r.ok) return { ok: false, status: r.status, body: '' };
    return { ok: true, status: r.status, body: await r.text() };
  } catch (_) {
    return { ok: false, status: 0, body: '' };
  }
}

// L'API GitHub non authentifiee plafonne a 10 recherches/minute : on ne pose pas
// deux fois la meme question.
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 400) {
    for (const [k, v] of cache) { if (Date.now() - v.at > CACHE_TTL) cache.delete(k); }
  }
  return value;
}

// ---------------------------------------------------------------- vocabulaire

/** Categories en francais -> mots-cles anglais reellement indexes par les sources. */
const FR_EN = new Map(Object.entries({
  gestion: 'management', gerer: 'management', administration: 'admin',
  moderation: 'moderation', moderer: 'moderation', securite: 'security',
  musique: 'music', sondage: 'poll', sondages: 'poll', ticket: 'ticket', tickets: 'ticket',
  economie: 'economy', niveau: 'leveling', niveaux: 'leveling', jeu: 'game', jeux: 'game',
  bienvenue: 'welcome', accueil: 'welcome', statistiques: 'analytics', stats: 'analytics',
  sauvegarde: 'backup', sauvegardes: 'backup', traduction: 'translation',
  telechargement: 'downloader', telecharger: 'downloader', montage: 'editor',
  retouche: 'editing', dessin: 'drawing', capture: 'capture', enregistrement: 'recorder',
  compression: 'compression', compresser: 'compress', convertir: 'converter',
  conversion: 'converter', lecteur: 'player', navigateur: 'browser',
  messagerie: 'messaging', comptabilite: 'accounting', facturation: 'invoicing',
  planning: 'scheduling', agenda: 'calendar', tache: 'todo', taches: 'todo',
  inventaire: 'inventory', boutique: 'ecommerce', paiement: 'payment',
  formulaire: 'form', surveillance: 'monitoring', supervision: 'monitoring',
  reseau: 'network', donnees: 'data', chiffrement: 'encryption',
  bureau: 'desktop', distant: 'remote', hebergement: 'selfhosted', heberger: 'selfhosted',
  protection: 'protection', antitriche: 'anticheat', anticheat: 'anticheat',
  vocal: 'voice', voix: 'voice', role: 'roles', roles: 'roles',
  automatisation: 'automation', automatique: 'automation',
}));

/** Mots vides : aucune information de recherche. */
const STOP = new Set([
  'je', 'tu', 'il', 'on', 'me', 'moi', 'the', 'a', 'an', 'of', 'for', 'with', 'and',
  'trouve', 'trouver', 'trouves', 'cherche', 'chercher', 'cherches', 'recherche', 'rechercher',
  'donne', 'donnes', 'donner', 'envoie', 'envoyer', 'file', 'balance', 'refile', 'fournis',
  'veux', 'voudrais', 'faut', 'besoin', 'aurais', 'peux', 'pourrais', 'saurais', 'connais',
  'des', 'du', 'de', 'le', 'la', 'les', 'un', 'une', 'et', 'ou', 'au', 'aux', 'sont', 'est',
  'pour', 'avec', 'sur', 'dans', 'par', 'en', 'qui', 'que', 'quoi', 'ce', 'cette', 'ces',
  'stp', 'svp', 'please', 'merci', 'salut', 'hey', 'bonjour', 'frere', 'mec', 'bro',
  'bon', 'bons', 'bonne', 'bonnes', 'meilleur', 'meilleurs', 'meilleure', 'meilleures',
  'best', 'good', 'top', 'liste', 'list', 'quelques', 'plusieurs', 'genre', 'style',
  'truc', 'trucs', 'chose', 'choses', 'gratuit', 'gratuits', 'free', 'peu', 'vraiment', 'super',
]);

/** Noms de categorie : utiles pour comprendre, trop generiques pour filtrer. */
const GENERIC = new Set([
  'bot', 'bots', 'logiciel', 'logiciels', 'soft', 'software', 'programme', 'programmes',
  'application', 'applications', 'appli', 'applis', 'app', 'apps', 'outil', 'outils',
  'tool', 'tools', 'utilitaire', 'utilitaires', 'plugin', 'plugins', 'extension',
  'extensions', 'addon', 'addons', 'mod', 'mods', 'script', 'scripts', 'librairie',
  'librairies', 'library', 'libraries', 'framework', 'frameworks', 'package', 'packages',
  'paquet', 'paquets', 'theme', 'themes', 'template', 'templates', 'alternative',
  'alternatives', 'solution', 'solutions', 'service', 'services', 'projet', 'projets',
]);

/** Singulier approximatif : « bots » -> « bot », « plugins » -> « plugin ». */
function singular(w) {
  if (w.length > 4 && /(?:aux)$/.test(w)) return w.slice(0, -3) + 'l';
  if (w.length > 3 && /s$/.test(w) && !/(?:ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/**
 * Ecosystemes : chacun apporte ses topics GitHub, ses mots-cles de paquet et ses
 * annuaires. C'est ce qui fait passer de « bot discord » a des sources qui
 * connaissent le sujet, au lieu d'une recherche web generique.
 */
const ECOSYSTEMS = [
  {
    id: 'discord',
    match: /\bdiscord\b/i,
    subject: 'discord',
    topics: ['discord-bot', 'discord', 'discordjs'],
    npm: 'discord bot',
    sites: ['top.gg', 'discord.bots.gg'],
    awesome: ['awesome discord', 'awesome discord bots'],
    hint: "La plupart s'auto-hebergent (Node.js ou Python) ; certains ont aussi une version hebergee prete a inviter.",
  },
  {
    id: 'minecraft',
    match: /\bminecraft\b|\bspigot\b|\bpaper(mc)?\b/i,
    subject: 'minecraft',
    topics: ['minecraft-plugin', 'spigot', 'bukkit', 'paper-plugin'],
    npm: '',
    sites: ['modrinth.com', 'spigotmc.org', 'hangar.papermc.io'],
    awesome: ['awesome minecraft'],
    hint: "Verifie la compatibilite avec ta version de serveur (Paper/Spigot/Fabric) avant d'installer.",
  },
  {
    id: 'wordpress',
    match: /\bwordpress\b|\bwoocommerce\b/i,
    subject: 'wordpress',
    topics: ['wordpress-plugin', 'woocommerce'],
    npm: '',
    sites: ['wordpress.org'],
    awesome: ['awesome wordpress'],
    hint: '',
  },
  {
    id: 'telegram',
    match: /\btelegram\b/i,
    subject: 'telegram',
    topics: ['telegram-bot', 'telegram'],
    npm: 'telegram bot',
    sites: [],
    awesome: ['awesome telegram', 'awesome telegram bots'],
    hint: '',
  },
  {
    id: 'selfhosted',
    match: /\b(self[- ]?host\w*|auto[- ]?heberg\w*|homelab|nas|serveur perso)\b/i,
    subject: 'selfhosted',
    topics: ['selfhosted', 'self-hosted', 'docker'],
    npm: '',
    sites: [],
    awesome: ['awesome selfhosted'],
    hint: "Regarde s'il existe une image Docker officielle : c'est le plus rapide a deployer.",
  },
  {
    id: 'vscode',
    match: /\bvs ?code\b|\bvisual studio code\b/i,
    subject: 'vscode',
    topics: ['vscode-extension'],
    npm: '',
    sites: ['marketplace.visualstudio.com'],
    awesome: ['awesome vscode'],
    hint: '',
  },
  {
    id: 'obs',
    match: /\bobs\b|\bstreamlabs\b/i,
    subject: 'obs',
    topics: ['obs-plugin', 'obs-studio'],
    npm: '',
    sites: ['obsproject.com'],
    awesome: ['awesome obs'],
    hint: '',
  },
  {
    id: 'navigateur',
    match: /\b(chrome|firefox|navigateur|browser)\b[\s\S]*\b(extension|module|addon)\b|\b(extension|addon)\b[\s\S]*\b(chrome|firefox|navigateur|browser)\b/i,
    subject: 'browser',
    topics: ['chrome-extension', 'firefox-addon', 'browser-extension'],
    npm: '',
    sites: ['addons.mozilla.org', 'chromewebstore.google.com'],
    awesome: ['awesome chrome extensions'],
    hint: '',
  },
  {
    id: 'home-assistant',
    match: /\bhome ?assistant\b|\bdomotique\b|\bjeedom\b/i,
    subject: 'home assistant',
    topics: ['home-assistant', 'hacs'],
    npm: '',
    sites: [],
    awesome: ['awesome home assistant'],
    hint: '',
  },
];

function wantsSelfHosted(q) {
  return /\b(open[- ]?source|self[- ]?host\w*|auto[- ]?heberg\w*|github|code source|libre)\b/i.test(q);
}

// ---------------------------------------------------------------- intention

const PLURAL_RE = /\b(des|quelques|plusieurs|liste|listes|list|top \d+|meilleurs?|meilleures?|best|differents?|plein de|tous les|toutes les)\b/i;
const CATEGORY_RE = /\b(bots?|logiciels?|softs?|programmes?|applications?|applis?|outils?|tools?|utilitaires?|plugins?|extensions?|addons?|mods?|scripts?|librairies?|libraries?|frameworks?|packages?|paquets?|themes?|templates?|alternatives?|solutions?|services?)\b/i;
const PURPOSE_RE = /\b(pour|qui|capable|permet|permettant|servant|afin de|to |that )\b/i;

/**
 * Decide entre « produit nomme » (websearch livre un fichier) et « categorie »
 * (ce module renvoie une liste). Le doute profite a la decouverte : une liste
 * reste utile quand on attendait un fichier, l'inverse est frustrant.
 */
function classify(query) {
  const raw = String(query || '').trim();
  const q = raw.toLowerCase();

  let score = 0;
  if (PLURAL_RE.test(q)) score += 2;
  if (CATEGORY_RE.test(q)) score += 2;
  if (PURPOSE_RE.test(q) && CATEGORY_RE.test(q)) score += 1;
  if (/\balternative(s)? (a|à|to)\b/i.test(q)) score += 3;
  if (/\bcomment\b|\bhow to\b/i.test(q)) score -= 1;

  const words = norm(raw).split(/\s+/).filter(w => w && !STOP.has(w));
  if (words.length >= 3) score += 1;
  if (words.length <= 1) score -= 2;
  if (/\.(exe|msi|zip|dmg|apk|deb|appimage)\b/i.test(q)) score -= 4;
  if (/\bv?\d+\.\d+/.test(q)) score -= 2;

  const ecosystem = ECOSYSTEMS.find(e => e.match.test(raw)) || null;
  if (ecosystem && words.length >= 2) score += 1;

  const terms = buildTerms(words, ecosystem);

  return {
    kind: score >= 3 ? 'discovery' : 'named',
    score,
    topic: words.join(' '),
    ...terms,
    ecosystem,
    selfHosted: wantsSelfHosted(raw),
    raw,
  };
}

/**
 * Separe la demande en trois roles :
 *  - subject : de quoi on parle (« discord ») — sert de filtre dur
 *  - purpose : a quoi ca doit servir (« management ») — sert au classement
 *  - searchTerms : ce qu'on envoie aux API, en anglais et au singulier
 */
function buildTerms(words, ecosystem) {
  const purpose = [];
  const subjects = [];
  const seen = new Set();

  for (const w of words) {
    const s = singular(w);
    const en = FR_EN.get(w) || FR_EN.get(s) || '';
    const term = en || s;
    if (seen.has(term)) continue;
    seen.add(term);
    if (GENERIC.has(w) || GENERIC.has(s)) continue;
    if (en) purpose.push(term);
    else subjects.push(term);
  }

  // Sans ecosysteme connu, le premier mot concret fait office de sujet.
  const subject = ecosystem ? ecosystem.subject : (subjects[0] || purpose[0] || '');
  const searchTerms = [...new Set([subject, ...subjects, ...purpose].filter(Boolean))].slice(0, 6);

  return { subject, purpose, subjects, searchTerms };
}

// ---------------------------------------------------------------- sources

const GH_HEADERS = () => {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': UA };
  if (process.env.GITHUB_TOKEN) h.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
  return h;
};

function repoFromApi(repo, source) {
  return {
    key: 'gh:' + String(repo.full_name || '').toLowerCase(),
    kind: 'repo',
    name: repo.name,
    fullName: repo.full_name,
    url: repo.html_url,
    homepage: repo.homepage || '',
    description: repo.description || '',
    stars: repo.stargazers_count || 0,
    language: repo.language || '',
    topics: repo.topics || [],
    updated: repo.pushed_at || repo.updated_at || '',
    archived: !!repo.archived,
    isFork: !!repo.fork,
    license: (repo.license && repo.license.spdx_id) || '',
    enriched: true,
    sources: new Set([source]),
  };
}

function repoFromUrl(url, source, extra = {}) {
  const m = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i.exec(url);
  if (!m) return null;
  if (/^(sponsors|topics|features|about|pricing|site|orgs|apps|collections|marketplace|settings|login)$/i.test(m[1])) return null;
  const full = m[1] + '/' + m[2].replace(/\.git$/, '');
  return {
    key: 'gh:' + full.toLowerCase(),
    kind: 'repo',
    name: m[2].replace(/\.git$/, ''),
    fullName: full,
    url: 'https://github.com/' + full,
    description: '',
    stars: 0,
    sources: new Set([source]),
    ...extra,
  };
}

/** Recherche GitHub : l'index de projets le plus riche, et il repond toujours. */
async function githubSearch(queries, { timeout, perPage = 12 }) {
  const found = [];
  await mapLimit(queries, 3, async (q) => {
    const url = 'https://api.github.com/search/repositories?q=' + encodeURIComponent(q)
      + '&sort=stars&order=desc&per_page=' + perPage;
    const res = await cached('ghq:' + q, () => httpJson(url, { timeout, headers: GH_HEADERS() }));
    if (!res.ok || !res.data) return null;
    for (const repo of res.data.items || []) found.push(repoFromApi(repo, 'github'));
    return true;
  });
  return found;
}

/**
 * Listes « awesome » : une categorie deja triee a la main. Souvent meilleur qu'un
 * classement par etoiles, parce qu'un humain a filtre avant nous.
 * La requete doit rester courte : « awesome discord » trouve la liste,
 * « awesome discord bot management » ne trouve rien.
 */
async function awesomeLists(info, { timeout }) {
  const queries = info.ecosystem
    ? info.ecosystem.awesome.slice(0, 2)
    : ['awesome ' + (info.subject || info.searchTerms[0] || '')];

  const lists = [];
  await mapLimit(queries.filter(q => q.trim().length > 8), 2, async (q) => {
    const res = await cached('ghaw:' + q, () => httpJson(
      'https://api.github.com/search/repositories?q=' + encodeURIComponent(q + ' in:name')
      + '&sort=stars&order=desc&per_page=4',
      { timeout, headers: GH_HEADERS() }
    ));
    if (!res.ok || !res.data) return null;
    for (const r of res.data.items || []) {
      if (/awesome/i.test(r.name)) lists.push(r.full_name);
    }
    return true;
  });

  const out = [];
  await mapLimit([...new Set(lists)].slice(0, 4), 4, async (full) => {
    for (const branch of ['HEAD', 'master', 'main']) {
      const raw = await cached('readme:' + full + ':' + branch, () => httpText(
        `https://raw.githubusercontent.com/${full}/${branch}/README.md`, { timeout }
      ));
      if (!raw.ok || raw.body.length < 200) continue;
      out.push(...parseAwesomeReadme(raw.body, info, full));
      return true;
    }
    return null;
  });
  return out;
}

/** Extrait « - [Nom](url) — description » d'un README de liste curee. */
function parseAwesomeReadme(md, info, listName) {
  const out = [];
  const seen = new Set();
  const filters = [...info.purpose, ...info.subjects].map(norm).filter(k => k.length >= 3);
  const re = /^[ \t]*[-*][ \t]+\[([^\]]{2,70})\]\((https?:\/\/[^)\s]+)\)[ \t]*[-—–:]?[ \t]*(.{0,200})$/gm;
  let m;
  while ((m = re.exec(md)) && out.length < 150) {
    const [, label, rawUrl, desc] = m;
    const url = rawUrl.replace(/[.,)]+$/, '');
    if (/(badge|shields\.io|\.svg|\.png)/i.test(url)) continue;
    const key = url.split(/[?#]/)[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    // Une liste curee est longue : on ne garde que les entrees liees a la demande.
    const hay = norm(label + ' ' + desc);
    if (filters.length && !filters.some(k => hay.includes(k))) continue;

    const repo = repoFromUrl(url, 'awesome', {
      description: stripTags(desc).slice(0, 200),
      citedBy: listName,
    });
    if (repo) { repo.name = label.trim() || repo.name; out.push(repo); continue; }
    out.push({
      key: 'url:' + key,
      kind: 'page',
      name: label.trim(),
      url,
      description: stripTags(desc).slice(0, 200),
      stars: 0,
      citedBy: listName,
      sources: new Set(['awesome']),
    });
  }
  return out;
}

/** Registre npm : incontournable des qu'il s'agit de bots Discord ou d'outils JS. */
async function npmSearch(text, { timeout }) {
  if (!text || text.trim().length < 3) return [];
  const res = await cached('npm:' + text, () => httpJson(
    'https://registry.npmjs.org/-/v1/search?size=15&text=' + encodeURIComponent(text), { timeout }
  ));
  if (!res.ok || !res.data) return [];

  return (res.data.objects || []).map(o => {
    const p = o.package || {};
    const repo = repoFromUrl(String(p.links?.repository || ''), 'npm');
    const base = {
      description: p.description || '',
      npmName: p.name,
      npmScore: Math.round((o.score?.final || 0) * 100),
      updated: p.date || '',
    };
    if (repo) return Object.assign(repo, base, { description: repo.description || base.description });
    return {
      key: 'npm:' + p.name,
      kind: 'package',
      name: p.name,
      url: p.links?.npm || '',
      stars: 0,
      sources: new Set(['npm']),
      ...base,
    };
  }).filter(c => c.url);
}

/**
 * Hacker News via Algolia : un vrai forum technique, une API publique sans cle,
 * et jamais de blocage. C'est notre meilleure source « ce que les gens utilisent ».
 */
async function hackerNews(terms, { timeout }) {
  const q = terms.slice(0, 4).join(' ');
  if (!q) return [];
  const res = await cached('hn:' + q, () => httpJson(
    'https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=20&query=' + encodeURIComponent(q),
    { timeout }
  ));
  if (!res.ok || !res.data) return [];

  const out = [];
  for (const hit of res.data.hits || []) {
    const title = String(hit.title || '');
    const points = hit.points || 0;
    const repo = repoFromUrl(String(hit.url || ''), 'forum', {
      description: title.slice(0, 200),
      citedBy: 'Hacker News (' + points + ' points)',
      hnPoints: points,
    });
    if (repo) { out.push(repo); continue; }
    // « Show HN: MonOutil – fait ceci » : le titre porte le nom du projet.
    const show = /^Show HN:\s*([^–—-]{2,50})\s*[–—-]\s*(.{5,150})/i.exec(title);
    if (show && hit.url) {
      out.push({
        key: 'url:' + String(hit.url).split(/[?#]/)[0].toLowerCase(),
        kind: 'page',
        name: show[1].trim(),
        url: hit.url,
        description: show[2].trim(),
        stars: 0,
        hnPoints: points,
        citedBy: 'Hacker News (' + points + ' points)',
        sources: new Set(['forum']),
      });
    }
  }
  return out;
}

/** Stack Exchange : les depots cites dans les reponses aux questions du domaine. */
async function stackExchange(terms, { timeout }) {
  const q = terms.slice(0, 4).join(' ');
  if (!q) return [];
  const res = await cached('se:' + q, () => httpJson(
    'https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=votes&pagesize=10'
    + '&site=stackoverflow&filter=withbody&q=' + encodeURIComponent(q),
    { timeout }
  ));
  if (!res.ok || !res.data) return [];

  const out = [];
  const seen = new Set();
  for (const item of res.data.items || []) {
    const re = /https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g;
    let m;
    while ((m = re.exec(String(item.body || ''))) && seen.size < 25) {
      if (seen.has(m[0].toLowerCase())) continue;
      seen.add(m[0].toLowerCase());
      const repo = repoFromUrl(m[0], 'forum', {
        citedBy: 'Stack Overflow (' + (item.score || 0) + ' votes)',
      });
      if (repo) out.push(repo);
    }
  }
  return out;
}

/**
 * Web generique : les moteurs bloquent souvent, mais quand ils repondent ils
 * apportent les comparatifs et les pages produit hors GitHub. Source d'appoint.
 */
async function webExtra(queries, { timeout }) {
  const out = [];
  await mapLimit(queries.slice(0, 3), 3, async (q) => {
    let hits = [];
    try { hits = await WS.webSearch(q, timeout); } catch (_) { return null; }
    for (const h of hits.slice(0, 8)) {
      const repo = repoFromUrl(h.url, 'web', { description: h.snippet || h.title || '' });
      if (repo) { out.push(repo); continue; }
      out.push({
        key: 'url:' + h.url.split(/[?#]/)[0].toLowerCase(),
        kind: 'page',
        name: (h.title || hostOf(h.url)).slice(0, 70),
        url: h.url,
        description: (h.snippet || '').slice(0, 200),
        stars: 0,
        sources: new Set(['web']),
      });
    }
    return true;
  });
  return out;
}

/** Annuaires specialises (top.gg, Modrinth…) : les produits absents de GitHub. */
async function directories(info, { timeout }) {
  const eco = info.ecosystem;
  if (!eco || !eco.sites.length) return [];
  const kw = [...info.purpose, ...info.subjects].slice(0, 2).join(' ');
  const queries = eco.sites.slice(0, 2).map(site => `site:${site} ${kw}`);

  const out = [];
  await mapLimit(queries, 2, async (q) => {
    let hits = [];
    try { hits = await WS.webSearch(q, timeout); } catch (_) { return null; }
    for (const h of hits.slice(0, 6)) {
      const host = hostOf(h.url);
      if (!eco.sites.some(s => host === s || host.endsWith('.' + s))) continue;
      out.push({
        key: 'url:' + h.url.split(/[?#]/)[0].toLowerCase(),
        kind: 'page',
        name: (h.title || decodeURIComponent(h.url.split('/').filter(Boolean).pop() || host)).slice(0, 70),
        url: h.url,
        description: (h.snippet || '').slice(0, 200),
        stars: 0,
        directory: host,
        sources: new Set(['annuaire']),
      });
    }
    return true;
  });
  return out;
}

// ---------------------------------------------------------------- enrichissement

/** Les depots venus des forums ou des README n'ont ni etoiles ni description. */
async function enrichRepos(candidates, { timeout, max = 12 }) {
  const todo = candidates.filter(c => c.kind === 'repo' && c.fullName && !c.enriched).slice(0, max);
  await mapLimit(todo, 4, async (c) => {
    const res = await cached('ghr:' + c.fullName.toLowerCase(), () => httpJson(
      'https://api.github.com/repos/' + c.fullName, { timeout, headers: GH_HEADERS() }
    ));
    const repo = res.ok && res.data;
    if (!repo || !repo.full_name) return null;
    c.enriched = true;
    c.name = c.name || repo.name;
    c.description = c.description || repo.description || '';
    c.stars = repo.stargazers_count || 0;
    c.language = repo.language || '';
    c.topics = repo.topics || [];
    c.updated = repo.pushed_at || '';
    c.archived = !!repo.archived;
    c.isFork = !!repo.fork;
    c.homepage = repo.homepage || '';
    c.license = (repo.license && repo.license.spdx_id) || '';
    return true;
  });
  return candidates;
}

// ---------------------------------------------------------------- fusion, classement

function mergeCandidates(groups) {
  const byKey = new Map();
  for (const group of groups) {
    for (const c of group || []) {
      if (!c || !c.key || !c.url) continue;
      const prev = byKey.get(c.key);
      if (!prev) { byKey.set(c.key, c); continue; }
      for (const s of c.sources) prev.sources.add(s);
      prev.description = prev.description || c.description;
      prev.stars = Math.max(prev.stars || 0, c.stars || 0);
      prev.hnPoints = Math.max(prev.hnPoints || 0, c.hnPoints || 0);
      prev.npmName = prev.npmName || c.npmName;
      prev.npmScore = Math.max(prev.npmScore || 0, c.npmScore || 0);
      prev.citedBy = prev.citedBy || c.citedBy;
      prev.directory = prev.directory || c.directory;
      prev.enriched = prev.enriched || c.enriched;
    }
  }
  return [...byKey.values()];
}

const MONTH = 30 * 24 * 3600 * 1000;

/** Une brique technique n'est pas un produit utilisable tel quel. */
const LIBRARY_RE = /\b(library|librairie|wrapper|sdk|typings|api types|bindings|toolkit|framework|boilerplate|starter|scaffold|utilities|helpers?|middleware|parser|client for)\b/i;
const NOISE_RE = /\b(tutorial|tutoriel|example|examples|demo|learning|course|sample|cheatsheet|playground)\b/i;

function haystack(c) {
  return norm([c.name, c.fullName, c.description, (c.topics || []).join(' ')].join(' '));
}

function scoreProject(c, info) {
  const hay = haystack(c);
  let s = 0;

  // 1. Corroboration : plusieurs sources independantes valent mieux qu'une.
  s += (c.sources.size - 1) * 26;
  if (c.sources.has('awesome')) s += 24;
  if (c.sources.has('forum')) s += 16;
  if (c.sources.has('web')) s += 8;
  if (c.sources.has('annuaire')) s += 8;

  // 2. Pertinence : le but demande doit se retrouver dans le projet.
  let hits = 0;
  for (const p of info.purpose) { if (p.length >= 3 && hay.includes(norm(p))) hits++; }
  s += hits * 18;
  if (info.purpose.length && hits === 0) s -= 20;
  for (const t of info.subjects) { if (t.length >= 3 && hay.includes(norm(t))) s += 10; }

  // 3. Popularite, echelle log : 200 et 20 000 etoiles ne doivent pas tout ecraser.
  if (c.stars) s += Math.min(40, Math.log10(c.stars + 1) * 13);
  if (c.hnPoints) s += Math.min(18, Math.log10(c.hnPoints + 1) * 9);
  if (c.npmScore) s += Math.min(12, c.npmScore / 8);

  // 4. Vitalite : un projet mort n'aide personne.
  const t = Date.parse(c.updated || '');
  if (Number.isFinite(t)) {
    const age = Date.now() - t;
    if (age < 6 * MONTH) s += 20;
    else if (age < 18 * MONTH) s += 8;
    else if (age > 36 * MONTH) s -= 25;
  }
  if (c.archived) s -= 45;
  if (c.isFork) s -= 15;

  // 5. Nature : on veut un produit, pas une brique ni un tutoriel.
  const text = (c.name || '') + ' ' + (c.description || '');
  if (LIBRARY_RE.test(text)) s -= 32;
  if (NOISE_RE.test(text)) s -= 30;
  if (/\bawesome\b|\bcurated list\b|\blist of\b/i.test(text)) s -= 25;

  // 6. Preferences explicites.
  if (info.selfHosted && c.kind === 'repo') s += 12;
  if (c.kind === 'repo' && !c.enriched) s -= 12;

  return Math.round(s);
}

/** Filtre dur : hors sujet = ecarte, meme tres populaire. */
function onSubject(c, info) {
  if (!info.subject) return true;
  const subj = norm(info.subject);
  if (subj.length < 3) return true;
  const hay = haystack(c) + ' ' + norm(c.url);
  return hay.includes(subj);
}

function installHint(c) {
  if (c.npmName) return 'npm install ' + c.npmName;
  if (c.kind === 'repo' && c.fullName) return 'git clone https://github.com/' + c.fullName + '.git';
  return '';
}

// ---------------------------------------------------------------- API publique

/**
 * Decouverte multi-sources.
 * @returns {Promise<{topic, results: Array, counts, queriesRun, notes}>}
 */
async function discover(query, opts = {}) {
  const timeout = opts.timeout || 12000;
  const limit = opts.limit || 8;
  const info = opts.classified || classify(query);
  const terms = info.searchTerms.length ? info.searchTerms : norm(query).split(/\s+/).slice(0, 4);
  const termLine = terms.join(' ');

  const notes = [];
  const queriesRun = [];

  const ghQueries = [
    `${termLine} in:name,description,readme`,
    `${termLine} in:name,description stars:>20`,
  ];
  if (info.ecosystem) {
    for (const t of info.ecosystem.topics.slice(0, 2)) {
      ghQueries.push(`topic:${t} ${info.purpose.slice(0, 2).join(' ')}`.trim());
    }
  }

  const webQueries = [
    `${termLine} open source github`,
    `best ${termLine}`,
  ];
  queriesRun.push(...ghQueries, ...webQueries);

  const npmText = info.ecosystem && info.ecosystem.npm
    ? `${info.ecosystem.npm} ${info.purpose.slice(0, 2).join(' ')}`.trim()
    : termLine;

  // Tout en parallele : une source lente ou en panne ne bloque pas les autres.
  const [gh, awesome, npm, hn, se, web, dirs] = await Promise.all([
    githubSearch(ghQueries, { timeout }).catch(() => []),
    awesomeLists(info, { timeout }).catch(() => []),
    npmSearch(npmText, { timeout }).catch(() => []),
    hackerNews(terms, { timeout }).catch(() => []),
    stackExchange(terms, { timeout }).catch(() => []),
    webExtra(webQueries, { timeout }).catch(() => []),
    directories(info, { timeout }).catch(() => []),
  ]);

  if (!gh.length) notes.push("GitHub n'a rien renvoye (quota API atteint ?)");
  if (!web.length && !dirs.length) notes.push('Les moteurs de recherche generalistes n\'ont pas repondu');

  const merged = mergeCandidates([gh, awesome, npm, hn, se, web, dirs]);
  const onTopic = merged.filter(c => onSubject(c, info));
  await enrichRepos(onTopic, { timeout, max: opts.maxEnrich || 12 });

  const results = onTopic
    .map(c => ({ ...c, sourcesList: [...c.sources], score: scoreProject(c, info) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(c => ({
      name: c.name,
      url: c.url,
      description: (c.description || '').slice(0, 200),
      stars: c.stars || 0,
      language: c.language || '',
      updated: c.updated ? String(c.updated).slice(0, 10) : '',
      license: c.license || '',
      archived: !!c.archived,
      homepage: c.homepage || '',
      citedBy: c.citedBy || '',
      sources: c.sourcesList,
      install: installHint(c),
      score: c.score,
    }));

  return {
    topic: info.topic || termLine,
    subject: info.subject,
    purpose: info.purpose,
    searchTerms: terms,
    ecosystem: info.ecosystem ? info.ecosystem.id : null,
    ecosystemHint: info.ecosystem ? info.ecosystem.hint : '',
    selfHosted: info.selfHosted,
    results,
    queriesRun,
    notes,
    counts: {
      github: gh.length, awesome: awesome.length, npm: npm.length,
      forum: hn.length + se.length, web: web.length, annuaire: dirs.length,
      fusionnes: merged.length, dansLeSujet: onTopic.length,
    },
  };
}

module.exports = {
  classify,
  discover,
  ECOSYSTEMS,
  _internals: { norm, buildTerms, scoreProject, mergeCandidates, parseAwesomeReadme, mapLimit, onSubject },
};
