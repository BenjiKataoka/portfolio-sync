// Pure helpers: no network, no filesystem. Everything here is covered by lib.test.mjs.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A repo name safe to use as a path segment; throws otherwise. */
export function safeName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name) || /^\.+$/.test(name)) throw new Error(`bad repo name: ${name}`);
  return name;
}

/**
 * True for https URLs to a public-looking hostname: no IP literals, localhost or internal names.
 * ponytail: hostname check only; DNS rebinding and redirects to internal hosts aren't covered. The URLs come from
 * the user's own opted-in repos, so this guards against accidents rather than a determined attacker.
 */
export function publicUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && hostname.includes('.') && !/^[\d.]+$|^\[|localhost|\.internal$|\.local$/i.test(hostname);
  } catch {
    return false;
  }
}

/** Parses `owner/repo` out of a GitHub remote URL (https or ssh). */
export function parseRemote(url) {
  const m = url.trim().match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (!m) throw new Error(`not a GitHub remote: ${url}`);
  return { owner: m[1], repo: m[2] };
}

/** True when the data file already mentions the repo, by URL or as a quoted name (e.g. gh('Burnrate')). */
export function isListed(text, owner, repo) {
  if (text.toLowerCase().includes(`github.com/${owner}/${repo}`.toLowerCase())) return true;
  return new RegExp(`(['"\`])${escapeRe(repo)}\\1`).test(text);
}

export const prMarker = (owner, repo) => `<!-- portfolio-sync:${owner}/${repo} -->`;

const BADGE = /shields\.io|badgen\.net|badge|\.svg(\?|$)/i;

/** Image URLs in a README (markdown and <img>), badges dropped, relative paths made absolute. */
export function readmeImages(md, owner, repo, branch) {
  const srcs = [
    ...[...md.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]),
    ...[...md.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((m) => m[1]),
  ];
  // Markdown and <img> matches are collected separately; restore README order.
  srcs.sort((a, b) => md.indexOf(a) - md.indexOf(b));
  const out = [];
  for (const src of srcs) {
    if (BADGE.test(src) || /(^|\/)\.\.(\/|$)|[?#]/.test(src) && !/^https?:\/\//.test(src)) continue;
    const url = /^https?:\/\//.test(src)
      ? src.replace(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\//, 'https://raw.githubusercontent.com/$1/')
      : `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${src.replace(/^\.?\//, '')}`;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/** The og:image URL in a page's HTML, resolved against the page URL. */
export function ogImage(html, pageUrl) {
  const tag = html.match(/<meta\b[^>]*(?:property|name)=["']og:image["'][^>]*>/i)?.[0];
  const content = tag?.match(/\bcontent=["']([^"']+)["']/i)?.[1];
  return content ? new URL(content, pageUrl).href : null;
}

const norm = (s) => s.toLowerCase().replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Every source quote must appear in the facts it cites. Numbers in the entry that appear nowhere in the
 * facts are only warnings: a count like "4 providers" can be honest without being quoted.
 */
export function checkDraft(draft, facts) {
  const errors = [];
  if (!draft.sources?.length) errors.push('draft has no sources');
  for (const s of draft.sources ?? []) {
    const text = facts[s.from];
    if (text == null) errors.push(`unknown source "${s.from}" for claim "${s.claim}"`);
    else if (!s.quote || !norm(text).includes(norm(s.quote))) errors.push(`quote not found in ${s.from}: "${s.quote}"`);
  }
  const all = norm(Object.values(facts).join('\n'));
  const nums = new Set(draft.entry.match(/\d+(?:[.,]\d+)?%?/g) ?? []);
  const warnings = [...nums]
    .filter((n) => !new RegExp(`(^|[^\\d.,])${escapeRe(n)}(?![\\d]|[.,]\\d)`).test(all))
    .map((n) => `"${n}" isn't in the repo`);
  return { errors, warnings };
}

/** Inserts the entry on the line above the marker and any new import lines after the last import. */
export function insertEntry(text, marker, entry, imports = []) {
  const lines = text.split('\n');
  const hits = lines.flatMap((l, i) => (l.includes(marker) ? [i] : []));
  if (hits.length !== 1) throw new Error(`expected the marker "${marker}" exactly once, found ${hits.length}`);
  lines.splice(hits[0], 0, ...entry.replace(/\n+$/, '').split('\n'));
  const fresh = imports.filter((i) => !lines.includes(i));
  if (fresh.length) {
    let last = -1;
    lines.forEach((l, i) => { if (/^import\b/.test(l)) last = i; });
    lines.splice(last + 1, 0, ...fresh);
  }
  return lines.join('\n');
}

/** The PR body: the dedup marker, the claim table, and anything the reviewer should look at. */
export function prBody({ owner, repo, sources, warnings, cover, verify }) {
  const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [
    prMarker(owner, repo),
    `Drafted from [${owner}/${repo}](https://github.com/${owner}/${repo}). Check it on the preview, edit anything, then merge. Close it to never propose this repo again.`,
    '',
    '| Claim | Source |',
    '|---|---|',
    ...sources.map((s) => `| ${cell(s.claim)} | ${cell(s.from)}: "${cell(s.quote)}" |`),
    '',
    ...(warnings.length ? ['**Check these:** ' + warnings.join('; '), ''] : []),
    `Cover: ${cover}. \`${verify}\` ✅`,
  ].join('\n');
}
