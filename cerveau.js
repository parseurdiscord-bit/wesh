'use strict';

/**
 * cerveau.js — Base de connaissances documentaire ("cerveau")
 *
 * Indexe les fichiers déposés dans le dossier cerveau/, organisés en
 * sous-dossiers par thème. À chaque question posée au chat, on recherche les
 * documents pertinents (priorité au nom de dossier / de fichier, puis au
 * contenu) et on les fournit au modèle comme contexte de référence.
 *
 * Formats supportés : texte, HTML, images (métadonnées), ZIP (contenu texte).
 * Aucun appel réseau : tout se fait en local.
 */

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');

let AdmZip = null;
try { AdmZip = require('adm-zip'); } catch (_) {}

let yauzl = null;
try { yauzl = require('yauzl'); } catch (_) {}

// Extensions lues comme texte brut
const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.text', '.json', '.csv', '.log']);
const HTML_EXT = new Set(['.html', '.htm']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const ARCHIVE_EXT = new Set(['.zip', '.rar']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mkv', '.mov', '.avi', '.m4v', '.wmv', '.ogv']);
const DOWNLOAD_EXT = new Set([...ARCHIVE_EXT, ...VIDEO_EXT]);

const INDEXABLE_EXT = new Set([
  ...TEXT_EXT,
  ...HTML_EXT,
  ...IMAGE_EXT,
  ...DOWNLOAD_EXT,
]);

// Extensions texte/code extractibles depuis un ZIP
const ZIP_INNER_EXT = new Set([
  ...TEXT_EXT,
  ...HTML_EXT,
  '.js', '.ts', '.jsx', '.tsx', '.py', '.lua', '.cs', '.cpp', '.c', '.h', '.hpp',
  '.java', '.go', '.rs', '.php', '.rb', '.sh', '.bat', '.ps1', '.sql', '.xml',
  '.yaml', '.yml', '.ini', '.cfg', '.conf', '.env', '.toml', '.vue', '.svelte',
]);

// Garde-fous
const MAX_FILE_BYTES = 512 * 1024;       // fichiers texte/html
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024; // archives zip/rar
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;   // vidéos
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;   // images
const MAX_ZIP_ENTRIES = 200;
const MAX_ZIP_ENTRY_BYTES = 512 * 1024;
const MAX_INNER_PER_ZIP = 100;
const MAX_DOCS = 5000;
const MAX_DEPTH = 8;

// Mots vides français + anglais (ignorés dans le score)
const STOP = new Set((
  'le la les un une des de du au aux et ou ou a as à en dans par pour sur sous avec sans ' +
  'ce cet cette ces mon ton son ma ta sa mes tes ses nos vos leur leurs que qui quoi dont ' +
  'est sont suis es etes etre avoir fait fais faire il elle ils elles je tu nous vous on ne pas ' +
  'the a an of to in on for and or is are be was were it this that these those my your his her ' +
  'with without from as at by we you they i me give moi donne veux want need how comment ' +
  'peux peut pouvez pourrais pourrait voudrais aimerais stp svp please merci direct truc chose ' +
  'juste aussi plait sil te ca ok bon salut hey voila voilà ici bas quand donner trouver ' +
  'chercher trouve trouves cherches cherche'
).split(/\s+/).filter(Boolean));

const BRAIN_META_RE = /\b(cerveau|base de connaissances?|documents? internes?|fichiers? internes?|dans ton cerveau|du cerveau|de ton cerveau|dans le cerveau|utilise le cerveau|cherche dans le cerveau|regarde dans le cerveau|ton cerveau|le cerveau)\b/gi;

/** Convertit le leet speak courant pour la recherche (b0t → bot, d1sc0rd → discord). */
function leetSpeak(s) {
  return String(s || '')
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/8/g, 'b');
}

/** L'utilisateur demande-t-il explicitement quelque chose du cerveau ? */
function isBrainIntent(query) {
  const q = String(query || '').toLowerCase();
  if (/\bcerveau\b/.test(q)) return true;
  if (/\b(base de connaissances|documents internes|fichiers internes)\b/.test(q)) return true;
  if (/\b(dans ton cerveau|du cerveau|de ton cerveau|dans le cerveau)\b/.test(q)) return true;
  return /\b(cherche|regarde|utilise|lis|montre|donne)\b.*\b(cerveau|interne)\b/.test(q);
}

/** L'utilisateur demande-t-il une photo/image du cerveau ? */
function isImageRequest(query) {
  const q = String(query || '').toLowerCase().trim();
  if (/^\/img\b|^\/image\s/.test(q)) return true;
  if (/\b(genere|génère|generer|générer|creer|crée|créer|fabrique)\b/.test(q) && /\b(image|photo)\b/.test(q)) {
    return false;
  }
  if (/\b(photo|photos|image|images|screenshot|capture|png|jpg|jpeg|gif|webp)\b/.test(q)) {
    return /\b(montre|envoie|donne|voir|affiche|pass|cherche|une|la|le|les|des|du|de|moi|ca|cette|ce|ton|ta|tes|peux|pourrais|cerveau)\b/.test(q)
      || q.split(/\s+/).length <= 6;
  }
  return false;
}

/** L'utilisateur attend-il un livrable concret du cerveau (lien, fichier, media) ? */
function expectsBrainResource(query) {
  if (isImageRequest(query) || isDownloadRequest(query)) return true;
  const q = String(query || '').toLowerCase();
  if (/\b(lien|liens|link|links|url|urls|fichier|fichiers|file|files|archive|archives|zip|rar)\b/.test(q)) {
    return true;
  }
  if (/\b(envoie|donne|montre|pass|telecharge|télécharge|download|recupere|récupère)\b/.test(q) &&
    /\b(photo|photos|video|videos|vidéo|vidéos|image|images|lien|liens|fichier|fichiers|zip|archive|rar)\b/.test(q)) {
    return true;
  }
  return false;
}

function mimeFromExt(ext) {
  const map = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
    '.zip': 'application/zip', '.rar': 'application/vnd.rar',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
    '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.m4v': 'video/x-m4v',
    '.wmv': 'video/x-ms-wmv', '.ogv': 'video/ogg',
  };
  return map[ext] || 'application/octet-stream';
}

