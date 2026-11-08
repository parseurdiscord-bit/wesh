# Projet — API licences + chat IA (Express / SQLite)

## Carte du code (NE PAS re-explorer : tout est ici)
- `server.js` (1711 l.) — Express, toutes les routes, schéma SQLite
- `cerveau.js` (992 l.) — moteur de recherche/indexation du dossier `cerveau/`
- `security.js` (717 l.) — config, IP/Cloudflare, rate-limit, crypto, audit, backups
- `websearch.js` — recherche + telechargement de logiciels (GitHub/GitLab/Codeberg/archive.org + Homebrew cask/formula + moteurs + crawl, scoring par source, verif reseau HEAD/GET, SHA-256)
- `sources.js` — recherche federee : forums (Reddit + subreddits securite, Lemmy, reseau Stack Exchange), securite (Exploit-DB, KitPloit, CISA KEV, GitHub Advisory, Full Disclosure, 6 fils presse secu, hacktualites, NVD/CVE), Wikipedia, StackOverflow, GitHub, HN, arXiv, OpenAlex, npm/PyPI/crates, archive.org, DDG Instant (API sans cle, routage par intention)
- `prompt.txt` — system prompt du chat
- `public/` — front statique : index, buy, login, chat, admin
- `cerveau/` — **9197 fichiers / 12 Go de données**. JAMAIS de glob/grep récursif dessus.
- `.env`, `database.sqlite`, `backups/` — secrets/binaires, ne pas lire

## Repères (server.js)
- Tables SQL : l.258-330 → `admins`, `licenses`, `api_logs`, `chat_logs`, `promo_codes`, `api_keys`, `settings`
- Routes admin (`adminAuth`) : l.558-1620 — login/licences/security/settings/brain/stats/chat-logs/prompt/promos/apikeys
- Licences publiques : `/api/license/verify` l.917, `/api/license/login` l.954
- Chat : `/api/chat` l.1130 (gros bloc) · Image : `/api/image` l.1457
- Pages HTML : l.1620-1630

## Modules
- `cerveau.js` : `leetSpeak` 71 · `isBrainIntent` 83 · `scoreMediaMatch` 207 · `searchMediaPool` 283 · zip 353-443 · indexation 444-523 · exports 982
- `security.js` : `loadConfig` 44 · IP/CIDR 149-265 · `forceHTTPS` 280 · `cloudflareOnly` 299 · `securityHeaders` 316 · `makeLimiter` 370 · crypto 508-576 · `initSecurityTables` 577 · `makeAuditor` 618 · `makeLockout` 639 · `scheduleBackups` 669

## Règles de travail (économie de contexte)
1. Ne jamais lire `server.js`, `cerveau.js` ou `security.js` en entier. Localiser avec `grep -n`, puis lire la plage utile avec `sed -n 'A,Bp'`.
2. Ne jamais lancer Glob/Grep sans `--glob` restrictif à la racine : `cerveau/` avalerait 9197 fichiers.
3. Pas de `cat` sur `.env`, `*.sqlite`, `backups/`, `node_modules/`.
4. Après un changement, vérifier avec `node --check <fichier>` plutôt que relire le fichier.
5. Réponses courtes, pas de récapitulatif du code déjà vu.

## Lancer
`npm start` (= `node server.js`). Stack : express 5, better-sqlite3, jsonwebtoken, bcryptjs, helmet, @huggingface/inference.
