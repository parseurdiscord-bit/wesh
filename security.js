'use strict';

/**
 * security.js — Couche de sécurité centralisée
 *
 * Regroupe : validation de config, détection d'IP réelle (Cloudflare),
 * filtrage d'origine, bannissement automatique, chiffrement au repos,
 * en-têtes HTTP, limitation de débit et journal d'audit.
 */

const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const IS_PROD = process.env.NODE_ENV === 'production';

/* ==================================================================
   1. VALIDATION STRICTE DE LA CONFIGURATION
   Le serveur REFUSE de démarrer en production si un secret est
   manquant, laissé par défaut, ou trop faible.
   ================================================================== */

const PLACEHOLDER_RE = /^(A_REMPLIR|CHANGEME|CHANGE_ME|TODO|xxx+|<.*>)/i;
const WEAK_USERNAMES = new Set(['ansaru', 'admin', 'root', 'administrator', 'test']);
const WEAK_PASSWORDS = new Set([
  'ansarudev', 'admin', 'password', 'motdepasse', '123456', '12345678',
  'azerty', 'qwerty', 'darkgpt', 'cybergpt', 'test', 'root',
]);

function isPlaceholder(v) {
  return !v || PLACEHOLDER_RE.test(String(v).trim());
}

function fatal(errors) {
  console.error('\n\x1b[41m\x1b[97m  DEMARRAGE REFUSE - CONFIGURATION NON SECURISEE  \x1b[0m\n');
  for (const e of errors) console.error('  \x1b[31mX\x1b[0m ' + e);
  console.error('\n  Corrige ton fichier .env, puis relance le serveur.\n');
  process.exit(1);
}

/**
 * Charge et valide toute la configuration de sécurité.
 * En développement : avertit. En production : bloque le démarrage.
 */