/** L'utilisateur demande-t-il un fichier téléchargeable du cerveau (ZIP/RAR/vidéo) ? */
function isDownloadRequest(query) {
  const q = String(query || '').toLowerCase();
  if (/\b(zip|rar|archive|fichier compresse|fichier compressé)\b/.test(q)) return true;
  if (/\b(video|videos|vidéo|vidéos|film|clip|mp4|webm|mkv|mov|avi|m4v|wmv)\b/.test(q)) return true;
  if (/\b(telecharg\w*|télécharg\w*|download)\b/.test(q)) return true;
  // « bots discord » = archives ZIP du cerveau, comme les vidéos
  if (/\b(bots?)\b/.test(q) && /\b(discord|discords?)\b/.test(q)) return true;
  if (/\b(source|sources|code source)\b/.test(q) && /\b(bots?|discord)\b/.test(q)) return true;
  return /\b(montre|envoie|donne|pass|envoi|fichier|file)\b/.test(q) &&
    /\b(zip|rar|archive|fichier|file|video|vidéo|mp4|webm|mkv|mov|avi|m4v|wmv|bot|bots)\b/.test(q);
}

/** @deprecated alias */
function isArchiveRequest(query) {
  return isDownloadRequest(query);
}

/** Mots qui suivent « donne-moi » sans designer un logiciel. */
const NOT_A_TOOL_RE = /\b(exemple|exemples|code|script|scripts|conseil|conseils|idee|idees|idée|idées|info|infos|information|informations|reponse|réponse|aide|avis|prix|tarif|numero|numéro|adresse|resume|résume|résumé|explication|definition|définition|tuto|tutoriel|cours|liste|photo|photos|image|images|video|videos|vidéo|vidéos|nom|noms|texte|message|phrase|blague|histoire|recette|methode|méthode|technique|solution|truc|chose|argent|temps|heure|date|news|actu)\b/;

/** Vocabulaire explicite « logiciel / fichier a installer ». */
const TOOL_WORD_RE = /\b(logiciel|logiciels|soft|softs|software|programme|programmes|application|applications|appli|applis|outil|outils|tool|tools|utilitaire|utilitaires|plugin|plugins|extension|extensions|addon|add-on|mod|driver|drivers|pilote|pilotes|installeur|installateur|setup|portable|exe|msi|dmg|appimage|apk|deb|police|polices|font|fonts)\b/;

/**
 * Detecte une demande d'outil / logiciel / fichier a livrer.
 * Ex: « donne moi bltool », « t'aurais pas obs ? », « lien pour 7zip »,
 *     « il me faut un truc pour compresser des videos ».
 */
