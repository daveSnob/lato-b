// Pubblica fresh-cache.json (scaricato dal PC di casa, che Reddit non blocca) sul ramo "reddit" del repo,
// da dove lo legge la GitHub Action. Usa `gh api`: nessun commit su main, nessun deploy in più.
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const REPO = 'daveSnob/lato-b', BRANCH = 'reddit', PATH = 'fresh-cache.json';
const body = await readFile(join(DIR, PATH));
const c = JSON.parse(body);
if (!c.fresh || !c.fresh.length || Date.now() - c.at > 2 * 3600e3) { console.log('push-reddit: nessuna copia nuova, salto'); process.exit(0); }
const gh = args => execFileSync('gh', args, { encoding: 'utf8' }).trim();
let sha = '';
try { sha = gh(['api', `repos/${REPO}/contents/${PATH}?ref=${BRANCH}`, '-q', '.sha']); } catch {}
const args = ['api', '-X', 'PUT', `repos/${REPO}/contents/${PATH}`, '-f', `message=Reddit ${new Date().toISOString()}`, '-f', `branch=${BRANCH}`, '-f', `content=${body.toString('base64')}`, '-q', '.commit.sha'];
if (sha) args.push('-f', `sha=${sha}`);
console.log('push-reddit:', gh(args));