function loadConfig() {
  const port = parseInt(process.env.PORT, 10) || 3000;
  const cfg = {
    isProd: IS_PROD,
    port,
    siteUrl: (process.env.SITE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    jwtSecret: process.env.JWT_SECRET || '',
    encryptionKey: process.env.ENCRYPTION_KEY || '',
    adminUser: process.env.ADMIN_USERNAME || '',
    adminPass: process.env.ADMIN_PASSWORD || '',
    adminPath: process.env.ADMIN_PATH || '/ctrl-x9k2m',
    openrouterKey: process.env.OPENROUTER_API_KEY || '',
    trustProxyHops: parseInt(process.env.TRUST_PROXY_HOPS, 10) || 1,
    cloudflareOnly: process.env.CLOUDFLARE_ONLY === 'true',
    originSecret: process.env.ORIGIN_SECRET || '',
    forceHttps: process.env.FORCE_HTTPS !== 'false',
    banThreshold: parseInt(process.env.BAN_THRESHOLD, 10) || 12,
    banMinutes: parseInt(process.env.BAN_MINUTES, 10) || 60,
    backupEnabled: process.env.DB_BACKUP !== 'false',
    backupIntervalH: parseInt(process.env.DB_BACKUP_INTERVAL_HOURS, 10) || 6,
    backupKeep: parseInt(process.env.DB_BACKUP_KEEP, 10) || 12,
  };

  const errors = [];
  const warns = [];

  // --- Secret JWT : obligatoire, 64 caractères minimum ---
  if (isPlaceholder(cfg.jwtSecret)) {
    errors.push('JWT_SECRET est vide ou non modifié. Genere-le : openssl rand -hex 64');
  } else if (cfg.jwtSecret.length < 64) {
    errors.push(`JWT_SECRET trop court (${cfg.jwtSecret.length} caracteres, minimum 64).`);
  }

  // --- Identifiants admin ---
  if (isPlaceholder(cfg.adminUser)) {
    errors.push('ADMIN_USERNAME est vide ou non modifié.');
  } else if (WEAK_USERNAMES.has(cfg.adminUser.toLowerCase())) {
    errors.push(`ADMIN_USERNAME "${cfg.adminUser}" est un nom devinable. Choisis-en un autre.`);
  }

  if (isPlaceholder(cfg.adminPass)) {
    errors.push('ADMIN_PASSWORD est vide ou non modifié.');
  } else if (WEAK_PASSWORDS.has(cfg.adminPass.toLowerCase())) {
    errors.push('ADMIN_PASSWORD figure dans la liste des mots de passe connus. Change-le.');
  } else if (cfg.adminPass.length < 12) {
    errors.push(`ADMIN_PASSWORD trop court (${cfg.adminPass.length} caracteres, minimum 12).`);
  } else if (!/[a-z]/.test(cfg.adminPass) || !/[A-Z]/.test(cfg.adminPass) ||
             !/[0-9]/.test(cfg.adminPass) || !/[^A-Za-z0-9]/.test(cfg.adminPass)) {
    warns.push('ADMIN_PASSWORD : ajoute majuscules, chiffres et symboles pour le renforcer.');
  }

  // --- Clé de chiffrement au repos ---
  if (isPlaceholder(cfg.encryptionKey)) {
    warns.push('ENCRYPTION_KEY absente : une clé est dérivée du JWT_SECRET. ' +
               'Definis-en une dediee (openssl rand -hex 32) pour pouvoir changer le JWT sans perdre les cles chiffrees.');
  } else if (!/^[0-9a-f]{64}$/i.test(cfg.encryptionKey)) {
    errors.push('ENCRYPTION_KEY doit faire exactement 64 caracteres hexadecimaux.');
  }

  // --- Clé IA ---
  if (isPlaceholder(cfg.openrouterKey)) {
    warns.push('OPENROUTER_API_KEY absente : le chat IA renverra une erreur.');
  }

  // --- Chemin admin ---
  if (cfg.adminPath === '/ctrl-x9k2m') {
    warns.push('ADMIN_PATH est encore la valeur par defaut du depot. Change-le dans .env.');
  }
  if (!cfg.adminPath.startsWith('/') || cfg.adminPath.length < 6) {
    errors.push('ADMIN_PATH doit commencer par "/" et faire au moins 6 caracteres.');
  }

  // --- Cohérence HTTPS en production ---
  if (IS_PROD && cfg.siteUrl.startsWith('http://')) {
    errors.push('SITE_URL doit utiliser https:// en production.');
  }

  if (IS_PROD && errors.length) fatal(errors);

  if (!IS_PROD && errors.length) {
    console.warn('\n\x1b[43m\x1b[30m  MODE DEVELOPPEMENT - problemes qui BLOQUERONT la mise en production  \x1b[0m');
    for (const e of errors) console.warn('  \x1b[33m!\x1b[0m ' + e);
  }
  for (const w of warns) console.warn('  \x1b[33m!\x1b[0m ' + w);
  if (errors.length || warns.length) console.warn('');

  return cfg;
}

/* ==================================================================
   2. DETECTION D'IP REELLE (compatible Cloudflare, anti-usurpation)
   ================================================================== */

// Plages officielles Cloudflare — https://www.cloudflare.com/ips/
const CF_IPV4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];
const CF_IPV6 = [
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

function parseIPv4(str) {
  const parts = str.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8n) | BigInt(v);
  }
  return n;
}

/** Convertit une IP (v4 ou v6) en { bits, value } pour comparaison CIDR. */
function parseIP(str) {
  if (typeof str !== 'string') return null;
  let ip = str.trim().split('%')[0];

  // Forme IPv4 pure
  if (!ip.includes(':')) {
    const v = parseIPv4(ip);
    return v === null ? null : { bits: 32, value: v };
  }

  // IPv4 encapsulée en IPv6 (::ffff:1.2.3.4) -> traitée comme IPv4
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) {
    const v = parseIPv4(mapped[1]);
    return v === null ? null : { bits: 32, value: v };
  }

  // IPv6 avec IPv4 en fin de chaîne
  const lastColon = ip.lastIndexOf(':');
  const tail = ip.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (v4 === null) return null;
    const hi = (v4 >> 16n).toString(16);
    const lo = (v4 & 0xffffn).toString(16);
    ip = ip.slice(0, lastColon + 1) + hi + ':' + lo;
  }

  const halves = ip.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  const rear = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fillCount = 8 - head.length - rear.length;
  if (halves.length === 1) {
    if (head.length !== 8) return null;
  } else if (fillCount < 0) {
    return null;
  }

  const groups = halves.length === 2
    ? [...head, ...Array(fillCount).fill('0'), ...rear]
    : head;

  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return { bits: 128, value };
}

