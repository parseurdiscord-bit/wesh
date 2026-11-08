/* ==================================================================
   sources.js — recherche federee
   Les moteurs HTML se font bloquer un par un (captcha DuckDuckGo, 403
   Mojeek, 429 Brave, captcha Startpage/Ecosia) : batir la recherche sur
   eux seuls, c'est batir sur du sable. Ce module interroge en parallele
   des API qui rendent du contenu DEJA structure — extrait Wikipedia,
   reponse StackOverflow, description CVE, resume arXiv — donc utilisable
   sans ouvrir ni parser la moindre page.
   Chaque connecteur est isole : il ne jette jamais, il rend [] en cas
   d'echec, et un connecteur lent n'empeche pas les autres de repondre.
   Toutes les sources ici ont ete verifiees joignables sans cle d'API.
   ================================================================== */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TIMEOUT = parseInt(process.env.SOURCE_TIMEOUT, 10) || 8000;

/** Un connecteur ne doit jamais faire tomber la recherche entiere. */
async function getJson(url, { timeout = TIMEOUT, headers = {} } = {}) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

async function getText(url, { timeout = TIMEOUT, headers = {} } = {}) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': UA, ...headers },
    });
    if (!r.ok) return '';
    return await r.text();
  } catch (e) {
    return '';
  }
}

