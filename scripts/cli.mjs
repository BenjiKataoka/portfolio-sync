#!/usr/bin/env node
// portfolio-sync CLI. Run from the portfolio repo root:
//   cli.mjs candidates        new opted-in repos as JSON, facts and images saved under $TMPDIR/portfolio-sync/<repo>/
//   cli.mjs check <draft>     exit 1 if a cited quote isn't in the facts
//   cli.mjs apply <draft>     insert the entry, copy the cover, write the PR body
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { safeName, publicUrl, parseRemote, isListed, prMarker, readmeImages, ogImage, checkDraft, insertEntry, prBody } from './lib.mjs';

const TMP = join(tmpdir(), 'portfolio-sync');
const MAX_IMAGES = 3;

const gh = (args, encoding = 'utf8') => execFileSync('gh', args, { encoding, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const inside = (dir, path) => { const r = relative(resolve(dir), resolve(path)); return r && !r.startsWith('..') && !isAbsolute(r); };

function config() {
  if (!existsSync('.portfolio-sync.json')) throw new Error('no .portfolio-sync.json here; run this from the portfolio repo root');
  const c = { topic: 'portfolio', context: [], voice: '', ...json('.portfolio-sync.json') };
  for (const k of ['file', 'marker', 'images', 'verify']) if (!c[k]) throw new Error(`.portfolio-sync.json is missing "${k}"`);
  return c;
}

const origin = () => parseRemote(execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }));

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };

/** Saves one image into dir and returns its path, or null. Own-repo files go through gh so private repos work. */
async function download(url, dir, n, owner, repo) {
  try {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const own = url.match(new RegExp(`^https://raw\\.githubusercontent\\.com/${esc(owner)}/${esc(repo)}/([^/?#]+)/([^?#]+)$`));
    if (own && /(^|\/)\.\.(\/|$)/.test(decodeURIComponent(own[2]))) return null;
    let buf, type;
    if (own) {
      buf = gh(['api', `repos/${owner}/${repo}/contents/${own[2]}?ref=${own[1]}`, '-H', 'Accept: application/vnd.github.raw'], 'buffer');
      const ext = own[2].toLowerCase().match(/\.(png|jpe?g|webp|gif|avif)$/)?.[1];
      type = ext && `image/${ext === 'jpg' ? 'jpeg' : ext}`;
    } else {
      if (!publicUrl(url)) return null;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      type = res.headers.get('content-type')?.split(';')[0];
      buf = Buffer.from(await res.arrayBuffer());
    }
    if (!EXT[type] || buf.length < 1000) return null; // svg, html error pages, tracking pixels
    const path = join(dir, `image-${n}.${EXT[type]}`);
    writeFileSync(path, buf);
    return { path, source: url };
  } catch {
    return null;
  }
}

async function candidates() {
  const cfg = config();
  const { owner, repo: portfolio } = origin();
  const repos = JSON.parse(gh(['repo', 'list', owner, '--topic', cfg.topic, '--source', '--no-archived', '--limit', '1000',
    '--json', 'name,url,description,homepageUrl,repositoryTopics,languages,defaultBranchRef,isPrivate,openGraphImageUrl']));
  const file = readFileSync(cfg.file, 'utf8');
  const bodies = JSON.parse(gh(['pr', 'list', '--repo', `${owner}/${portfolio}`, '--state', 'all', '--limit', '1000', '--json', 'body']))
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

    const dir = join(TMP, safeName(r.name));
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'facts.json'), JSON.stringify({ README: readme, metadata }, null, 2));

    // Cover candidates: README images, else the homepage's og:image, else GitHub's social card.
    const images = [];
    for (const url of readmeImages(readme, owner, r.name, branch)) {
      if (images.length === MAX_IMAGES) break;
      const img = await download(url, dir, images.length + 1, owner, r.name);
      if (img) images.push(img);
    }
    if (!images.length && r.homepageUrl && publicUrl(r.homepageUrl)) {
      const og = await fetch(r.homepageUrl, { signal: AbortSignal.timeout(15000) }).then((res) => res.text()).then((h) => ogImage(h, r.homepageUrl)).catch(() => null);
      const img = og && await download(og, dir, 1, owner, r.name);
      if (img) images.push(img);
    }
    if (!images.length && r.openGraphImageUrl) {
      const img = await download(r.openGraphImageUrl, dir, 1, owner, r.name);
      if (img) images.push({ ...img, source: 'GitHub social card' });
    }

    out.push({ repo: r.name, url: r.url, private: r.isPrivate, dir, facts: join(dir, 'facts.json'), images });
  }
  console.log(JSON.stringify({ owner, portfolio, config: cfg, candidates: out }, null, 2));
}

function check(draftPath) {
  const draft = json(draftPath);
  const result = checkDraft(draft, json(join(TMP, safeName(draft.repo), 'facts.json')));
  console.log(JSON.stringify(result, null, 2));
  if (result.errors.length) process.exit(1);
  return result;
}

function apply(draftPath) {
  const cfg = config();
  const { owner } = origin();
  const draft = json(draftPath);
  safeName(draft.repo);
  const { warnings } = check(draftPath);
  if (draft.image) {
    if (!inside(join(TMP, draft.repo), draft.image.from)) throw new Error(`image.from must be one of the candidate images: ${draft.image.from}`);
    if (!inside(cfg.images, draft.image.to)) throw new Error(`image.to must be inside ${cfg.images}: ${draft.image.to}`);
    mkdirSync(resolve(draft.image.to, '..'), { recursive: true });
    copyFileSync(draft.image.from, draft.image.to);
  }
  writeFileSync(cfg.file, insertEntry(readFileSync(cfg.file, 'utf8'), cfg.marker, draft.entry, draft.imports));
  const body = join(TMP, draft.repo, 'pr.md');
  writeFileSync(body, prBody({ owner, repo: draft.repo, sources: draft.sources, warnings, cover: draft.image ? `\`${basename(draft.image.to)}\` from ${draft.image.source ?? 'the repo'}` : 'none', verify: cfg.verify }));
  console.log(`Inserted into ${cfg.file}. PR body: ${body}`);
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === 'candidates') await candidates();
  else if (cmd === 'check' && arg) check(arg);
  else if (cmd === 'apply' && arg) apply(arg);
  else { console.error('usage: cli.mjs candidates | check <draft.json> | apply <draft.json>'); process.exit(2); }
} catch (e) {
  console.error(`portfolio-sync: ${e.stderr?.toString().trim() || e.message}`);
  process.exit(1);
}