/** Précompile une liste CIDR en { bits, network, mask }. */
function compileCIDRs(list) {
  const out = [];
  for (const cidr of list) {
    const [addr, prefixStr] = cidr.split('/');
    const parsed = parseIP(addr);
    if (!parsed) continue;
    const prefix = parseInt(prefixStr, 10);
    const shift = BigInt(parsed.bits - prefix);
    out.push({ bits: parsed.bits, network: (parsed.value >> shift) << shift, shift });
  }
  return out;
}

const CF_RANGES = compileCIDRs([...CF_IPV4, ...CF_IPV6]);

function inRanges(ipStr, ranges) {
  const parsed = parseIP(ipStr);
  if (!parsed) return false;
  for (const r of ranges) {
    if (r.bits !== parsed.bits) continue;
    if (((parsed.value >> r.shift) << r.shift) === r.network) return true;
  }
  return false;
}

/** La requête provient-elle réellement du réseau Cloudflare ? */
function isFromCloudflare(req) {
  const direct = req.socket?.remoteAddress || '';
  return inRanges(direct, CF_RANGES);
}

/**
 * IP réelle du client.
 * CF-Connecting-IP n'est utilisé QUE si la connexion vient vraiment de
 * Cloudflare — sinon un attaquant pourrait forger l'en-tête et contourner
 * la limitation de débit et les bannissements.
 */
function getClientIP(req) {
  if (isFromCloudflare(req)) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && parseIP(cf)) return cf.trim();
  }
  // req.ip est calculé par Express selon 'trust proxy' (nombre de sauts fixe)
  if (req.ip && parseIP(req.ip.replace(/^::ffff:/, ''))) {
    return req.ip.replace(/^::ffff:/, '');
  }
  return (req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

/** Clé de limitation : IPv6 regroupée par /64 pour éviter le contournement. */
function rateLimitKey(req) {
  const ip = getClientIP(req);
  const parsed = parseIP(ip);
  if (parsed && parsed.bits === 128) {
    return '[' + ((parsed.value >> 64n) << 64n).toString(16) + ']/64';
  }
  return ip;
}

/* ==================================================================
   3. MIDDLEWARES RESEAU
   ================================================================== */

/** Redirige tout le trafic HTTP vers HTTPS (en production). */
function forceHTTPS(cfg) {
  return (req, res, next) => {
    if (!cfg.isProd || !cfg.forceHttps) return next();
    const proto = req.headers['cf-visitor']
      ? (JSON.parse(req.headers['cf-visitor'] || '{}').scheme || '')
      : (req.headers['x-forwarded-proto'] || req.protocol);
    if (proto === 'https') return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return res.status(403).json({ error: 'HTTPS requis' });
    }
    return res.redirect(301, cfg.siteUrl + req.originalUrl);
  };
}

/**
 * Verrouille l'origine : refuse tout ce qui ne transite pas par Cloudflare.
 * Empêche un attaquant de viser directement l'IP du serveur pour esquiver
 * la protection anti-DDoS.
 */
function cloudflareOnly(cfg, onBlocked) {
  return (req, res, next) => {
    if (!cfg.cloudflareOnly) return next();

    // Vérification par en-tête secret (Transform Rule Cloudflare)
    if (cfg.originSecret) {
      const got = req.headers['x-origin-secret'];
      if (typeof got === 'string' && timingSafeEqual(got, cfg.originSecret)) return next();
    }
    if (isFromCloudflare(req)) return next();

    if (onBlocked) onBlocked(req);
    return res.status(403).json({ error: 'Acces direct interdit' });
  };
}