function isToolRequest(query) {
  const q = String(query || '').toLowerCase();
  if (!q.trim()) return false;

  // 1. Vocabulaire logiciel explicite
  if (TOOL_WORD_RE.test(q)) return true;

  // 2. Formulations « ou telecharger X » / « lien pour X » / « derniere version de X »
  if (/\b(ou|où)\s+(trouver|telecharger|télécharger|dl|choper)\b/.test(q)) return true;
  if (/\blien\s+(pour|de|vers|du|d'|direct)/.test(q)) return true;
  if (/\b(derniere|dernière)\s+version\b/.test(q)) return true;
  if (/\b(installer|install)\s+[a-z0-9][\w.+-]{2,}/.test(q)) return true;

  // 3. « donne moi <nom de produit> » : verbe de demande + sujet court non générique
  if (!/\b(donne|donnes|envoie|envoi|envoies|file|files|passe|balance|refile|fournis|t'aurais|taurais|tu aurais|t'as|tas|tu as|je veux|je voudrais|il me faut|besoin de|cherche|recherche)\b/.test(q)) {
    return false;
  }
  if (NOT_A_TOOL_RE.test(q)) return false;

  const topic = extractTopic(q)
    .replace(/\b(t'aurais|taurais|tu|aurais|as|t'as|tas|je|veux|voudrais|il|me|faut|besoin|de|du|des|un|une|le|la|les|pour|avec|sur|stp|svp|please|merci|pas|nn|non|ya|y a|hein|frere|frère|mec|bro)\b/g, ' ')
    .replace(/[^a-z0-9\u00e0-\u00ff .+_-]/g, ' ')
    .trim();

  const tokens = topic.split(/\s+/).filter(t => t.length >= 2);
  if (!tokens.length || tokens.length > 4) return false;
  // Au moins un token qui ressemble a un nom de produit (>=3 car., pas 100% chiffres)
  return tokens.some(t => t.length >= 3 && /[a-z\u00e0-\u00ff]/.test(t));
}

/** Retire les mots liés au cerveau pour ne garder que le sujet recherché. */
function extractTopic(query) {
  return String(query || '')
    .replace(BRAIN_META_RE, ' ')
    .replace(/\b(nn|non|pas|invente|inventes|inventer|inventes pas)\b/gi, ' ')
    .replace(/\b(photo|photos|image|images|screenshot|capture|affiche|montre|envoie|envoi|donne|voir)\b/gi, ' ')
    .replace(/\b(zip|rar|archive|fichier|file|telecharg\w*|télécharg\w*|download|video|videos|vidéo|vidéos|film|clip|mp4|webm|mkv|mov|avi|m4v|wmv)\b/gi, ' ')
    .replace(/\b(moi|toi|lui|elle|eux|elles|quelqu|quelle|quels|quelles|cette|celui|celle|ceux|celles)\b/gi, ' ')
    .replace(/\b(peux|peut|pouvez|pourrais|voudrais|aimerais|stp|svp|please|merci|direct|truc|chose|juste)\b/gi, ' ')
    .replace(/\b(donner|trouver|chercher|trouve|trouves|cherches|cherche)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Dossier « sujet » (ex. aisha-sofey) extrait du chemin cerveau. */
function extractSubjectFolder(folder) {
  const parts = String(folder || '').replace(/\\/g, '/').split('/').filter(Boolean);
  const meaningful = parts.filter(p => !/^fichiers$/i.test(p));
  return meaningful[meaningful.length - 1] || '';
}

/** Découpe un chemin en mots significatifs (dossiers + nom de fichier). */
function pathWords(...parts) {
  const words = [];
  for (const p of parts) {
    for (const seg of String(p || '').split(/[/\\]+/)) {
      for (const w of seg.split(/[^a-z0-9]+/i)) {
        const n = normalize(w);
        if (n.length >= 2 && !STOP.has(n)) words.push(n);
      }
    }
  }
  return words;
}

/** Variantes d'un jeton (pluriel FR/EN : bots ↔ bot). */
function tokenVariants(t) {
  const w = String(t || '');
  const out = [w];
  if (w.length >= 3 && w.endsWith('s')) out.push(w.slice(0, -1));
  else if (w.length >= 3) out.push(w + 's');
  return out;
}

function wordMatchesToken(word, token) {
  const variants = tokenVariants(token);
  if (variants.includes(word)) return true;
  if (token.length >= 4 && word.length >= 3) {
    const ratio = Math.min(word.length, token.length) / Math.max(word.length, token.length);
    if (ratio >= 0.85 && (word.startsWith(token) || token.startsWith(word))) return true;
  }
  return false;
}

/**
 * Score strict d'un fichier média (image/vidéo) contre une requête.
 * Priorité au dossier sujet (nom de la personne), pas aux noms Discord aléatoires.
 */
function scoreMediaMatch(item, query) {
  const topic = extractTopic(query);
  const rawQuery = topic.length >= 2 ? topic : query;
  const tokens = [...new Set(tokenize(rawQuery))];
  if (!tokens.length) return { score: 0, matched: 0, subjectKey: '' };

  const subject = normalize(extractSubjectFolder(item.folder));
  const subjectWords = pathWords(subject);
  const folderWords = pathWords(item.folder);
  const fileWords = pathWords(item.name);
  const subjectKey = subject.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const phrase = tokens.join(' ');
  const phraseHyphen = tokens.join('-');

  let score = 0;
  let matched = 0;

  if (tokens.length > 1) {
    const subjectSpaced = subject.replace(/[^a-z0-9]+/g, ' ').trim();
    if (subject.includes(phraseHyphen) || subjectSpaced.includes(phrase)) {
      return { score: 80, matched: tokens.length, subjectKey };
    }
    // « bots discord » vs dossier bot-discord
    const folded = tokens.map(t => tokenVariants(t)[0] === t && t.endsWith('s') ? t.slice(0, -1) : t);
    const foldedPhrase = folded.join(' ');
    const foldedHyphen = folded.join('-');
    if (subject.includes(foldedHyphen) || subjectSpaced.includes(foldedPhrase)) {
      return { score: 80, matched: tokens.length, subjectKey };
    }
  }

  for (const t of tokens) {
    let tokenMatched = false;

    if (subjectWords.some(sw => wordMatchesToken(sw, t))) {
      score += 30;
      tokenMatched = true;
    } else if (t.length >= 4) {
      for (const sw of subjectWords) {
        if (wordMatchesToken(sw, t)) { score += 30; tokenMatched = true; break; }
      }
    }

    if (!tokenMatched && folderWords.some(fw => wordMatchesToken(fw, t))) {
      score += 14;
      tokenMatched = true;
    }

    if (!tokenMatched && t.length >= 3 && fileWords.some(fw => wordMatchesToken(fw, t))) {
      score += 5;
      tokenMatched = true;
    }

    if (tokenMatched) matched++;
  }

  const subjectHit = tokens.some(t =>
    subjectWords.some(sw => wordMatchesToken(sw, t))
  );

  if (tokens.length > 1 && matched < tokens.length) {
    if (!subjectHit || matched < Math.min(2, tokens.length)) {
      return { score: 0, matched, subjectKey: '' };
    }
  }

  if (tokens.length === 1 && !subjectHit && !folderWords.some(fw => wordMatchesToken(fw, tokens[0]))) {
    return { score: 0, matched, subjectKey: '' };
  }

  if (!subjectHit) score = Math.floor(score * 0.5);

  return { score, matched, subjectKey: subjectHit ? subjectKey : '' };
}

/** Recherche média partagée (images / vidéos / archives). */
function searchMediaPool(pool, query, opts = {}) {
  const maxItems = opts.maxItems || 30;
  const minScore = opts.minScore || 12;
  if (!pool.length) return [];

  const scored = [];
  for (const item of pool) {
    const { score, subjectKey } = scoreMediaMatch(item, query);
    if (score >= minScore) scored.push({ item, score, subjectKey });
  }

  if (!scored.length) return [];

  scored.sort((a, b) => b.score - a.score);

  const topScore = scored[0].score;
  const topKey = scored[0].subjectKey;
  const filtered = scored.filter(s =>
    s.score >= topScore * 0.7 &&
    (!topKey || !s.subjectKey || s.subjectKey === topKey)
  );

  return filtered.slice(0, maxItems).map(s => s.item);
}

/** La requête cible-t-elle une vidéo (pas une archive ZIP) ? */
function isVideoRequest(query) {
  return /\b(video|videos|vidéo|vidéos|film|clip|mp4|webm|mkv|mov|avi|m4v|wmv)\b/i.test(String(query || ''));
}

/** Supprime les balises HTML pour indexer le texte visible. */
function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Formate une taille lisible. */
function fmtBytes(bytes) {
  if (bytes < 1024) return bytes + ' o';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' Ko';
  return (bytes / 1024 / 1024).toFixed(1) + ' Mo';
}

/** Vérifie qu'un buffer ressemble à du texte (pas binaire). */
function looksLikeText(buf) {
  if (!buf || buf.length === 0) return false;
  const sample = buf.slice(0, Math.min(512, buf.length));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return false;
  }
  return true;
}

/** Un fichier dans un ZIP est-il extractible comme texte ? */
function isZipInnerText(entryName) {
  const ext = path.extname(entryName).toLowerCase();
  if (ZIP_INNER_EXT.has(ext)) return true;
  if (!ext) return true;
  return false;
}

/** Lit le contenu texte d'une entrée ZIP. */
function readZipEntryText(entry) {
  const buf = entry.getData();
  if (!buf || buf.length === 0 || buf.length > MAX_ZIP_ENTRY_BYTES) return null;
  if (!looksLikeText(buf)) return null;
  const entryExt = path.extname(entry.entryName).toLowerCase();
  let raw;
  try { raw = buf.toString('utf8'); } catch (_) { return null; }
  if (!raw.trim()) return null;
  return HTML_EXT.has(entryExt) ? stripHtml(raw) : raw;
}

/**
 * Extrait les fichiers texte d'une archive ZIP.
 * @returns {{ inner: Array<{path,content}>, summary: string }}
 */
function extractZipEntries(abs, zipRel, zipName) {
  if (!AdmZip) {
    return { inner: [], summary: `[Archive ZIP] ${zipName} — module adm-zip absent.` };
  }

  const inner = [];
  const fileList = [];

  try {
    const zip = new AdmZip(abs);
    const entries = zip.getEntries().slice(0, MAX_ZIP_ENTRIES);

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const entryPath = entry.entryName.replace(/\\/g, '/');
      fileList.push(entryPath);

      if (!isZipInnerText(entryPath)) continue;
      if (entry.header.size <= 0 || entry.header.size > MAX_ZIP_ENTRY_BYTES) continue;

      try {
        const text = readZipEntryText(entry);
        if (text) {
          inner.push({
            path: entryPath,
            content: text.slice(0, MAX_ZIP_ENTRY_BYTES),
          });
        }
      } catch (_) {}
    }
  } catch (_) {
    return { inner: [], summary: `[Archive ZIP] ${zipName} — archive illisible.` };
  }

  let summary = `[Archive ZIP] ${zipName} (${zipRel})`;
  if (inner.length) {
    summary += ` — ${inner.length} fichier(s) texte extrait(s).`;
  } else if (fileList.length) {
    summary += ` — contenu: ${fileList.slice(0, 40).join(', ')}`;
  } else {
    summary += ' — archive vide.';
  }

  return { inner, summary };
}

/** Liste les noms de fichiers dans un ZIP (sans extraire le contenu). */
function listZipEntries(abs) {
  const names = [];
  if (!AdmZip) return names;
  try {
    for (const entry of new AdmZip(abs).getEntries().slice(0, MAX_ZIP_ENTRIES)) {
      if (!entry.isDirectory) names.push(entry.entryName.replace(/\\/g, '/'));
    }
  } catch (_) {}
  return names;
}
/** Liste les images contenues dans une archive ZIP. */
function extractZipImages(abs) {
  const found = [];
  if (!AdmZip) return found;
  try {
    const zip = new AdmZip(abs);
    for (const entry of zip.getEntries().slice(0, MAX_ZIP_ENTRIES)) {
      if (entry.isDirectory) continue;
      const entryPath = entry.entryName.replace(/\\/g, '/');
      const ext = path.extname(entryPath).toLowerCase();
      if (!IMAGE_EXT.has(ext)) continue;
      if (entry.header.size <= 0 || entry.header.size > MAX_IMAGE_BYTES) continue;
      found.push({ path: entryPath });
    }
  } catch (_) {}
  return found;
}

/** Construit tf + nameSet pour un document. */
function buildDocIndex(rel, folder, name, content, extraTokens = '') {
  const nameSet = new Set(tokenize(folder + ' ' + name + ' ' + extraTokens + ' ' + rel));
  const tf = new Map();
  for (const t of tokenize(content)) tf.set(t, (tf.get(t) || 0) + 1);
  return { rel, folder, name, content, nameSet, tf };
}

/** @deprecated — utilise extractZipEntries */
function extractZipContent(abs, rel, name) {
  const { inner, summary } = extractZipEntries(abs, rel, name);
  if (!inner.length) return summary;
  return summary + '\n\n' + inner.map(i =>
    `=== ${i.path} ===\n${i.content.slice(0, 8000)}`
  ).join('\n\n');
}

/** Construit un contenu indexable selon le type de fichier. */
function extractFileContent(abs, ext, name, rel, size) {
  if (TEXT_EXT.has(ext)) {
    return fs.readFileSync(abs, 'utf8');
  }
  if (HTML_EXT.has(ext)) {
    return stripHtml(fs.readFileSync(abs, 'utf8'));
  }
  if (IMAGE_EXT.has(ext)) {
    return `[Image] ${name} (${fmtBytes(size)}) — chemin: ${rel}`;
  }
  if (ext === '.zip') {
    return extractZipContent(abs, rel, name);
  }
  if (ext === '.rar') {
    return `[Archive RAR] ${name} (${fmtBytes(size)}) — chemin: ${rel}. Recherchable par nom.`;
  }
  return null;
}

/** Taille max autorisée pour un type de fichier. */
function maxBytesForExt(ext) {
  if (ARCHIVE_EXT.has(ext)) return MAX_ARCHIVE_BYTES;
  if (VIDEO_EXT.has(ext)) return MAX_VIDEO_BYTES;
  if (IMAGE_EXT.has(ext)) return MAX_IMAGE_BYTES;
  return MAX_FILE_BYTES;
}

function maxDownloadBytes(ext) {
  if (ARCHIVE_EXT.has(ext)) return MAX_ARCHIVE_BYTES;
  if (VIDEO_EXT.has(ext)) return MAX_VIDEO_BYTES;
  return MAX_FILE_BYTES;
}

/** Indique si un fichier peut être indexé. */
function isIndexableExt(ext) {
  return INDEXABLE_EXT.has(ext);
}

/** Raison d'exclusion pour l'explorateur admin. */
function skipReasonForFile(ext, size) {
  if (!isIndexableExt(ext)) return 'format';
  if (size === 0) return 'empty';
  if (size > maxBytesForExt(ext)) return 'too_large';
  return null;
}

/** Minuscule + suppression des accents pour comparer sans se soucier des é/è/à. */
function normalize(s) {
  return leetSpeak(String(s || ''))
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Découpe une chaîne en jetons significatifs. */
function tokenize(s) {
  return normalize(s)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(w => w.length >= 2 && !STOP.has(w));
}

/** Extrait le passage le plus pertinent d'un document (fenêtre autour d'un mot-clé). */
function bestSnippet(content, qTokens, perDocChars) {
  const clean = content.trim();
  if (clean.length <= perDocChars) return clean;

  const norm = normalize(clean);
  let pos = -1;
  for (const t of qTokens) {
    const i = norm.indexOf(t);
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  if (pos < 0) return clean.slice(0, perDocChars).trim() + '…';

  let start = Math.max(0, pos - Math.floor(perDocChars * 0.25));
  // On recule jusqu'à un espace pour ne pas couper un mot
  if (start > 0) {
    const sp = clean.indexOf(' ', start);
    if (sp > 0 && sp - start < 40) start = sp + 1;
  }
  const end = Math.min(clean.length, start + perDocChars);
  return (start > 0 ? '…' : '') + clean.slice(start, end).trim() + (end < clean.length ? '…' : '');
}

class Brain {
  constructor(dir) {
    this.dir = dir;
    this.docs = [];
    this.images = [];
    this.downloadables = [];
    this.loadedAt = null;
    this.load();
  }

  /** (Re)construit l'index à partir du contenu du dossier. */
  load() {
    const docs = [];
    const images = [];
    const downloadables = [];
    let root;
    try {
      root = fs.realpathSync(this.dir);
    } catch (_) {
      this.docs = [];
      this.images = [];
      this.downloadables = [];
      this.loadedAt = new Date();
      return;
    }

    const walk = (d, depth) => {
      if (depth > MAX_DEPTH || docs.length >= MAX_DOCS) return;
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }

      for (const e of entries) {
        if (e.name.startsWith('.')) continue;          // ignore .git, .DS_Store...
        const full = path.join(d, e.name);

        // Anti-évasion : on résout les liens et on refuse tout ce qui sort du dossier
        let real;
        try { real = fs.realpathSync(full); } catch (_) { continue; }
        if (real !== root && !real.startsWith(root + path.sep)) continue;

        if (e.isDirectory()) { walk(full, depth + 1); continue; }

        const ext = path.extname(e.name).toLowerCase();
        if (!isIndexableExt(ext)) continue;

        let st;
        try { st = fs.statSync(real); } catch (_) { continue; }
        if (!st.isFile() || st.size === 0 || st.size > maxBytesForExt(ext)) continue;

        const rel = path.relative(root, full).split(path.sep).join('/');
        const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';

        // ZIP / RAR / vidéos : téléchargeables dans le chat
        if (DOWNLOAD_EXT.has(ext)) {
          let summary;
          if (ARCHIVE_EXT.has(ext)) {
            const fileList = ext === '.zip' ? listZipEntries(real) : [];
            summary =
              `[Archive ${ext.slice(1).toUpperCase()}] ${e.name} (${fmtBytes(st.size)}) — chemin: ${rel}` +
              (fileList.length ? `\nContient: ${fileList.slice(0, 60).join(', ')}` : '');
            if (ext === '.zip') {
              for (const zi of extractZipImages(real)) {
                images.push({
                  rel: `${rel}#${zi.path}`,
                  folder,
                  name: path.basename(zi.path),
                });
              }
            }
          } else {
            summary = `[Video ${ext.slice(1).toUpperCase()}] ${e.name} (${fmtBytes(st.size)}) — chemin: ${rel}`;
          }

          docs.push(buildDocIndex(rel, folder, e.name, summary));
          if (docs.length >= MAX_DOCS) break;

          downloadables.push({ rel, folder, name: e.name, size: st.size });
          continue;
        }

        if (IMAGE_EXT.has(ext)) {
          images.push({ rel, folder, name: e.name });
        }

        let content;
        try {
          content = extractFileContent(real, ext, e.name, rel, st.size);
        } catch (_) { continue; }
        if (!content || !content.trim()) continue;

        docs.push(buildDocIndex(rel, folder, e.name, content));
        if (docs.length >= MAX_DOCS) break;
      }
    };

    walk(root, 0);
    this.docs = docs;
    this.images = images;
    this.downloadables = downloadables;
    this.loadedAt = new Date();
  }

  /**
   * Recherche des images dans le cerveau correspondant à la requête.
   * Retourne TOUTES les images correspondantes (pas seulement la première).
   */
  searchImages(query, opts = {}) {
    return searchMediaPool(this.images, query, {
      maxItems: opts.maxImages || 30,
      minScore: opts.minScore || 12,
    });
  }

  /**
   * Recherche des fichiers téléchargeables du cerveau (archives + vidéos).
   */
  searchDownloadables(query, opts = {}) {
    let pool = this.downloadables;
    const videoOnly = opts.videosOnly ?? (isVideoRequest(query) && !/\b(zip|rar|archive)\b/i.test(String(query || '')));
    if (videoOnly) {
      pool = pool.filter(f => VIDEO_EXT.has(path.extname(f.name).toLowerCase()));
    } else if (/\b(zip|rar|archive)\b/i.test(String(query || ''))) {
      pool = pool.filter(f => ARCHIVE_EXT.has(path.extname(f.name).toLowerCase()));
    }
    return searchMediaPool(pool, query, {
      maxItems: opts.maxFiles || opts.maxArchives || 20,
      minScore: opts.minScore || 12,
    });
  }

  /** @deprecated alias */
  searchArchives(query, opts = {}) {
    return this.searchDownloadables(query, opts);
  }

  /**
   * Résout une image du cerveau (fichier direct ou entrée dans un ZIP).
   * @returns {{ abs?: string, buffer?: Buffer, mime: string }}
   */
  getAsset(relPath) {
    if (typeof relPath !== 'string' || !relPath.trim()) throw new Error('Chemin invalide');
    const cleaned = relPath.replace(/\\/g, '/').replace(/^\/+/, '').trim();

    if (cleaned.includes('#')) {
      const hashIdx = cleaned.indexOf('#');
      const zipRel = cleaned.slice(0, hashIdx);
      const innerPath = cleaned.slice(hashIdx + 1);
      if (!AdmZip) throw new Error('Archive non lisible');
      const { abs } = this._resolve(zipRel);
      const zip = new AdmZip(abs);
      const entry = zip.getEntry(innerPath);
      if (!entry || entry.isDirectory) throw new Error('Image introuvable dans l\'archive');
      const ext = path.extname(innerPath).toLowerCase();
      if (!IMAGE_EXT.has(ext)) throw new Error('Format non supporte');
      const buffer = entry.getData();
      if (!buffer || buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
        throw new Error('Image trop volumineuse');
      }
      return { buffer, mime: mimeFromExt(ext) };
    }

    const { abs } = this._resolve(cleaned);
    const ext = path.extname(abs).toLowerCase();
    if (DOWNLOAD_EXT.has(ext)) {
      const max = maxDownloadBytes(ext);
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size === 0 || st.size > max) {
        throw new Error('Fichier invalide');
      }
      return {
        abs,
        mime: mimeFromExt(ext),
        filename: path.basename(abs),
        attachment: true,
      };
    }
    if (!IMAGE_EXT.has(ext)) throw new Error('Format non supporte');
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size === 0 || st.size > MAX_IMAGE_BYTES) {
      throw new Error('Fichier image invalide');
    }
    return { abs, mime: mimeFromExt(ext) };
  }

  /**
   * Recherche les documents pertinents pour une requête.
   * @returns {Array<{rel,folder,name,score,nameHit,snippet}>}
   */
  search(query, opts = {}) {
    const maxDocs = opts.maxDocs || 5;
    const perDocChars = opts.perDocChars || 2500;
    const totalChars = opts.totalChars || 9000;
    const brainIntent = opts.brainIntent ?? isBrainIntent(query);

    const topic = extractTopic(query);
    const qTokens = [...new Set(tokenize(topic.length >= 2 ? topic : query))];
    if (!this.docs.length) return [];

    const scored = [];
    for (const doc of this.docs) {
      let score = 0;
      let nameHit = false;
      const pathNorm = normalize(doc.rel);

      for (const t of qTokens) {
        if (doc.nameSet.has(t)) { score += 14; nameHit = true; }
        if (pathNorm.includes(t)) { score += 12; nameHit = true; }
        const c = doc.tf.get(t) || 0;
        if (c) score += Math.min(c, 6) + 2;
      }

      // Correspondance partielle dans le chemin (ex: "discord" dans "d1sc0rd")
      for (const t of qTokens) {
        if (t.length < 3) continue;
        for (const part of pathNorm.split(/[^a-z0-9]+/)) {
          if (part.length >= 3 && (part.includes(t) || t.includes(part))) {
            score += 8;
            nameHit = true;
          }
        }
      }

      if (score > 0) scored.push({ doc, score, nameHit });
    }

    // Repli : recherche par sous-chaîne dans le chemin
    if (!scored.length && qTokens.length) {
      for (const doc of this.docs) {
        const pathNorm = normalize(doc.rel);
        for (const t of qTokens) {
          if (t.length >= 3 && pathNorm.includes(t)) {
            scored.push({ doc, score: 6, nameHit: true });
            break;
          }
        }
      }
    }

    scored.sort((a, b) =>
      (b.nameHit - a.nameHit) || (b.score - a.score));

    const out = [];
    let budget = totalChars;
    for (const s of scored.slice(0, maxDocs)) {
      const room = Math.min(perDocChars, budget);
      if (room < 200) break;
      const full = s.doc.content.trim();
      const snippet = full.length <= room
        ? full
        : bestSnippet(full, qTokens, room);
      budget -= snippet.length;
      out.push({
        rel: s.doc.rel,
        folder: s.doc.folder,
        name: s.doc.name,
        score: s.score,
        nameHit: s.nameHit,
        snippet,
      });
    }
    return out;
  }

  /** Met en forme les documents trouvés pour les injecter dans le prompt. */
  buildContext(query, opts = {}) {
    const brainIntent = opts.brainIntent ?? isBrainIntent(query);
    const strict = opts.strictResource ?? expectsBrainResource(query);
    let hits = this.search(query, { ...opts, brainIntent });
    if (strict) {
      hits = hits.filter(h => h.nameHit && h.score >= 10);
    }
    if (!hits.length) return { context: '', hits: [], brainIntent, strictResource: strict };
    const blocks = hits.map(h =>
      `[SOURCE: ${h.rel}]\n${h.snippet}`
    ).join('\n\n---\n\n');
    return { context: blocks, hits, brainIntent, strictResource: strict };
  }

  /** Statistiques pour le panneau admin. */
  stats() {
    const folders = {};
    for (const d of this.docs) {
      const top = d.folder ? d.folder.split('/')[0] : '(racine)';
      folders[top] = (folders[top] || 0) + 1;
    }
    return {
      documents: this.docs.length,
      folders: Object.entries(folders)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      loadedAt: this.loadedAt,
    };
  }

  // ===================================================================
  //  GESTION DE FICHIERS (depuis le panneau admin)
  //  Toutes les opérations passent par _resolve() qui garantit qu'on ne
  //  sort jamais du dossier cerveau/ (anti-traversée de chemin).
  // ===================================================================

  /** Traduit un chemin relatif fourni par l'admin en chemin absolu sûr. */
  _resolve(relPath) {
    if (typeof relPath !== 'string') throw new Error('Chemin invalide');
    const cleaned = relPath.replace(/\\/g, '/').replace(/^\/+/, '').trim();
    const segments = cleaned.split('/').filter(s => s.length);
    for (const s of segments) {
      if (s === '.' || s === '..') throw new Error('Chemin invalide');
      if (/[\x00\\]/.test(s)) throw new Error('Chemin invalide');
      if (s.length > 200) throw new Error('Nom trop long');
    }
    const rootAbs = path.resolve(this.dir);
    const abs = path.resolve(rootAbs, segments.join('/'));
    if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
      throw new Error('Chemin hors du dossier cerveau');
    }
    return { abs, rel: segments.join('/'), segments, root: rootAbs };
  }

  _ensureRoot() {
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (_) {}
  }

  /** Arborescence complète : dossiers + fichiers (pour le gestionnaire). */
  tree() {
    this._ensureRoot();
    let root;
    try { root = fs.realpathSync(this.dir); } catch (_) { return { folders: [], files: [] }; }

    const folders = new Set();
    const files = [];

    const walk = (d, depth) => {
      if (depth > MAX_DEPTH) return;
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(d, e.name);
        let real;
        try { real = fs.realpathSync(full); } catch (_) { continue; }
        if (real !== root && !real.startsWith(root + path.sep)) continue;

        const rel = path.relative(root, full).split(path.sep).join('/');
        if (e.isDirectory()) {
          folders.add(rel);
          walk(full, depth + 1);
        } else if (e.isFile()) {
          let st; try { st = fs.statSync(real); } catch (_) { continue; }
          const ext = path.extname(e.name).toLowerCase();
          const skipReason = skipReasonForFile(ext, st.size);
          files.push({
            path: rel,
            folder: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
            name: e.name,
            ext,
            size: st.size,
            mtime: st.mtimeMs,
            indexed: !skipReason,
            skipReason,
          });
        }
      }
    };
    walk(root, 0);

    return {
      folders: [...folders].sort(),
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
    };
  }

  /** Lit le contenu texte d'un fichier. */
  readFile(relPath) {
    const { abs } = this._resolve(relPath);
    const ext = path.extname(abs).toLowerCase();
    if (TEXT_EXT.has(ext) || HTML_EXT.has(ext)) {
      const st = fs.statSync(abs);
      if (!st.isFile()) throw new Error('Pas un fichier');
      if (st.size > MAX_FILE_BYTES) throw new Error('Fichier trop volumineux');
      return fs.readFileSync(abs, 'utf8');
    }
    throw new Error('Format non lisible en éditeur (texte/html uniquement)');
  }

  /** Crée ou remplace un fichier texte. */
  writeFile(relPath, content) {
    if (typeof content !== 'string') throw new Error('Contenu invalide');
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      throw new Error('Contenu trop volumineux (max 512 Ko)');
    }
    const { abs, rel, segments } = this._resolve(relPath);
    const ext = path.extname(abs).toLowerCase();
    const writableExt = new Set([...TEXT_EXT, ...HTML_EXT]);
    if (!writableExt.has(ext)) {
      throw new Error('Extension non autorisee (.txt .md .html .json .csv .log)');
    }
    if (!segments.length) throw new Error('Nom de fichier requis');
    this._ensureRoot();
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    this.load();               // réindexe immédiatement
    return { path: rel };
  }

  /** Supprime un fichier. */
  deleteFile(relPath) {
    const { abs, rel, segments } = this._resolve(relPath);
    if (!segments.length) throw new Error('Chemin requis');
    let st;
    try { st = fs.statSync(abs); } catch (_) { throw new Error('Fichier introuvable'); }
    if (!st.isFile()) throw new Error('Pas un fichier');
    fs.unlinkSync(abs);
    this.load();
    return { path: rel };
  }

  /** Crée un dossier (thème). */
  createFolder(relPath) {
    const { abs, rel, segments } = this._resolve(relPath);
    if (!segments.length) throw new Error('Nom de dossier requis');
    this._ensureRoot();
    fs.mkdirSync(abs, { recursive: true });
    return { path: rel };
  }

  /** Supprime un dossier et tout son contenu. */
  deleteFolder(relPath) {
    const { abs, rel, segments, root } = this._resolve(relPath);
    if (!segments.length) throw new Error('Impossible de supprimer la racine');
    if (abs === root) throw new Error('Impossible de supprimer la racine');
    fs.rmSync(abs, { recursive: true, force: true });
    this.load();
    return { path: rel };
  }

  /** Chemin sûr pour une entrée extraite d'un ZIP (anti zip-slip). */
  _safeZipTarget(root, relPath) {
    const cleaned = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const segments = cleaned.split('/').filter((s) => s.length && s !== '.');
    for (const s of segments) {
      if (s === '..' || /[\x00\\]/.test(s)) throw new Error('Entree ZIP invalide');
    }
    const abs = path.resolve(root, ...segments);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error('Entree ZIP hors du dossier cerveau');
    }
    return abs;
  }

  /** Préfixe de dossier racine à retirer (ex. "cerveau/" dans un zip du dossier cerveau). */
  _detectZipStripPrefix(entryNames) {
    const names = entryNames
      .map((n) => String(n || '').replace(/\\/g, '/'))
      .filter((n) => n && !n.endsWith('/'));
    if (!names.length) return '';

    if (names.every((n) => n.startsWith('cerveau/'))) return 'cerveau/';

    const tops = new Set(names.map((n) => n.split('/')[0]).filter(Boolean));
    if (tops.size === 1) {
      const top = [...tops][0];
      if (names.every((n) => n.startsWith(top + '/'))) return top + '/';
    }
    return '';
  }

  _listZipEntries(zipPath) {
    return new Promise((resolve, reject) => {
      const names = [];
      yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err);
        zipfile.on('entry', (entry) => {
          names.push(entry.fileName);
          zipfile.readEntry();
        });
        zipfile.on('end', () => resolve(names));
        zipfile.on('error', reject);
        zipfile.readEntry();
      });
    });
  }

  _clearRootContents() {
    this._ensureRoot();
    const root = fs.realpathSync(this.dir);
    for (const name of fs.readdirSync(root)) {
      if (name.startsWith('.')) continue;
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
    }
  }

  /** Déplace le contenu extrait (gère le dossier racine unique type "cerveau/"). */
  _mergeExtractedDir(srcDir, root, stripPrefix) {
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    let source = srcDir;

    if (entries.length === 1 && entries[0].isDirectory()) {
      const only = entries[0].name;
      if (!stripPrefix || only === stripPrefix.replace(/\/$/, '')) {
        source = path.join(srcDir, only);
      }
    }

    const walk = (from, relBase) => {
      for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
        if (ent.name.startsWith('.')) continue;
        const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
        const src = path.join(from, ent.name);
        const dest = this._safeZipTarget(root, rel);
        if (ent.isDirectory()) {
          fs.mkdirSync(dest, { recursive: true });
          walk(src, rel);
        } else {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
        }
      }
    };
    walk(source, '');
  }

  _importZipUnzip(zipPath, opts, entryNames, stripPrefix) {
    const root = fs.realpathSync(this.dir);
    const tmpExtract = path.join(path.dirname(zipPath), `cerveau-extract-${Date.now()}`);
    fs.mkdirSync(tmpExtract, { recursive: true });

    return new Promise((resolve, reject) => {
      const proc = spawn('unzip', ['-o', '-q', zipPath, '-d', tmpExtract], { stdio: 'inherit' });
      proc.on('error', (err) => {
        try { fs.rmSync(tmpExtract, { recursive: true, force: true }); } catch (_) {}
        reject(err.code === 'ENOENT'
          ? new Error('Commande unzip absente sur le serveur')
          : err);
      });
      proc.on('close', (code) => {
        if (code !== 0) {
          try { fs.rmSync(tmpExtract, { recursive: true, force: true }); } catch (_) {}
          return reject(new Error(`Extraction unzip echouee (code ${code})`));
        }
        try {
          this._mergeExtractedDir(tmpExtract, root, stripPrefix);
          if (typeof opts.onProgress === 'function') {
            opts.onProgress({ phase: 'extract', extracted: entryNames.length, total: entryNames.length });
          }
          resolve(entryNames.length);
        } catch (e) {
          reject(e);
        } finally {
          try { fs.rmSync(tmpExtract, { recursive: true, force: true }); } catch (_) {}
        }
      });
    });
  }

  /**
   * Importe un fichier ZIP dans le cerveau (fusion ou remplacement).
   * @param {string} zipPath — chemin temporaire du zip sur disque
   * @param {{ replace?: boolean, onProgress?: Function }} opts
   */
  async importZip(zipPath, opts = {}) {
    if (!yauzl) throw new Error('Module yauzl manquant sur le serveur');
    if (!zipPath || !fs.existsSync(zipPath)) throw new Error('Fichier ZIP introuvable');

    this._ensureRoot();
    const root = fs.realpathSync(this.dir);
    if (opts.replace) this._clearRootContents();

    const entryNames = await this._listZipEntries(zipPath);
    if (!entryNames.length) throw new Error('ZIP vide');

    const stripPrefix = this._detectZipStripPrefix(entryNames);
    let extracted = 0;
    if (typeof opts.onProgress === 'function') {
      opts.onProgress({ phase: 'start', extracted: 0, total: entryNames.length });
    }

    try {
      await new Promise((resolve, reject) => {
        yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
          if (err) return reject(err);

          const next = () => zipfile.readEntry();
          zipfile.on('entry', (entry) => {
            let rel = String(entry.fileName || '').replace(/\\/g, '/');
            if (stripPrefix && rel.startsWith(stripPrefix)) {
              rel = rel.slice(stripPrefix.length);
            }
            if (!rel || rel === '/' || rel.endsWith('/')) {
              if (rel) {
                try {
                  fs.mkdirSync(this._safeZipTarget(root, rel), { recursive: true });
                } catch (e) {
                  zipfile.close();
                  return reject(e);
                }
              }
              return next();
            }

            zipfile.openReadStream(entry, (errStream, readStream) => {
              if (errStream) {
                zipfile.close();
                return reject(errStream);
              }
              let dest;
              try {
                dest = this._safeZipTarget(root, rel);
              } catch (e) {
                readStream.destroy();
                zipfile.close();
                return reject(e);
              }
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              pipeline(readStream, fs.createWriteStream(dest))
                .then(() => {
                  extracted++;
                  if (typeof opts.onProgress === 'function') {
                    opts.onProgress({ phase: 'extract', extracted, total: entryNames.length });
                  }
                  next();
                })
                .catch((e) => {
                  zipfile.close();
                  reject(e);
                });
            });
          });

          zipfile.on('end', () => resolve());
          zipfile.on('error', reject);
          next();
        });
      });
    } catch (yauzlErr) {
      console.warn('[CERVEAU] yauzl echoue, repli unzip:', yauzlErr.message);
      extracted = await this._importZipUnzip(zipPath, opts, entryNames, stripPrefix);
    }

    this.load();
    return { ...this.stats(), extracted, stripPrefix: stripPrefix || null };
  }
}

module.exports = {
  Brain,
  tokenize,
  normalize,
  isBrainIntent,
  isImageRequest,
  isDownloadRequest,
  isArchiveRequest,
  isToolRequest,
  expectsBrainResource,
  extractTopic,
};