function clean(str, max = 1200) {
  return String(str || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Forme commune a toutes les sources. `texte` est deja de la matiere : quand
 *  il est rempli, il n'y a aucune page a aller ouvrir. */
function doc({ url, title, texte, source, poids = 1 }) {
  return { url: String(url || ''), title: clean(title, 200), texte: clean(texte, 1600), source, poids };
}

/** Mots-cles d'une requete, sans accents : sert a filtrer un flux ou un
 *  catalogue qui ne repond pas a une recherche (RSS, KEV, avis GitHub). */
function motsDe(q) {
  return String(q).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().split(/[^a-z0-9]+/).filter(m => m.length > 2);
}

/* ------------------------------------------------------------------
   Connecteurs
   ------------------------------------------------------------------ */

/** Wikipedia : la definition de reference, avec l'extrait du debut d'article. */
async function wikipedia(q, lang = 'fr') {
  const base = `https://${lang}.wikipedia.org/w/api.php`;
  const rech = await getJson(`${base}?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=3&origin=*`);
  const hits = rech?.query?.search || [];
  if (!hits.length) return [];

  const titres = hits.map(h => h.title);
  const extraits = await getJson(
    `${base}?action=query&prop=extracts&exintro=1&explaintext=1&format=json&origin=*&titles=${encodeURIComponent(titres.join('|'))}`
  );
  const pages = Object.values(extraits?.query?.pages || {});

  return hits.map(h => {
    const p = pages.find(x => x.title === h.title);
    return doc({
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`,
      title: h.title,
      texte: p?.extract || h.snippet,
      source: `wikipedia-${lang}`,
      poids: 1.15,
    });
  });
}

/** StackOverflow : des reponses acceptees, pas des articles de blog. */
async function stackexchange(q) {
  const data = await getJson(
    'https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&pagesize=5&site=stackoverflow&filter=!nNPvSNdWme' +
    `&q=${encodeURIComponent(q)}`
  );
  return (data?.items || [])
    .filter(i => i.score >= 0)
    .map(i => doc({
      url: i.link,
      title: i.title,
      texte: `${i.is_answered ? 'Question resolue' : 'Question ouverte'} · ${i.score} points · ${i.answer_count} reponses · tags: ${(i.tags || []).join(', ')}. ${clean(i.body, 900)}`,
      source: 'stackoverflow',
      poids: 1.2,
    }));
}

/** GitHub : le code qui existe deja, avec son activite reelle. */
async function github(q) {
  const data = await getJson(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=5&sort=stars`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  return (data?.items || []).map(r => doc({
    url: r.html_url,
    title: `${r.full_name} (${r.stargazers_count} etoiles)`,
    texte: `${r.description || ''} · langage: ${r.language || 'n/a'} · derniere activite: ${String(r.pushed_at || '').slice(0, 10)} · ${r.open_issues_count} issues ouvertes · licence: ${r.license?.spdx_id || 'n/a'}`,
    source: 'github',
    poids: 1.2,
  }));
}

/** Hacker News : la discussion technique, souvent plus juste que l'article. */
async function hackernews(q) {
  const data = await getJson(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=5`);
  return (data?.hits || [])
    .filter(h => h.url || h.story_text)
    .map(h => doc({
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      title: h.title,
      texte: `${h.points || 0} points · ${h.num_comments || 0} commentaires · ${String(h.created_at || '').slice(0, 10)}. ${h.story_text || ''}`,
      source: 'hackernews',
      poids: 1.05,
    }));
}

/** NVD : la base de vulnerabilites officielle du NIST. */
async function cve(q) {
  const data = await getJson(
    `https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=${encodeURIComponent(q)}&resultsPerPage=5`,
    { timeout: 12000 }
  );
  return (data?.vulnerabilities || []).map(v => {
    const c = v.cve || {};
    const desc = (c.descriptions || []).find(d => d.lang === 'en')?.value || '';
    const metrique = c.metrics?.cvssMetricV31?.[0]?.cvssData;
    return doc({
      url: `https://nvd.nist.gov/vuln/detail/${c.id}`,
      title: `${c.id}${metrique ? ` — CVSS ${metrique.baseScore} ${metrique.baseSeverity}` : ''}`,
      texte: `${desc} · publie le ${String(c.published || '').slice(0, 10)}${metrique ? ` · vecteur ${metrique.vectorString}` : ''}`,
      source: 'nvd-cve',
      poids: 1.3,
    });
  });
}

/** arXiv : la publication elle-meme, resume compris. */
async function arxiv(q) {
  const xml = await getText(`http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&max_results=4`);
  if (!xml) return [];
  const out = [];
  for (const bloc of xml.split('<entry>').slice(1)) {
    const lien = /<id>([^<]+)<\/id>/.exec(bloc);
    const titre = /<title>([\s\S]*?)<\/title>/.exec(bloc);
    const resume = /<summary>([\s\S]*?)<\/summary>/.exec(bloc);
    const date = /<published>([^<]+)<\/published>/.exec(bloc);
    if (!lien || !titre) continue;
    out.push(doc({
      url: lien[1],
      title: titre[1],
      texte: `${date ? `Publie le ${date[1].slice(0, 10)}. ` : ''}${resume ? resume[1] : ''}`,
      source: 'arxiv',
      poids: 1.15,
    }));
  }
  return out;
}

/** OpenAlex : la litterature academique tous editeurs confondus. */
async function openalex(q) {
  const data = await getJson(`https://api.openalex.org/works?search=${encodeURIComponent(q)}&per-page=4`);
  return (data?.results || []).map(w => {
    // OpenAlex stocke le resume sous forme d'index inverse : on le remonte.
    let resume = '';
    if (w.abstract_inverted_index) {
      const mots = [];
      for (const [mot, positions] of Object.entries(w.abstract_inverted_index)) {
        for (const p of positions) mots[p] = mot;
      }
      resume = mots.join(' ');
    }
    return doc({
      url: w.doi || w.id,
      title: w.title,
      texte: `${w.publication_year || ''} · ${w.cited_by_count || 0} citations. ${resume}`,
      source: 'openalex',
      poids: 1.1,
    });
  });
}

/** Registres de paquets : la version qui existe vraiment, pas celle imaginee. */
async function paquets(q) {
  const [npm, pypi, crates] = await Promise.all([
    getJson(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=3`),
    getJson(`https://pypi.org/pypi/${encodeURIComponent(q.split(/\s+/)[0])}/json`),
    getJson(`https://crates.io/api/v1/crates?q=${encodeURIComponent(q)}&per_page=3`),
  ]);

  const out = [];

  for (const o of npm?.objects || []) {
    const p = o.package || {};
    out.push(doc({
      url: p.links?.npm || `https://www.npmjs.com/package/${p.name}`,
      title: `npm: ${p.name}@${p.version}`,
      texte: `${p.description || ''} · publie le ${String(p.date || '').slice(0, 10)}`,
      source: 'npm',
      poids: 1.15,
    }));
  }

  if (pypi?.info?.name) {
    out.push(doc({
      url: pypi.info.project_url || pypi.info.package_url,
      title: `PyPI: ${pypi.info.name} ${pypi.info.version}`,
      texte: `${pypi.info.summary || ''} · licence ${pypi.info.license || 'n/a'} · requiert Python ${pypi.info.requires_python || 'n/a'}`,
      source: 'pypi',
      poids: 1.15,
    }));
  }

  for (const c of crates?.crates || []) {
    out.push(doc({
      url: `https://crates.io/crates/${c.id}`,
      title: `crates.io: ${c.name} ${c.max_version}`,
      texte: `${c.description || ''} · ${c.downloads || 0} telechargements`,
      source: 'crates',
      poids: 1.1,
    }));
  }

  return out;
}

/** Internet Archive : ce qui a ete efface reste consultable. */
async function archive(q) {
  const data = await getJson(
    `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=description&fl%5B%5D=year&rows=4&output=json`
  );
  return (data?.response?.docs || []).map(d => doc({
    url: `https://archive.org/details/${d.identifier}`,
    title: d.title,
    texte: `${d.year ? `${d.year}. ` : ''}${Array.isArray(d.description) ? d.description.join(' ') : d.description || ''}`,
    source: 'archive.org',
    poids: 0.95,
  }));
}

/** DuckDuckGo Instant Answer : la definition courte, sans captcha. */
async function instantAnswer(q) {
  const data = await getJson(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`);
  if (!data) return [];
  const out = [];
  if (data.AbstractText && data.AbstractURL) {
    out.push(doc({
      url: data.AbstractURL,
      title: data.Heading || q,
      texte: data.AbstractText,
      source: 'ddg-instant',
      poids: 1.1,
    }));
  }
  for (const t of (data.RelatedTopics || []).slice(0, 3)) {
    if (t.FirstURL && t.Text) {
      out.push(doc({ url: t.FirstURL, title: t.Text.slice(0, 90), texte: t.Text, source: 'ddg-instant', poids: 0.9 }));
    }
  }
  return out;
}

/* ------------------------------------------------------------------
   Forums et communautes — le retour d'experience, pas la fiche produit
   ------------------------------------------------------------------ */

/** Reddit. L'API JSON repond 403 a tout ce qui n'est pas OAuth ; le flux RSS
 *  de la recherche, lui, passe. C'est la seule voie qui tient sans cle. */
async function reddit(q, { sub = '', source = 'reddit', poids = 1.1 } = {}) {
  const chemin = sub ? `r/${sub}/search.rss?restrict_sr=1&` : 'search.rss?';
  const xml = await getText(`https://www.reddit.com/${chemin}q=${encodeURIComponent(q)}&limit=8&sort=relevance&type=link`);
  if (!xml) return [];
  const out = [];
  for (const bloc of xml.split('<entry>').slice(1)) {
    const lien = /<link[^>]*href="([^"]+)"/.exec(bloc);
    const titre = /<title[^>]*>([\s\S]*?)<\/title>/.exec(bloc);
    const contenu = /<content[^>]*>([\s\S]*?)<\/content>/.exec(bloc);
    const date = /<updated>([^<]+)<\/updated>/.exec(bloc) || /<published>([^<]+)<\/published>/.exec(bloc);
    if (!lien || !titre) continue;
    out.push(doc({
      url: lien[1],
      title: titre[1],
      texte: `${date ? date[1].slice(0, 10) + '. ' : ''}${clean(contenu ? contenu[1] : '', 1000)}`,
      source,
      poids,
    }));
  }
  return out;
}

/** Lemmy (fediverse) : l'equivalent libre de Reddit, son API repond en clair. */
async function lemmy(q) {
  const data = await getJson(
    `https://lemmy.world/api/v3/search?q=${encodeURIComponent(q)}&type_=Posts&sort=TopAll&listing_type=All&limit=6`
  );
  return (data?.posts || []).map(p => {
    const post = p.post || {};
    return doc({
      url: post.ap_id || post.url || '',
      title: post.name,
      texte: `${p.community?.name ? 'c/' + p.community.name + ' · ' : ''}${p.counts?.score || 0} points · ${p.counts?.comments || 0} commentaires. ${clean(post.body, 900)}`,
      source: 'lemmy',
      poids: 0.9,
    });
  });
}

/** Un site du reseau Stack Exchange. StackOverflow n'est qu'un site parmi
 *  d'autres : Security, Super User, Server Fault, Unix, Ask Ubuntu sont des
 *  forums a part entiere, chacun expert de son domaine. */
async function stackSite(q, site) {
  const data = await getJson(
    `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&pagesize=3&site=${site}` +
    `&filter=!nNPvSNdWme&q=${encodeURIComponent(q)}`
  );
  return (data?.items || [])
    .filter(i => i.score >= 0)
    .map(i => doc({
      url: i.link,
      title: `[${site}] ${i.title}`,
      texte: `${i.is_answered ? 'Resolue' : 'Ouverte'} · ${i.score} points · ${i.answer_count} reponses · tags: ${(i.tags || []).join(', ')}. ${clean(i.body, 800)}`,
      source: `stackexchange:${site}`,
      poids: 1.15,
    }));
}

/** Plusieurs sites Stack Exchange en parallele, fondus en une seule liste. */
async function stackNetwork(q, sites) {
  const lots = await Promise.all(sites.map(s => stackSite(q, s).catch(() => [])));
  return lots.flat();
}

/* ------------------------------------------------------------------
   Securite offensive — exploits, outils, actualite du milieu
   ------------------------------------------------------------------ */

/** hacktualites.com : actualite cybersecurite francophone. Le site tourne sous
 *  WordPress, dont l'API REST publique repond a une vraie recherche. */
async function hacktualites(q) {
  const data = await getJson(
    `https://hacktualites.com/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&per_page=5&_fields=title,link,excerpt,date`
  );
  if (!Array.isArray(data)) return [];
  return data.map(p => doc({
    url: p.link,
    title: clean(p.title?.rendered),
    texte: `${String(p.date || '').slice(0, 10)}. ${clean(p.excerpt?.rendered, 900)}`,
    source: 'hacktualites',
    poids: 1.05,
  }));
}

/** Un flux RSS de securite. Ces flux ne rendent que leurs dernieres entrees,
 *  pas une recherche : on filtre nous-memes sur les mots de la requete, et a
 *  defaut on garde les plus recentes — une veille brute vaut mieux que rien. */
async function fluxSecu(url, source, q, poids, { fallbackRecent = true } = {}) {
  const xml = await getText(url);
  if (!xml) return [];
  const mots = motsDe(q);
  const brut = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const bloc = m[1];
    const titre = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(bloc);
    const lien = /<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/.exec(bloc);
    const desc = /<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/.exec(bloc);
    const date = /<pubDate>([^<]+)<\/pubDate>/.exec(bloc);
    if (!titre || !lien) continue;
    const t = clean(titre[1]);
    const d = clean(desc ? desc[1] : '', 600);
    const hay = `${t} ${d}`.toLowerCase();
    const score = mots.reduce((n, w) => hay.includes(w) ? n + 1 : n, 0);
    brut.push({ score, d: doc({ url: lien[1].trim(), title: t, texte: `${date ? date[1].slice(0, 16) + '. ' : ''}${d}`, source, poids }) });
  }
  const touchent = brut.filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  if (touchent.length) return touchent.slice(0, 5).map(x => x.d);
  return fallbackRecent ? brut.slice(0, 3).map(x => x.d) : [];
}

/** Exploit-DB : la reference des preuves de concept, chaque entree liee a son
 *  exploit et souvent a une CVE. Le coeur d'un outil oriente securite. */
async function exploitdb(q) {
  return fluxSecu('https://www.exploit-db.com/rss.xml', 'exploit-db', q, 1.25);
}

/** KitPloit : la vitrine des outils offensifs, un par publication. */
async function kitploit(q) {
  return fluxSecu('https://www.kitploit.com/feeds/posts/default?alt=rss', 'kitploit', q, 1.0);
}

/** Les grands titres de la presse securite, fondus et filtres sur la requete.
 *  Un seul flux rate le sujet une fois sur deux ; six couvrent le terrain. */
const SECU_FEEDS = [
  ['https://feeds.feedburner.com/TheHackersNews', 'thehackernews'],
  ['https://www.bleepingcomputer.com/feed/', 'bleepingcomputer'],
  ['https://www.darkreading.com/rss.xml', 'darkreading'],
  ['https://securityaffairs.com/feed', 'securityaffairs'],
  ['https://isc.sans.edu/rssfeed_full.xml', 'sans-isc'],
  ['https://krebsonsecurity.com/feed/', 'krebs'],
];

async function securityNews(q) {
  const lots = await Promise.all(
    // Pas de repli "dernieres entrees" ici : fondre six vraies veilles ferait
    // dix-huit titres au hasard. On ne garde que ce qui touche la requete.
    SECU_FEEDS.map(([u, src]) => fluxSecu(u, src, q, 1.1, { fallbackRecent: false }).catch(() => []))
  );
  return lots.flat();
}

/** Full Disclosure : la liste de diffusion ou tombent les divulgations brutes. */
async function fullDisclosure(q) {
  return fluxSecu('https://seclists.org/rss/fulldisclosure.rss', 'full-disclosure', q, 1.15);
}

/** CISA KEV : le catalogue officiel des failles ACTIVEMENT exploitees. Quand
 *  une vulnerabilite y figure, elle n'est pas theorique — elle sert deja. */
async function cisaKev(q) {
  const data = await getJson('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json', { timeout: 12000 });
  const vulns = data?.vulnerabilities || [];
  const mots = motsDe(q);
  if (!mots.length) return [];
  return vulns
    .map(v => {
      const hay = `${v.cveID} ${v.vendorProject} ${v.product} ${v.vulnerabilityName} ${v.shortDescription}`.toLowerCase();
      return { v, s: mots.reduce((n, m) => hay.includes(m) ? n + 1 : n, 0) };
    })
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 5)
    .map(({ v }) => doc({
      url: `https://nvd.nist.gov/vuln/detail/${v.cveID}`,
      title: `${v.cveID} — ${v.vendorProject} ${v.product} (exploitee)`,
      texte: `${v.vulnerabilityName}. ${v.shortDescription} · ajoutee au catalogue le ${v.dateAdded}${v.requiredAction ? ' · action requise : ' + v.requiredAction : ''}`,
      source: 'cisa-kev',
      poids: 1.35,
    }));
}

/** Base d'avis de securite GitHub : les failles des dependances open source.
 *  Recherche directe par CVE si la question en cite une, sinon filtrage. */
async function githubAdvisory(q) {
  const cve = (String(q).match(/CVE-\d{4}-\d{4,7}/i) || [])[0];
  const url = cve
    ? `https://api.github.com/advisories?cve_id=${cve.toUpperCase()}`
    : 'https://api.github.com/advisories?per_page=40&sort=published&direction=desc';
  const data = await getJson(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (!Array.isArray(data)) return [];
  const mots = motsDe(q);
  const scored = cve
    ? data.map(a => ({ a, s: 1 }))
    : data.map(a => {
      const hay = `${a.summary || ''} ${a.description || ''} ${(a.identifiers || []).map(i => i.value).join(' ')}`.toLowerCase();
      return { a, s: mots.reduce((n, m) => hay.includes(m) ? n + 1 : n, 0) };
    }).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
  return scored.slice(0, 4).map(({ a }) => doc({
    url: a.html_url,
    title: `${a.ghsa_id}${a.cve_id ? ' / ' + a.cve_id : ''} — ${a.severity || 'n/a'}`,
    texte: `${a.summary || ''}. ${clean(a.description, 700)} · ecosystemes : ${(a.vulnerabilities || []).map(v => v.package?.ecosystem).filter(Boolean).join(', ') || 'n/a'}`,
    source: 'github-advisory',
    poids: 1.2,
  }));
}

/** Reddit, mais restreint aux communautes securite : c'est la que se partagent
 *  les techniques, les writeups et les retours de terrain. */
async function redditSecu(q) {
  return reddit(q, {
    sub: 'netsec+hacking+AskNetsec+blackhat+Malware+ReverseEngineering+cybersecurity+HowToHack',
    source: 'reddit-secu',
    poids: 1.15,
  });
}

/* ------------------------------------------------------------------
   Routage : quelles sources pour quelle question
   ------------------------------------------------------------------ */

const RE_CODE = /\b(code|coder|fonction|function|api|sdk|cli|librairie|library|bibliotheque|framework|npm|pnpm|yarn|pip|cargo|composer|gem|package|paquet|module|dependance|erreur|error|exception|stack ?trace|bug|debug|compil|build|deploy|fuite memoire|memory leak|performance|latence|typescript|javascript|node|nodejs|deno|bun|react|vue|angular|svelte|next\.?js|python|django|flask|rust|golang|\bgo\b|java|kotlin|swift|dotnet|c\+\+|php|laravel|ruby|rails|sql|postgres|mysql|mongo|redis|docker|kubernetes|nginx|linux|bash|git|regex|algorithme|serveur|backend|frontend)\b/i;
const RE_SECU = /\b(cve|faille|vulnerabilit|exploit|ransomware|rancongiciel|malware|botnet|payload|injection|xss|csrf|ssrf|rce|lfi|privilege|backdoor|rootkit|phishing|hameconnage|chiffrement|patch|correctif|0day|zero-?day|pentest|osint|forensic|siem|edr|firewall|authentification|mot de passe|fuite de donnees|breach)\b/i;
const RE_SCIENCE = /\b(etude|study|recherche scientifique|papier|paper|publication|these|revue|modele|dataset|benchmark|arxiv|neural|reseau de neurones|machine learning|deep learning|quantique|biologie|chimie|physique|medecine|climat|statistique)\b/i;
const RE_ACTU = /\b(actualit|news|recent|derniere|dernier|nouveaut|sortie|version|changelog|202[4-9]|aujourd'hui|cette semaine|ce mois|maintenant)\b/i;

/**
 * Choisit les connecteurs a lancer. Wikipedia et la reponse instantanee sont
 * toujours la (elles cadrent le sujet pour presque rien) ; le reste depend de
 * ce que la question demande vraiment.
 */
/** Sans accents et sans ponctuation : ce que comprennent les API anglophones. */
function ascii(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s.+#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Les connecteurs recoivent des mots-cles, jamais la phrase de l'utilisateur.
 * Mesure faite : « comment corriger une fuite memoire en Node.js » envoye tel
 * quel a Wikipedia remonte « ChatGPT » et « Maladie d'Alzheimer », et les API
 * anglophones ne rendent rien du tout. Les requetes planifiees par le modele
 * sont deja ce qu'il faut ; on prend la plus anglophone pour les API qui n'ont
 * que de l'anglais en base.
 */
function choisirRequetes(requetes, question) {
  const liste = (Array.isArray(requetes) ? requetes : [requetes]).filter(Boolean).map(String);
  if (!liste.length) return { principale: ascii(question), anglaise: ascii(question) };

  const principale = liste[0];
  // Le plus de mots sans accent l'emporte : c'est la requete pensee en anglais.
  const anglaise = liste
    .slice()
    .sort((a, b) => {
      const acc = t => (t.match(/[à-öø-ÿ]/gi) || []).length;
      return acc(a) - acc(b) || b.length - a.length;
    })[0];

  return { principale, anglaise: ascii(anglaise) };
}

function routerSources(requetes, { tout = false, question = '' } = {}) {
  const { principale, anglaise } = choisirRequetes(requetes, question);
  // Le routage lit la question ET les requetes : « fuite memoire » cote
  // utilisateur, « memory leak node » cote planificateur, l'un des deux suffit.
  const sujet = [question, ...(Array.isArray(requetes) ? requetes : [requetes])].join(' ');

  // Socle toujours actif : l'encyclopedie cadre le sujet, et les forums donnent
  // le retour d'experience — c'est la que se dit ce qu'une fiche produit tait.
  // Reddit et Lemmy partent sur CHAQUE recherche : « chercher partout » commence
  // par ecouter les gens, pas seulement les pages officielles.
  const actifs = new Map([
    ['wikipedia-fr', () => wikipedia(principale, 'fr')],
    ['ddg-instant', () => instantAnswer(principale)],
    ['reddit', () => reddit(anglaise)],
    ['lemmy', () => lemmy(anglaise)],
    ['hackernews', () => hackernews(anglaise)],
  ]);

  const ajoute = (nom, fn) => actifs.set(nom, fn);

  if (tout || RE_CODE.test(sujet)) {
    ajoute('stackoverflow', () => stackexchange(anglaise));
    ajoute('github', () => github(anglaise));
    ajoute('paquets', () => paquets(anglaise));
    ajoute('stack-network', () => stackNetwork(anglaise, ['superuser', 'serverfault', 'unix', 'askubuntu', 'dba']));
  }
  if (tout || RE_SECU.test(sujet)) {
    ajoute('nvd-cve', () => cve(anglaise));
    ajoute('github-secu', () => github(anglaise));
    // Security Stack Exchange : le forum ou pentesters et defenseurs debattent.
    ajoute('stack-security', () => stackNetwork(anglaise, ['security', 'reverseengineering', 'crypto']));
    // Le milieu lui-meme : exploits references, outils du jour, actualite.
    ajoute('exploit-db', () => exploitdb(anglaise));
    ajoute('kitploit', () => kitploit(anglaise));
    ajoute('hacktualites', () => hacktualites(principale));
    ajoute('security-news', () => securityNews(anglaise));
    ajoute('full-disclosure', () => fullDisclosure(anglaise));
    // Failles activement exploitees et avis des dependances open source.
    ajoute('cisa-kev', () => cisaKev(anglaise));
    ajoute('github-advisory', () => githubAdvisory(anglaise));
    // Les communautes securite en plus du Reddit generaliste du socle : une
    // question de hacking ecoute AUSSI r/netsec, r/hacking, r/ReverseEngineering.
    ajoute('reddit-secu', () => redditSecu(anglaise));
  }
  if (tout || RE_ACTU.test(sujet)) {
    ajoute('hacktualites', () => hacktualites(principale));
  }
  if (tout || RE_SCIENCE.test(sujet)) {
    ajoute('arxiv', () => arxiv(anglaise));
    ajoute('openalex', () => openalex(anglaise));
  }
  if (tout) {
    ajoute('wikipedia-en', () => wikipedia(anglaise, 'en'));
    ajoute('archive', () => archive(anglaise));
    // En mode « tout », on ratisse aussi les sites Stack Exchange transverses.
    ajoute('stack-extra', () => stackNetwork(anglaise, ['softwarerecs', 'apple', 'android', 'webapps']));
  }

  return actifs;
}

/**
 * Interroge toutes les sources retenues en parallele. Une source muette ou
 * lente ne retient personne : chacune a son propre delai et ses propres
 * erreurs, le lot revient avec ce qui a repondu.
 */
async function federatedSearch(requetes, { tout = false, parSource = 4, question = '' } = {}) {
  const actifs = routerSources(requetes, { tout, question });
  const noms = [...actifs.keys()];
  const lots = await Promise.allSettled([...actifs.values()].map(fn => fn()));

  const vues = new Set();
  const out = [];
  lots.forEach((lot, i) => {
    if (lot.status !== 'fulfilled' || !Array.isArray(lot.value)) return;
    for (const d of lot.value.slice(0, parSource)) {
      // Sur un forum, le titre porte le sens (« Best password manager for
      // Linux? ») meme quand le post est un simple lien sans corps : on juge
      // titre ET texte reunis, sinon Reddit et Lemmy passaient a la trappe.
      if (!d.url || (`${d.title} ${d.texte}`).trim().length < 40) continue;
      const cle = d.url.split(/[?#]/)[0].toLowerCase();
      if (vues.has(cle)) continue;
      vues.add(cle);
      out.push(d);
    }
  });

  return { docs: out, sources: noms };
}

module.exports = {
  federatedSearch,
  routerSources,
  choisirRequetes,
  reddit,
  lemmy,
  stackSite,
  stackNetwork,
  hacktualites,
  exploitdb,
  kitploit,
  securityNews,
  fullDisclosure,
  cisaKev,
  githubAdvisory,
  redditSecu,
  wikipedia,
  stackexchange,
  github,
  hackernews,
  cve,
  arxiv,
  openalex,
  paquets,
  archive,
  instantAnswer,
};
