import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Only this allowlist becomes public static content. Vercel builds /api
// functions separately and traces their server-side imports.
export const PUBLIC_FILES = [
  'index.html', 'changelog.html', 'app.js', 'style.css', 'site-header.css', 'changelog.css', 'changelog.js',
  'download.html', 'download.css', 'download.js',
  'feedback.html', 'feedback.css', 'feedback.js',
  'product.html', 'product.css', 'product.js',
  'learn.html', 'learn.css', 'learn.js',
  'vip.html', 'vip.css', 'vip.js',
  'membership.html', 'membership.css', 'membership.js',
  'support.css', 'visit-counter.js', 'visit-counter.css', 'favicon.svg', 'aiyc.svg',
  'desktop-ui.js', 'desktop-ui.css', 'account-ui.js', 'account-ui.css',
  'lib/archive.js', 'lib/clipboard.js', 'lib/image-dimensions.js', 'lib/media-tracks.js', 'lib/membership-plans.js', 'lib/browser-account.js', 'assets', 'admin'
];

function promotionWebNavigation(html, homepage, page = 'learn.html') {
  const header = homepage.match(/<header\b[^>]*class="app-header"[^>]*>[\s\S]*?<\/header>/)?.[0];
  if (!header) throw new Error('The learning page requires the homepage navigation');
  const webClass = page === 'vip.html' ? 'vip-web' : page === 'membership.html' ? 'membership-web' : 'learning-web';
  let navigation = header.replace(/<a\b[^>]*>/g, tag => {
    const selected = tag.includes(`href="/${page}"`);
    let link = tag.replace(/\saria-current="[^"]*"/g, '').replace(/class="([^"]*)"/, (_, value) => {
      const classes = value.split(/\s+/).filter(name => name && name !== 'is-current');
      if (selected) classes.push('is-current');
      return `class="${classes.join(' ')}"`;
    });
    if (selected) link = link.replace(/>$/, ' aria-current="page">');
    return link.replace('href="#support"', 'href="/#support"');
  });
  if (page === 'membership.html') navigation = navigation.replace(/<button\b[^>]*id="browser-account-open"[^>]*>[\s\S]*?<\/button>/,
    '<a class="nav-link" href="./index.html?membership=open">账号与会员</a>');
  const fonts = [...homepage.matchAll(/<link\b[^>]*>/g)]
    .map(match => match[0]).filter(link => /href="https:\/\/fonts\.(?:googleapis|gstatic)\.com\//.test(link));
  return html.replace(/<header\b[^>]*>[\s\S]*?<\/header>/, navigation)
    .replace(/<body\b([^>]*)>/, (_, attributes) => attributes.includes('class="')
      ? `<body${attributes.replace(/class="([^"]*)"/, `class="$1 ${webClass}"`)}>`
      : `<body${attributes} class="${webClass}">`)
    .replace('</head>', `${fonts.join('\n')}\n  <link rel="stylesheet" href="./site-header.css">\n</head>`);
}

export async function buildWeb(root = fileURLToPath(new URL('../', import.meta.url))) {
  const output = path.join(root, 'dist-web');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const name of PUBLIC_FILES) {
    const destination = path.join(output, name);
    await mkdir(path.dirname(destination), { recursive: true });
    if (name.endsWith('.html')) {
      // Electron packages the original pages. Public deployments omit client-only
      // benefits entirely, including their links and supporting resource tags.
      let html = (await readFile(path.join(root, name), 'utf8'))
        .replace(/^[ \t]*<!-- desktop-only:start -->[\s\S]*?<!-- desktop-only:end -->\r?\n?/gm, '');
      if (html.includes('<!-- desktop-only:')) throw new Error(`Unmatched desktop-only block in ${name}`);
      // Native clients retain their compact local navigation. The public
      // promotion pages receive the same menu and fonts as the downloader home.
      if (['learn.html', 'vip.html', 'membership.html'].includes(name) && /<header\b/.test(html)) {
        html = promotionWebNavigation(html, await readFile(path.join(root, 'index.html'), 'utf8'), name);
      }
      await writeFile(destination, html);
    } else {
      await cp(path.join(root, name), destination, { recursive: true, dereference: false });
    }
  }
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Public web output: ${await buildWeb()}`);
}
