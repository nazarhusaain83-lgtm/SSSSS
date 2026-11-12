import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { buildPreviewDocument } from '../src/lib/preview.js';

function scriptBodies(html) {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(match => match[1]);
}

test('runs project script.js inside the generated preview', () => {
  const html = buildPreviewDocument([
    { id: 'index', parentId: null, name: 'index.html', content: '<html><head></head><body></body></html>' },
    { id: 'script', parentId: null, name: 'script.js', content: 'console.log("preview works");' }
  ]);
  const body = scriptBodies(html).find(source => source.includes('console.log("preview works")'));
  assert.ok(body, 'script.js should be embedded as executable JavaScript');
  assert.match(body, /\nconsole\.log/);
  const messages = [];
  runInNewContext(body, { console: { log: (...args) => messages.push(args.join(' ')) } });
  assert.deepEqual(messages, ['preview works']);
});

test('resolves nested local stylesheets and scripts from the project tree', () => {
  const html = buildPreviewDocument([
    { id: 'index', parentId: null, name: 'index.html', content: '<html><head><link rel="stylesheet" href="styles/site.css"></head><body><script src="scripts/main.js"></script></body></html>' },
    { id: 'style', parentId: 'styles-folder', name: 'site.css', content: 'body { color: rgb(1, 2, 3); }' },
    { id: 'script', parentId: 'scripts-folder', name: 'main.js', content: 'console.log("nested script");' }
  ], [
    { id: 'styles-folder', parentId: null, name: 'styles' },
    { id: 'scripts-folder', parentId: null, name: 'scripts' }
  ]);
  assert.match(html, /<style>\s*body \{ color: rgb\(1, 2, 3\); \}\s*<\/style>/);
  assert.match(html, /console\.log\("nested script"\)/);
  assert.doesNotMatch(html, /href="styles\/site\.css"/);
  assert.doesNotMatch(html, /src="scripts\/main\.js"/);
});

test('keeps external scripts untouched and escapes closing script text in local code', () => {
  const html = buildPreviewDocument([
    { id: 'index', parentId: null, name: 'index.html', content: '<html><head></head><body><script src="https://example.invalid/app.js"></script></body></html>' },
    { id: 'script', parentId: null, name: 'script.js', content: 'const closingTag = "</script>";' }
  ]);
  assert.match(html, /src="https:\/\/example\.invalid\/app\.js"/);
  assert.match(html, /<\\\/script>/);
});
