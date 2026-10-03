#!/usr/bin/env node
// portfolio-sync CLI. Run from the portfolio repo root:
//   cli.mjs candidates        new opted-in repos as JSON; facts and images saved in a private temp folder per repo
//   cli.mjs check <draft>     exit 1 if a cited quote isn't in the facts
//   cli.mjs apply <draft>     insert the entry, copy the cover, write the PR body, print the changed files
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync, lstatSync, chmodSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { safeName, publicUrl, imageExt, isListed, prMarker, readmeImages, ogImage, checkDraft, insertEntry, prBody } from './lib.mjs';

// Per-user, so READMEs from private repos never land in a folder other users can read (Linux /tmp is shared).
const TMP = join(tmpdir(), `portfolio-sync-${process.getuid?.() ?? 'user'}`);
const MAX_IMAGES = 3;
const MAX_BYTES = 10 << 20;

const gh = (args, encoding = 'utf8') => execFileSync('gh', args, { encoding, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const inside = (dir, path) => { const r = relative(resolve(dir), resolve(path)); return r && !r.startsWith('..') && !isAbsolute(r); };

function workdir(repo) {
  mkdirSync(TMP, { recursive: true, mode: 0o700 });
  const st = lstatSync(TMP);
  if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) throw new Error(`${TMP} isn't a folder you own; delete it and retry`);
  chmodSync(TMP, 0o700);
  return join(TMP, safeName(repo));
}

function config() {
  if (!existsSync('.portfolio-sync.json')) throw new Error('no .portfolio-sync.json here; run this from the portfolio repo root');
  const c = { topic: 'portfolio', context: [], voice: '', ...json('.portfolio-sync.json') };
  for (const k of ['file', 'marker', 'images', 'verify', 'topic']) if (typeof c[k] !== 'string' || !c[k].trim()) throw new Error(`.portfolio-sync.json needs "${k}" as a string`);
  if (!Array.isArray(c.context) || c.context.some((p) => typeof p !== 'string')) throw new Error('.portfolio-sync.json "context" must be a list of paths');
  for (const p of [c.file, c.images, ...c.context]) if (!inside('.', p)) throw new Error(`.portfolio-sync.json paths must be inside this repo: ${p}`);
  return c;
}

/** The portfolio repo as gh sees it (handles SSH host aliases and `gh repo set-default`). */
function portfolioRepo() {
  const r = JSON.parse(gh(['repo', 'view', '--json', 'owner,name,isPrivate']));
  return { owner: r.owner.login, portfolio: r.name, portfolioPrivate: r.isPrivate };
}

/** GET with a size cap, following redirects only to public https hosts. */
async function get(url, max = MAX_BYTES) {
  for (let hop = 0; hop < 5; hop++) {
    if (!publicUrl(url)) return null;
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const next = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && next) { url = new URL(next, url).href; continue; }
    if (!res.ok || Number(res.headers.get('content-length')) > max) return null;
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > max) return null;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  return null;
}

/** Saves one image into dir and returns its path, or null. Own-repo files go through gh so private repos work. */
async function download(url, dir, n, owner, repo) {
  try {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const own = url.match(new RegExp(`^https://raw\\.githubusercontent\\.com/${esc(owner)}/${esc(repo)}/([^/?#]+)/([^?#]+)$`));
    if (own && /(^|\/)\.\.(\/|$)/.test(decodeURIComponent(own[2]))) return null;
    const buf = own
      ? gh(['api', `repos/${owner}/${repo}/contents/${own[2]}?ref=${own[1]}`, '-H', 'Accept: application/vnd.github.raw'], 'buffer')
      : await get(url);
    const ext = buf && buf.length >= 1000 && buf.length <= MAX_BYTES && imageExt(buf); // < 1000 bytes: tracking pixels
    if (!ext) return null;
    const path = join(dir, `image-${n}.${ext}`);
    writeFileSync(path, buf);
    return { path, source: url };
  } catch {
    return null;
  }
}