/** En-têtes de sécurité complémentaires à Helmet. */
function securityHeaders() {
  return (req, res, next) => {
    res.removeHeader('X-Powered-By');
    res.setHeader('Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), ' +
      'magnetometer=(), gyroscope=(), accelerometer=(), interest-cohort=()');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Origin-Agent-Cluster', '?1');
    next();
  };
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Détecte une tentative de pollution de prototype.
 * On teste les propriétés PROPRES uniquement : `'constructor' in obj` est
 * toujours vrai par héritage et rejetterait toutes les requêtes légitimes.
 */
function hasPollutedKey(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return false;
  for (const key of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_KEYS.has(key)) return true;
    if (hasPollutedKey(value[key], depth + 1)) return true;
  }
  return false;
}

/** Rejette les corps de requête aux structures anormales (pollution de paramètres). */
function rejectPollution() {
  return (req, res, next) => {
    if (req.query) {
      for (const v of Object.values(req.query)) {
        // Un paramètre répété devient un tableau : signe de pollution
        if (Array.isArray(v)) {
          return res.status(400).json({ error: 'Parametres invalides' });
        }
      }
    }
    if (req.body && typeof req.body === 'object' && hasPollutedKey(req.body)) {
      return res.status(400).json({ error: 'Charge utile invalide' });
    }
    next();
  };
}

/* ==================================================================
   4. LIMITATION DE DEBIT
   ================================================================== */

function makeLimiter({ windowMs, max, message, skipSuccess = false }) {
  return rateLimit({
    windowMs,
    max,
    message: { error: message },
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: rateLimitKey,
    skipSuccessfulRequests: skipSuccess,
    validate: { keyGeneratorIpFallback: false, xForwardedForHeader: false },
  });
}

/**
 * Ralentissement progressif : au-delà d'un seuil, chaque requête
 * supplémentaire est retardée. Rend le forçage brut non rentable
 * sans jamais bloquer un usage normal.
 */
function progressiveSlowdown({ windowMs = 60000, after = 30, stepMs = 250, maxMs = 5000 } = {}) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
  }, windowMs).unref();

  return (req, res, next) => {
    const key = rateLimitKey(req);
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now > entry.reset) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count <= after) return next();
    const delay = Math.min((entry.count - after) * stepMs, maxMs);
    setTimeout(next, delay);
  };
}

/* ==================================================================
   5. BANNISSEMENT AUTOMATIQUE
   ================================================================== */

class BanStore {
  constructor(db, cfg) {
    this.db = db;
    this.cfg = cfg;
    this.cache = new Map();   // ip -> timestamp de fin de ban
    this.strikes = new Map(); // ip -> { count, reset }
    this._load();
    setInterval(() => this._purge(), 5 * 60 * 1000).unref();
  }

  _load() {
    try {
      const rows = this.db.prepare(
        "SELECT ip, banned_until FROM banned_ips WHERE banned_until > datetime('now')"
      ).all();
      for (const r of rows) this.cache.set(r.ip, new Date(r.banned_until).getTime());
    } catch (_) { /* table pas encore créée */ }
  }

  _purge() {
    const now = Date.now();
    for (const [ip, until] of this.cache) if (now > until) this.cache.delete(ip);
    for (const [ip, s] of this.strikes) if (now > s.reset) this.strikes.delete(ip);
    try {
      this.db.prepare("DELETE FROM banned_ips WHERE banned_until <= datetime('now')").run();
    } catch (_) {}
  }

  isBanned(ip) {
    const until = this.cache.get(ip);
    if (!until) return false;
    if (Date.now() > until) { this.cache.delete(ip); return false; }
    return true;
  }

