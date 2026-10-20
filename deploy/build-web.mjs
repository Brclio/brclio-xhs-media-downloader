import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Only this allowlist becomes public static content. Vercel builds /api
// functions separately and traces their server-side imports.
export const PUBLIC_FILES = [
  'index.html', 'changelog.html', 'app.js', 'style.css', 'site-header.css', 'site-header.js', 'site-navigation.css', 'site-navigation.js', 'changelog.css', 'changelog.js',
  'download.html', 'download.css', 'download.js',
  'feedback.html', 'feedback.css', 'feedback.js',
  'product.html', 'product.css', 'product.js',
  'live.html', 'live.css', 'live.js', 'lib/live-photo-maker.js', 'lib/live-photo-format.js', 'lib/live-photo-package.js',
  'lib/live-photo-heic.js', 'lib/live-photo-heic-encoder.js', 'lib/live-photo-heic-worker.js',
  'learn.html', 'learn.css', 'learn.js',
  'vip.html', 'vip.css', 'vip.js',
  'membership.html', 'membership.css', 'membership.js',
  'support.css', 'visit-counter.js', 'visit-counter.css', 'favicon.svg', 'aiyc.svg',
  'desktop-ui.js', 'desktop-ui.css', 'account-ui.js', 'account-ui.css', 'avatar-ui.js', 'commerce-ui.js', 'commerce-ui.css',
  'lib/archive.js', 'lib/clipboard.js', 'lib/image-dimensions.js', 'lib/avatar-client.js', 'lib/account-avatar-transfer.js', 'lib/media-tracks.js', 'lib/membership-plans.js', 'lib/review-nicknames.js', 'lib/browser-account.js', 'lib/payment-recovery.js', 'lib/parse-verification.js',
  'lib/browser-python.js', 'lib/browser-python-worker.js', 'lib/video-policy.js', 'lib/xhs.js', 'assets', 'admin'
];

export const PYODIDE_VERSION = '314.0.7';
export const PYODIDE_FILES = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];
const MAX_PAGES_ASSET_BYTES = 25 * 1024 * 1024;
const REMOVED_MANUAL_PAYMENT_IMAGES = new Set(['assets/membership/alipay.png', 'assets/membership/wechat-pay.png']);

async function copyBrowserPython(output) {
  const runtime = fileURLToPath(new URL('../node_modules/pyodide/', import.meta.url));
  const pkg = JSON.parse(await readFile(path.join(runtime, 'package.json'), 'utf8'));
  if (pkg.version !== PYODIDE_VERSION) throw new Error('Browser Python requires the pinned Pyodide version');
  const target = path.join(output, 'assets/vendor/pyodide', PYODIDE_VERSION);
  await mkdir(target, { recursive: true });
  for (const name of PYODIDE_FILES) {
    const source = path.join(runtime, name);
    if ((await stat(source)).size > MAX_PAGES_ASSET_BYTES) throw new Error(`Pyodide asset exceeds the Pages file limit: ${name}`);
    await cp(source, path.join(target, name));
  }
  await cp(fileURLToPath(new URL('../cloudflare/python/src/parser_core.py', import.meta.url)), path.join(target, 'parser_core.py'));
}

const WEB_PAGES = new Set(['index.html', 'download.html', 'changelog.html', 'feedback.html',
  'product.html', 'live.html', 'learn.html', 'vip.html', 'membership.html']);