async function candidates() {
  const cfg = config();
  const { owner, portfolio, portfolioPrivate } = portfolioRepo();
  const repos = JSON.parse(gh(['repo', 'list', owner, '--topic', cfg.topic, '--source', '--no-archived', '--limit', '1000',
    '--json', 'name,url,description,homepageUrl,repositoryTopics,languages,defaultBranchRef,isPrivate,openGraphImageUrl']));
  const file = readFileSync(cfg.file, 'utf8');
  // Only the user's own PRs count, so a stranger's PR on a public portfolio can't block a repo.
  const bodies = JSON.parse(gh(['pr', 'list', '--repo', `${owner}/${portfolio}`, '--author', '@me', '--state', 'all', '--limit', '1000', '--json', 'body']))
    .map((p) => p.body).join('\n');

  const out = [];
  for (const r of repos) {
    if (r.name === portfolio || isListed(file, owner, r.name) || bodies.includes(prMarker(owner, r.name))) continue;
    const branch = r.defaultBranchRef?.name ?? 'main';
    let readme = '';
    try { readme = gh(['api', `repos/${owner}/${r.name}/readme`, '-H', 'Accept: application/vnd.github.raw']); } catch { /* no README */ }
    const metadata = [
      `description: ${r.description ?? ''}`,
      `homepage: ${r.homepageUrl ?? ''}`,
      `topics: ${(r.repositoryTopics ?? []).map((t) => t.name).join(', ')}`,
      `languages: ${(r.languages ?? []).map((l) => l.node?.name ?? l.name).join(', ')}`,
    ].join('\n');

    const dir = workdir(r.name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, 'facts.json'), JSON.stringify({ README: readme, metadata }, null, 2));

    // Cover candidates: README images, else the homepage's og:image, else GitHub's social card.
    const images = [];
    for (const url of readmeImages(readme, owner, r.name, branch)) {
      if (images.length === MAX_IMAGES) break;
      const img = await download(url, dir, images.length + 1, owner, r.name);
      if (img) images.push(img);
    }
    if (!images.length && r.homepageUrl) {
      const html = await get(r.homepageUrl, 2 << 20).catch(() => null);
      const og = html && ogImage(html.toString('utf8'), r.homepageUrl);
      const img = og && await download(og, dir, 1, owner, r.name);
      if (img) images.push(img);
    }
    if (!images.length && r.openGraphImageUrl) {
      const img = await download(r.openGraphImageUrl, dir, 1, owner, r.name);
      if (img) images.push({ ...img, source: 'GitHub social card' });
    }

    out.push({ repo: r.name, url: r.url, private: r.isPrivate, dir, facts: join(dir, 'facts.json'), images });
  }
  console.log(JSON.stringify({ owner, portfolio, portfolioPrivate, config: cfg, candidates: out }, null, 2));
}

function check(draftPath) {
  const draft = json(draftPath);
  const result = checkDraft(draft, json(join(workdir(draft.repo), 'facts.json')));
  console.log(JSON.stringify(result, null, 2));
  if (result.errors.length) process.exit(1);
  return result;
}

function apply(draftPath) {
  const cfg = config();
  const { owner } = portfolioRepo();
  const draft = json(draftPath);
  const dir = workdir(draft.repo);
  const { warnings } = check(draftPath);
  const changed = [cfg.file];
  if (draft.image) {
    const { from, to } = draft.image;
    if (typeof from !== 'string' || !inside(dir, from)) throw new Error(`image.from must be one of the candidate images: ${from}`);
    if (typeof to !== 'string' || !inside(cfg.images, to)) throw new Error(`image.to must be inside ${cfg.images}: ${to}`);
    const ext = (p) => extname(p).toLowerCase().replace('.jpeg', '.jpg');
    if (ext(from) !== ext(to)) throw new Error(`image.to must keep the image's real extension (${extname(from)}): ${to}`);
    let exists = true;
    try { lstatSync(to); } catch { exists = false; }
    if (exists) throw new Error(`${to} already exists; pick another file name`);
    mkdirSync(resolve(to, '..'), { recursive: true });
    copyFileSync(from, to);
    changed.push(to);
  }
  writeFileSync(cfg.file, insertEntry(readFileSync(cfg.file, 'utf8'), cfg.marker, draft.entry, draft.imports));
  writeFileSync(join(dir, 'pr.md'), prBody({ owner, repo: draft.repo, sources: draft.sources, warnings, image: draft.image, verify: cfg.verify }));
  console.log(JSON.stringify({ changed, prBody: join(dir, 'pr.md') }, null, 2));
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === 'candidates') await candidates();
  else if (cmd === 'check' && arg) check(arg);
  else if (cmd === 'apply' && arg) apply(arg);
  else { console.error('usage: cli.mjs candidates | check <draft.json> | apply <draft.json>'); process.exit(2); }
} catch (e) {
  const msg = e.code === 'ENOENT' && e.path === 'gh' ? 'the GitHub CLI (gh) is not installed: https://cli.github.com' : e.stderr?.toString().trim() || e.message;
  console.error(`portfolio-sync: ${msg}`);
  process.exit(1);
}
