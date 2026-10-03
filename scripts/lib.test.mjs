import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRemote, isListed, readmeImages, ogImage, checkDraft, insertEntry, prBody } from './lib.mjs';

test('parseRemote', () => {
  assert.deepEqual(parseRemote('https://github.com/BenjiKataoka/Personal-Portfolio.git'), { owner: 'BenjiKataoka', repo: 'Personal-Portfolio' });
  assert.deepEqual(parseRemote('git@github.com:a/b.c.git\n'), { owner: 'a', repo: 'b.c' });
  assert.throws(() => parseRemote('https://gitlab.com/a/b'));
});

test('isListed: URL or quoted repo name', () => {
  const file = "links: [gh('Fantas.ai')], href: 'https://github.com/benjikataoka/Burnrate'";
  assert.ok(isListed(file, 'BenjiKataoka', 'Fantas.ai'));
  assert.ok(isListed(file, 'BenjiKataoka', 'Burnrate'));
  assert.ok(!isListed(file, 'BenjiKataoka', 'Fantas'), 'substring of a quoted name is not a match');
  assert.ok(!isListed(file, 'BenjiKataoka', 'portfolio-sync'));
});

test('readmeImages: order, badges, relative paths, blob links', () => {
  const md = [
    '[![CI](https://img.shields.io/badge/ci-passing-green)](x)',
    '<img src="docs/hero.png" width="600">',
    '![dash](./docs/dash.png "Dashboard")',
    '![logo](logo.svg)',
    '![remote](https://github.com/o/r/blob/main/a.jpg)',
    '![dup](docs/dash.png)',
  ].join('\n');
  assert.deepEqual(readmeImages(md, 'o', 'r', 'main'), [
    'https://raw.githubusercontent.com/o/r/main/docs/hero.png',
    'https://raw.githubusercontent.com/o/r/main/docs/dash.png',
    'https://raw.githubusercontent.com/o/r/main/a.jpg',
  ]);
});

test('ogImage: either attribute order, relative URL', () => {
  assert.equal(ogImage('<meta content="/og.png" property="og:image">', 'https://x.dev/app'), 'https://x.dev/og.png');
  assert.equal(ogImage("<meta property='og:image' content='https://cdn/a.png'/>", 'https://x.dev'), 'https://cdn/a.png');
  assert.equal(ogImage('<title>no og</title>', 'https://x.dev'), null);
});

test('checkDraft: quotes must exist, unknown numbers warn', () => {
  const facts = { README: 'Checks **Neon**, Clerk and   Vercel every 15 minutes.', metadata: 'languages: Python' };
  const ok = checkDraft({
    entry: "result: 'Checks 3 providers every 15 minutes.'",
    sources: [{ claim: 'every 15 min', quote: 'every 15 minutes', from: 'README' }, { claim: 'neon', quote: 'Checks Neon, clerk and Vercel', from: 'README' }],
  }, facts);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.warnings, ['"3" isn\'t in the repo']);

  const bad = checkDraft({ entry: 'x', sources: [{ claim: 'fast', quote: 'cut latency 50%', from: 'README' }, { claim: 'y', quote: 'y', from: 'blog' }] }, facts);
  assert.equal(bad.errors.length, 2);
  assert.equal(checkDraft({ entry: 'x', sources: [] }, facts).errors.length, 1);
  assert.deepEqual(checkDraft({ entry: '5 providers', sources: [] }, facts).warnings, ['"5" isn\'t in the repo'], '"5" inside "15" does not count');
});

test('insertEntry: above the marker, imports after the last import, no duplicates', () => {
  const file = "import a from './a';\nimport b from './b';\n\nexport const projects = [\n  { id: 'a' },\n  // portfolio-sync:insert\n];\n";
  const out = insertEntry(file, '// portfolio-sync:insert', "  { id: 'c' },\n", ["import c from './c';", "import a from './a';"]);
  assert.equal(out, "import a from './a';\nimport b from './b';\nimport c from './c';\n\nexport const projects = [\n  { id: 'a' },\n  { id: 'c' },\n  // portfolio-sync:insert\n];\n");
  assert.throws(() => insertEntry('no marker', '// portfolio-sync:insert', 'x'), /exactly once, found 0/);
});

test('prBody carries the dedup marker and escapes table cells', () => {
  const body = prBody({ owner: 'o', repo: 'r', sources: [{ claim: 'a|b', quote: 'q', from: 'README' }], warnings: ['"4" isn\'t in the repo'], cover: 'docs/a.png', verify: 'npm test' });
  assert.ok(body.startsWith('<!-- portfolio-sync:o/r -->'));
  assert.match(body, /\| a\\\|b \| README: "q" \|/);
  assert.match(body, /Check these/);
});