function publicWebNavigation(html, homepage, page) {
  const header = homepage.match(/<header\b[^>]*class="[^"]*\bapp-header\b[^"]*"[^>]*>[\s\S]*?<\/header>/)?.[0];
  if (!header) throw new Error(`The public ${page} page requires the homepage navigation`);
  const currentHref = page === 'index.html' ? '/' : `/${page}`;
  let navigation = header.replace(/<a\b[^>]*>/g, tag => {
    const selected = /class="[^"]*\bnav-link\b[^"]*"/.test(tag) && tag.includes(`href="${currentHref}"`);
    let link = tag.replace(/\saria-current="[^"]*"/g, '').replace(/class="([^"]*)"/, (_, value) => {
      const classes = value.split(/\s+/).filter(name => name && name !== 'is-current');
      if (selected) classes.push('is-current');
      return `class="${classes.join(' ')}"`;
    });
    if (selected) link = link.replace(/>$/, ' aria-current="page">');
    return link.replace('href="#support"', 'href="/#support"');
  });
  if (page !== 'index.html') navigation = navigation.replace(/<button\b[^>]*id="browser-account-open"[^>]*>([\s\S]*?)<\/button>/,
    (_, content) => `<a class="header-account" href="/?account=open">${content}</a>`);

  // The product story keeps its existing presentation controls and progress
  // tracking even though its public navigation follows the rest of the site.
  if (page === 'product.html') {
    const productHeader = html.match(/<header\b[^>]*>[\s\S]*?<\/header>/)?.[0] || '';
    const presentation = productHeader.match(/<button\b[^>]*class="[^"]*\bpresentation-toggle\b[^"]*"[^>]*>[\s\S]*?<\/button>/)?.[0];
    const progress = productHeader.match(/<div\b[^>]*class="[^"]*\breading-progress\b[^"]*"[^>]*>[\s\S]*?<\/div>/)?.[0];
    if (presentation) navigation = navigation.replace('</nav>', `  ${presentation}\n          </nav>`);
    if (progress) navigation = navigation.replace('</header>', `  ${progress}\n    </header>`);
  }

  const webClass = { 'learn.html': 'learning-web', 'vip.html': 'vip-web', 'membership.html': 'membership-web',
    'product.html': 'product-web', 'live.html': 'live-web' }[page];
  const fonts = [...homepage.matchAll(/<link\b[^>]*>/g)]
    .map(match => match[0]).filter(link => /href="https:\/\/fonts\.(?:googleapis|gstatic)\.com\//.test(link));
  let output = html.replace(/<header\b[^>]*>[\s\S]*?<\/header>/, navigation);
  if (webClass) output = output.replace(/<body\b([^>]*)>/, (_, attributes) => attributes.includes('class="')
    ? `<body${attributes.replace(/class="([^"]*)"/, (_, value) => `class="${[...new Set([...value.split(/\s+/).filter(Boolean), webClass])].join(' ')}"`)}>`
    : `<body${attributes} class="${webClass}">`);

  // Theme styles can define generic nav/summary rules. Always load the shared
  // header last, and include its deferred behavior exactly once on each page.
  output = output
    .replace(/<link\b[^>]*href="(?:\.\/|\/)?site-header\.css"[^>]*>\s*/g, '')
    .replace(/<script\b[^>]*src="(?:\.\/|\/)?site-header\.js"[^>]*>[\s\S]*?<\/script>\s*/g, '');
  const missingFonts = fonts.filter(link => !output.includes(link));
  // OAuth returns to the homepage with a short-lived code. Set its referrer
  // policy before even the navigation script is fetched, then install page context.
  output = output.replace(/<meta\b[^>]*name="referrer"[^>]*>\s*/gi, '')
    .replace(/<head\b[^>]*>/, '$&\n  <meta name="referrer" content="no-referrer">\n  <script src="/site-navigation.js"></script>');
  return output.replace('</head>', `${missingFonts.join('\n')}\n  <link rel="stylesheet" href="./site-navigation.css">\n  <link rel="stylesheet" href="./site-header.css">\n  <script src="./site-header.js" defer></script>\n</head>`);
}

export async function buildWeb(root = fileURLToPath(new URL('../', import.meta.url))) {
  const output = path.join(root, 'dist-web');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const homepage = (await readFile(path.join(root, 'index.html'), 'utf8'))
    .replace(/^[ \t]*<!-- desktop-only:start -->[\s\S]*?<!-- desktop-only:end -->\r?\n?/gm, '');
  for (const name of PUBLIC_FILES) {
    const destination = path.join(output, name);
    await mkdir(path.dirname(destination), { recursive: true });
    if (name.endsWith('.html')) {
      // Electron packages the original pages. Public deployments omit client-only
      // benefits entirely, including their links and supporting resource tags.
      let html = (await readFile(path.join(root, name), 'utf8'))
        .replace(/^[ \t]*<!-- desktop-only:start -->[\s\S]*?<!-- desktop-only:end -->\r?\n?/gm, '');
      if (html.includes('<!-- desktop-only:')) throw new Error(`Unmatched desktop-only block in ${name}`);
      // Native clients retain their local headers. Every public page shares
      // the downloader's navigation, typography and responsive menu behavior.
      if (WEB_PAGES.has(name) && /<header\b/.test(html)) {
        html = publicWebNavigation(html, homepage, name);
      }
      await writeFile(destination, html);
    } else {
      await cp(path.join(root, name), destination, {
        recursive: true,
        dereference: false,
        // Finder metadata and AppleDouble resource forks are not public assets.
        filter: source => path.basename(source) !== '.DS_Store' && !path.basename(source).startsWith('._')
          && !REMOVED_MANUAL_PAYMENT_IMAGES.has(path.relative(root, source).split(path.sep).join('/')),
      });
    }
  }
  await copyBrowserPython(output);
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Public web output: ${await buildWeb()}`);
}
