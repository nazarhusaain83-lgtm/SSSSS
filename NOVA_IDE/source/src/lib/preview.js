/**
 * Builds a sandboxed preview from the project's persisted files and folders.
 * Local stylesheet and script references are resolved from the virtual project
 * tree so nested files behave like files in a normal project directory.
 */
function normalizeProjectPath(value) {
  const stack = [];
  for (const part of String(value || '').replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!stack.length) return null;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join('/');
}

function getFolderPath(folderId, foldersById) {
  const parts = [];
  const visited = new Set();
  let currentId = folderId || null;

  while (currentId) {
    if (visited.has(currentId)) return null;
    visited.add(currentId);
    const folder = foldersById.get(currentId);
    if (!folder) return null;
    parts.unshift(folder.name);
    currentId = folder.parentId || null;
  }

  return normalizeProjectPath(parts.join('/'));
}

function getFilePath(file, foldersById) {
  const parentPath = getFolderPath(file.parentId, foldersById);
  if (parentPath === null) return null;
  return normalizeProjectPath(parentPath ? parentPath + '/' + file.name : file.name);
}

function resolveLocalReference(reference, htmlPath) {
  const value = String(reference || '').trim();
  if (
    !value ||
    value.startsWith('#') ||
    value.startsWith('//') ||
    /^[a-z][a-z\d+.-]*:/i.test(value)
  ) {
    return null;
  }

  const withoutQuery = value.split(/[?#]/, 1)[0];
  const baseDirectory = htmlPath.includes('/')
    ? htmlPath.slice(0, htmlPath.lastIndexOf('/'))
    : '';
  return normalizeProjectPath(
    value.startsWith('/')
      ? withoutQuery.slice(1)
      : [baseDirectory, withoutQuery].filter(Boolean).join('/')
  );
}

function getAttribute(tag, name) {
  const match = tag.match(
    new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i')
  );
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : '';
}

function insertBeforeClosingTag(document, tagName, content) {
  const closingTag = new RegExp('</' + tagName + '\\s*>', 'i');
  if (closingTag.test(document)) {
    return document.replace(closingTag, content + '\n</' + tagName + '>');
  }
  return content + '\n' + document;
}

function escapeRawText(content, tagName) {
  return String(content).replace(
    new RegExp('</' + tagName, 'gi'),
    '<\\/' + tagName
  );
}

const CONSOLE_BRIDGE = [
  "(function () {",
  "  function safeText(value) {",
  "    if (typeof value === 'string') return value;",
  "    try { return JSON.stringify(value); } catch (error) { return '[Unserializable value]'; }",
  "  }",
  "  function send(level, message) {",
  "    window.parent.postMessage({ source: 'nova-preview', type: 'console', level: level, message: String(message) }, '*');",
  "  }",
  "  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {",
  "    var original = console[level] && console[level].bind(console);",
  "    console[level] = function () {",
  "      var message = Array.prototype.map.call(arguments, safeText).join(' ');",
  "      send(level, message);",
  "      if (original) original.apply(console, arguments);",
  "    };",
  "  });",
  "  window.addEventListener('error', function (event) {",
  "    send('error', (event.message || 'Runtime error') + (event.filename ? ' (' + event.filename + ':' + event.lineno + ')' : ''));",
  "  });",
  "  window.addEventListener('unhandledrejection', function (event) {",
  "    send('error', 'Unhandled promise rejection: ' + safeText(event.reason));",
  "  });",
  "})();"
].join('\n');

/** @param {Array<{id:string,parentId?:string|null,name:string,content:string}>} files */
/** @param {Array<{id:string,parentId?:string|null,name:string}>} folders */
export function buildPreviewDocument(files, folders = []) {
  const foldersById = new Map(folders.map(folder => [folder.id, folder]));
  const filesByPath = new Map();
  for (const file of files) {
    const path = getFilePath(file, foldersById);
    if (path) filesByPath.set(path.toLowerCase(), { ...file, path });
  }

  const rootIndex = files.find(
    file => !file.parentId && String(file.name || '').toLowerCase() === 'index.html'
  );
  const htmlFile = rootIndex || filesByPath.get('index.html');
  let document = htmlFile?.content ||
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nova Preview</title></head><body><main><h1>Welcome to your preview</h1><p>Create an index.html file to get started.</p></main></body></html>';
  const htmlPath = htmlFile?.path || 'index.html';
  const inlinedStyles = new Set();
  const inlinedScripts = new Set();

  // Inline local CSS while preserving external stylesheets and unsupported URLs.
  document = document.replace(/<link\b[^>]*>/gi, tag => {
    const rel = getAttribute(tag, 'rel').toLowerCase().split(/\s+/);
    if (!rel.includes('stylesheet')) return tag;
    const href = getAttribute(tag, 'href');
    const resolved = resolveLocalReference(href, htmlPath);
    const asset = resolved && filesByPath.get(resolved.toLowerCase());
    if (!asset || !/\.css$/i.test(asset.name)) return tag;
    inlinedStyles.add(asset.path.toLowerCase());
    return '<style>\n' + escapeRawText(asset.content, 'style') + '\n</style>';
  });

  // Inline local JS files; external URLs remain unchanged.
  document = document.replace(
    /<script\b[^>]*\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>\s*<\/script\s*>/gi,
    fullTag => {
      const openTag = fullTag.match(/^<script\b[^>]*>/i)?.[0];
      if (!openTag) return fullTag;
      const src = getAttribute(openTag, 'src');
      const resolved = resolveLocalReference(src, htmlPath);
      const asset = resolved && filesByPath.get(resolved.toLowerCase());
      if (!asset || !/\.(?:js|mjs|cjs)$/i.test(asset.name)) return fullTag;
      inlinedScripts.add(asset.path.toLowerCase());
      const safeOpenTag = openTag.replace(
        /\s+src\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i,
        ''
      );
      return safeOpenTag + '\n' + escapeRawText(asset.content, 'script') + '\n</script>';
    }
  );

  const rootCss = filesByPath.get('style.css');
  if (rootCss && !inlinedStyles.has(rootCss.path.toLowerCase())) {
    document = insertBeforeClosingTag(
      document,
      'head',
      '<style>\n' + escapeRawText(rootCss.content, 'style') + '\n</style>'
    );
  }

  const rootScript = filesByPath.get('script.js');
  if (rootScript && !inlinedScripts.has(rootScript.path.toLowerCase())) {
    const scriptTag = '<script>\n' + escapeRawText(rootScript.content, 'script') + '\n</script>';
    if (/<\/body\s*>/i.test(document)) {
      document = document.replace(/<\/body\s*>/i, scriptTag + '\n</body>');
    } else {
      document += '\n' + scriptTag;
    }
  }

  const bridgeTag = '<script>' + CONSOLE_BRIDGE + '</script>';
  document = insertBeforeClosingTag(document, 'head', bridgeTag);
  return document;
}
