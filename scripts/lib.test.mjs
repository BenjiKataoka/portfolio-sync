import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeName, publicUrl, imageExt, isListed, readmeImages, ogImage, checkDraft, insertEntry, prBody } from './lib.mjs';

test('isListed: URL or quoted repo name', () => {
  const file = "links: [gh('Fantas.ai')], href: 'https://github.com/benjikataoka/Burnrate'";
  assert.ok(isListed(file, 'BenjiKataoka', 'Fantas.ai'));
  assert.ok(isListed(file, 'BenjiKataoka', 'Burnrate'));
  assert.ok(!isListed(file, 'BenjiKataoka', 'Fantas'), 'substring of a quoted name is not a match');
  assert.ok(!isListed(file, 'BenjiKataoka', 'portfolio-sync'));
  const marked = "  // portfolio-sync:insert (entries from github.com/BenjiKataoka/portfolio-sync land here)\n];";
  assert.ok(!isListed(marked, 'BenjiKataoka', 'portfolio-sync', '// portfolio-sync:insert'), 'the marker line never counts');
  assert.ok(isListed(marked, 'BenjiKataoka', 'portfolio-sync'), 'without the marker argument it would match');
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
  const body = prBody({ owner: 'o', repo: 'r', sources: [{ claim: 'a|b', quote: 'qqq', from: 'README' }], warnings: ['"4" isn\'t in the repo'], image: { to: 'docs/a.png', source: 'README' }, verify: 'npm test' });
  assert.ok(body.startsWith('<!-- portfolio-sync:o/r -->'));
  assert.match(body, /\| a\\\|b \| README: "qqq" \|/);
  assert.match(body, /Check these/);
});

test('safeName: plain repo names only', () => {
  for (const ok of ['Burnrate', 'Fantas.ai', 'Reinforcement-Learning-Self-Driving-Car-', 'a_b']) assert.equal(safeName(ok), ok);
  for (const bad of ['..', '.', '../x', 'a/b', '', 'a\\b', undefined]) assert.throws(() => safeName(bad));
});

test('publicUrl: https to a public hostname only', () => {
  assert.ok(publicUrl('https://raw.githubusercontent.com/o/r/main/a.png'));
  for (const bad of ['http://x.dev/a.png', 'file:///etc/passwd', 'https://localhost/a.png', 'https://127.0.0.1/a.png',
    'https://169.254.169.254/latest', 'https://[::1]/a.png', 'https://10.0.0.5/a.png', 'https://metadata.google.internal/x', 'not a url']) {
    assert.ok(!publicUrl(bad), bad);
  }
});

test('readmeImages: drops paths that climb out of the repo', () => {
  assert.deepEqual(readmeImages('![x](../../../user/a.png) ![y](docs/a.png?x=1)', 'o', 'r', 'main'), []);
});

test('imageExt: magic bytes, not headers', () => {
  const pad = (h) => Buffer.concat([Buffer.from(h, 'latin1'), Buffer.alloc(16)]);
  assert.equal(imageExt(pad('\x89PNG\r\n')), 'png');
  assert.equal(imageExt(pad('\xff\xd8\xff\xe0')), 'jpg');
  assert.equal(imageExt(pad('GIF89a')), 'gif');
  assert.equal(imageExt(pad('RIFF\0\0\0\0WEBP')), 'webp');
  assert.equal(imageExt(pad('\0\0\0\x1cftypavif')), 'avif');
  assert.equal(imageExt(pad('<!doctype html>')), null);
  assert.equal(imageExt(pad('<svg xmlns=')), null);
});

test('checkDraft: shape, blank quotes, numbers inside names', () => {
  const facts = { README: 'Runs every 15 minutes.', metadata: '' };
  const q = [{ claim: 'c', quote: 'every 15 minutes', from: 'README' }];
  assert.deepEqual(checkDraft({ entry: "id: 'project2', every 15 minutes", sources: q }, facts), { errors: [], warnings: [] });
  assert.match(checkDraft({ entry: 'x', sources: [{ claim: 'c', quote: '  ', from: 'README' }] }, facts).errors[0], /quote/);
  assert.ok(checkDraft({ sources: q }, facts).errors.some((e) => /entry/.test(e)), 'missing entry is an error, not a crash');
  assert.ok(checkDraft({ entry: 'x', imports: ['a\nb'], sources: q }, facts).errors.some((e) => /imports/.test(e)));
});

test('insertEntry: multi-line imports, marker inside the entry', () => {
  const file = "import {\n  a,\n  b,\n} from './ab';\nimport c from './c';\n\nconst x = [\n  // M\n];\n";
  assert.equal(insertEntry(file, '// M', '  1,', ["import d from './d';"]),
    "import {\n  a,\n  b,\n} from './ab';\nimport c from './c';\nimport d from './d';\n\nconst x = [\n  1,\n  // M\n];\n");
  const multi = "import {\n  a,\n} from './a';\nconst x = [\n  // M\n];";
  assert.equal(insertEntry(multi, '// M', '  1,', ["import d from './d';"]).split('\n')[3], "import d from './d';");
  assert.throws(() => insertEntry(file, '// M', '  1, // M'), /marker/);
  assert.equal(insertEntry("import a from './a'; // note\nconst y = 1;\n// M", '// M', '1', ["import d from './d';"]).split('\n')[1], "import d from './d';");
});

test('prBody: quotes cannot ping people or forge the dedup marker', () => {
  const body = prBody({ owner: 'o', repo: 'r', warnings: [], verify: 'v', image: { to: 'a/x.png', source: '<!-- portfolio-sync:o/z -->' },
    sources: [{ claim: 'thanks @alice', quote: '<!-- portfolio-sync:o/other -->', from: 'README' }] });
  assert.equal(body.match(/<!--/g).length, 1, 'only the real marker');
  assert.ok(!/@alice/.test(body));
});