  /** Enregistre un comportement suspect. Bannit au-delà du seuil. */
  strike(ip, reason = 'abus', weight = 1) {
    const now = Date.now();
    let s = this.strikes.get(ip);
    if (!s || now > s.reset) s = { count: 0, reset: now + 15 * 60 * 1000 };
    s.count += weight;
    this.strikes.set(ip, s);

    if (s.count >= this.cfg.banThreshold) {
      // Escalade : chaque bannissement suivant dure deux fois plus longtemps
      const prior = this._priorBans(ip);
      const minutes = this.cfg.banMinutes * Math.pow(2, Math.min(prior, 6));
      this.ban(ip, minutes, reason);
      this.strikes.delete(ip);
      return true;
    }
    return false;
  }

  _priorBans(ip) {
    try {
      return this.db.prepare('SELECT COUNT(*) c FROM banned_ips WHERE ip = ?').get(ip).c;
    } catch (_) { return 0; }
  }

  ban(ip, minutes, reason) {
    const until = Date.now() + minutes * 60 * 1000;
    this.cache.set(ip, until);
    try {
      this.db.prepare(
        'INSERT INTO banned_ips (ip, reason, banned_until) VALUES (?, ?, ?)'
      ).run(ip, String(reason).slice(0, 200), new Date(until).toISOString());
    } catch (_) {}
    console.warn(`[SECURITE] IP bannie ${ip} pendant ${minutes} min — ${reason}`);
  }

  unban(ip) {
    this.cache.delete(ip);
    this.strikes.delete(ip);
    try { this.db.prepare('DELETE FROM banned_ips WHERE ip = ?').run(ip); } catch (_) {}
  }

  /** Middleware : coupe court aux IP bannies. */
  middleware() {
    return (req, res, next) => {
      const ip = getClientIP(req);
      if (this.isBanned(ip)) {
        return res.status(429).json({ error: 'Acces temporairement suspendu.' });
      }
      req.clientIP = ip;
      next();
    };
  }
}

/* ==================================================================
   6. CHIFFREMENT AU REPOS (AES-256-GCM)
   ================================================================== */

function deriveKey(cfg) {
  if (cfg.encryptionKey && /^[0-9a-f]{64}$/i.test(cfg.encryptionKey)) {
    return Buffer.from(cfg.encryptionKey, 'hex');
  }
  // Repli : dérivation HKDF depuis le secret JWT
  return crypto.hkdfSync('sha256', Buffer.from(cfg.jwtSecret, 'utf8'),
    Buffer.from('darkgpt-at-rest'), Buffer.from('api-keys-v1'), 32);
}

function makeCrypto(cfg) {
  const key = Buffer.from(deriveKey(cfg));

  return {
    /** Chiffre une chaîne. Format : enc:v1:<iv>:<tag>:<données> */
    encrypt(plain) {
      if (typeof plain !== 'string' || !plain) return '';
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
    },

    /** Déchiffre. Renvoie la valeur telle quelle si elle n'est pas chiffrée. */
    decrypt(stored) {
      if (typeof stored !== 'string' || !stored.startsWith('enc:v1:')) return stored || '';
      try {
        const [, , ivB, tagB, dataB] = stored.split(':');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'));
        decipher.setAuthTag(Buffer.from(tagB, 'base64'));
        return Buffer.concat([
          decipher.update(Buffer.from(dataB, 'base64')),
          decipher.final(),
        ]).toString('utf8');
      } catch (_) {
        console.error('[SECURITE] Dechiffrement impossible (ENCRYPTION_KEY modifiee ?)');
        return '';
      }
    },

    isEncrypted: (v) => typeof v === 'string' && v.startsWith('enc:v1:'),
  };
}

/* ==================================================================
   7. UTILITAIRES
   ================================================================== */

/** Comparaison à temps constant (résiste aux attaques temporelles). */
function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  // Hachage préalable : longueurs toujours égales, aucune fuite par la taille
  const ha = crypto.createHash('sha256').update(ba).digest();
  const hb = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Masque une valeur sensible pour l'affichage. */
function mask(value) {
  const v = String(value || '');
  if (v.length <= 10) return '••••••••';
  return v.slice(0, 6) + '••••••••' + v.slice(-4);
}

/* ==================================================================
   8. TABLES DE SECURITE
   ================================================================== */

function initSecurityTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS banned_ips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      reason TEXT DEFAULT '',
      banned_until DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_banned_ip ON banned_ips(ip);
    CREATE INDEX IF NOT EXISTS idx_banned_until ON banned_ips(banned_until);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT DEFAULT '',
      ip TEXT DEFAULT '',
      user_agent TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

    CREATE TABLE IF NOT EXISTS revoked_tokens (
      jti TEXT PRIMARY KEY,
      expires_at DATETIME NOT NULL,
      revoked_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS login_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identifier TEXT NOT NULL,
      ip TEXT NOT NULL,
      success INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_attempts ON login_attempts(identifier, created_at);
  `);
}

/** Journalise une action d'administration (traçabilité). */
function makeAuditor(db) {
  const stmt = db.prepare(
    'INSERT INTO audit_logs (actor, action, target, ip, user_agent) VALUES (?, ?, ?, ?, ?)'
  );
  return function audit(req, actor, action, target = '') {
    try {
      stmt.run(
        String(actor).slice(0, 100),
        String(action).slice(0, 100),
        String(target).slice(0, 200),
        req.clientIP || getClientIP(req),
        String(req.headers['user-agent'] || '').slice(0, 200)
      );
    } catch (_) {}
  };
}

/* ==================================================================
   9. VERROUILLAGE DE COMPTE (anti-forçage brut)
   ================================================================== */

function makeLockout(db, { maxAttempts = 5, windowMinutes = 15 } = {}) {
  const record = db.prepare(
    'INSERT INTO login_attempts (identifier, ip, success) VALUES (?, ?, ?)'
  );
  const count = db.prepare(
    `SELECT COUNT(*) c FROM login_attempts
     WHERE identifier = ? AND success = 0
       AND created_at > datetime('now', '-${windowMinutes} minutes')`
  );
  const clear = db.prepare('DELETE FROM login_attempts WHERE identifier = ?');

  return {
    isLocked(identifier) {
      try { return count.get(identifier).c >= maxAttempts; } catch (_) { return false; }
    },
    remaining(identifier) {
      try { return Math.max(0, maxAttempts - count.get(identifier).c); } catch (_) { return maxAttempts; }
    },
    fail(identifier, ip) { try { record.run(identifier, ip, 0); } catch (_) {} },
    success(identifier, ip) {
      try { record.run(identifier, ip, 1); clear.run(identifier); } catch (_) {}
    },
    windowMinutes,
  };
}

/* ==================================================================
   10. SAUVEGARDES AUTOMATIQUES DE LA BASE
   ================================================================== */

function scheduleBackups(db, cfg, fs, path, dir) {
  if (!cfg.backupEnabled) return;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}

  const run = async () => {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await db.backup(path.join(dir, `backup-${stamp}.sqlite`));
      const files = fs.readdirSync(dir)
        .filter(f => f.startsWith('backup-') && f.endsWith('.sqlite'))
        .sort()
        .reverse();
      for (const old of files.slice(cfg.backupKeep)) {
        try { fs.unlinkSync(path.join(dir, old)); } catch (_) {}
      }
      console.log(`[DB] Sauvegarde effectuee (${files.length > cfg.backupKeep ? cfg.backupKeep : files.length} conservees)`);
    } catch (e) {
      console.error('[DB] Echec de sauvegarde :', e.message);
    }
  };

  setTimeout(run, 30 * 1000).unref();
  setInterval(run, cfg.backupIntervalH * 3600 * 1000).unref();
}

/* ================================================================== */

module.exports = {
  IS_PROD,
  loadConfig,
  getClientIP,
  isFromCloudflare,
  rateLimitKey,
  forceHTTPS,
  cloudflareOnly,
  securityHeaders,
  rejectPollution,
  makeLimiter,
  progressiveSlowdown,
  BanStore,
  makeCrypto,
  timingSafeEqual,
  mask,
  initSecurityTables,
  makeAuditor,
  makeLockout,
  scheduleBackups,
  parseIP,
};
