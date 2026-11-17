/**
 * Build Script for Antigravity Browser Extension
 * Compiles TypeScript into JavaScript and copies static assets into dist/
 */

const fs = require('fs');
const path = require('path');

const rootDir = __dirname;
const publicBuild = process.argv.includes('--public');
const extensionDir = publicBuild ? path.join(rootDir, 'public-build') : rootDir;
const distDir = path.join(extensionDir, 'dist');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyAssets() {
  ensureDir(distDir);
  ensureDir(path.join(distDir, 'background'));
  ensureDir(path.join(distDir, 'content'));
  ensureDir(path.join(distDir, 'popup'));
  ensureDir(path.join(distDir, 'sidepanel'));
  ensureDir(path.join(distDir, 'icons'));
  ensureDir(path.join(distDir, 'trading'));
  for (const asset of ['chart.html', 'chart.css']) {
    fs.copyFileSync(path.join(rootDir, 'src/trading', asset), path.join(distDir, 'trading', asset));
  }

  // Copy HTML, CSS, and Icon assets
  fs.copyFileSync(path.join(rootDir, 'src/popup/popup.html'), path.join(distDir, 'popup/popup.html'));
  fs.copyFileSync(path.join(rootDir, 'src/popup/popup.css'), path.join(distDir, 'popup/popup.css'));
  if (fs.existsSync(path.join(rootDir, 'src/popup/auth-success.html'))) {
    fs.copyFileSync(path.join(rootDir, 'src/popup/auth-success.html'), path.join(distDir, 'popup/auth-success.html'));
  }
  if (fs.existsSync(path.join(rootDir, 'rules.json'))) {
    fs.copyFileSync(path.join(rootDir, 'rules.json'), path.join(distDir, 'rules.json'));
  }
  fs.copyFileSync(path.join(rootDir, 'src/sidepanel/sidepanel.html'), path.join(distDir, 'sidepanel/sidepanel.html'));
  if (fs.existsSync(path.join(rootDir, 'src/sidepanel/sidepanel.css'))) {
    fs.copyFileSync(path.join(rootDir, 'src/sidepanel/sidepanel.css'), path.join(distDir, 'sidepanel/sidepanel.css'));
  }
  if (fs.existsSync(path.join(rootDir, 'src/background-fx/playground.html'))) {
    fs.copyFileSync(path.join(rootDir, 'src/background-fx/playground.html'), path.join(distDir, 'playground.html'));
  }

  const iconFiles = ['icon16.png', 'icon48.png', 'icon128.png', 'gemini.svg', 'smithLogo.png'];
  for (const file of iconFiles) {
    const srcIcon = path.join(rootDir, 'icons', file);
    if (fs.existsSync(srcIcon)) {
      fs.copyFileSync(srcIcon, path.join(distDir, 'icons', file));
    }
  }

}

async function build() {
  console.log('[Build] Building Antigravity Extension...');
  const watch = process.argv.includes('--watch');
  if (publicBuild && watch) throw new Error('Use the normal build when running watch mode.');
  const esbuild = require('esbuild');
  // A configured local build includes the OAuth application configuration.
  // Its users can start Google sign-in without entering an API key or client
  // credentials in Settings. A clean source build leaves both values empty.
  // Anyone with the resulting extension bundle can read embedded credentials.
  const localConfigPath = path.join(rootDir, '.smith.local.json');
  const oauth = !publicBuild && fs.existsSync(localConfigPath)
    ? JSON.parse(fs.readFileSync(localConfigPath, 'utf8')).oauth ?? {}
    : {};
  const define = {
    SMITH_OAUTH_CLIENT_ID: JSON.stringify(oauth.clientId ?? ''),
    SMITH_OAUTH_CLIENT_SECRET: JSON.stringify(oauth.clientSecret ?? ''),
  };
  const bundles = [{
    entryPoints: [
      path.join(rootDir, 'src/background/service-worker.ts'),
      path.join(rootDir, 'src/popup/popup.ts'),
      path.join(rootDir, 'src/sidepanel/sidepanel.ts'),
      path.join(rootDir, 'src/trading/chart.ts'),
      path.join(rootDir, 'src/trading/worker.ts'),
      { in: path.join(rootDir, 'src/background-fx/playground-entry.tsx'), out: 'playground' },
    ],
    outdir: distDir,
    format: 'esm',
  }, {
    // Content scripts are classic scripts and may be injected more than once.
    entryPoints: [path.join(rootDir, 'src/content/content-script.ts')],
    outdir: path.join(distDir, 'content'),
    format: 'iife',
  }].map(options => ({ ...options, bundle: true, target: 'es2022', sourcemap: !publicBuild, define }));

  if (publicBuild) {
    // Refuse to package stale files from previous builds. Keep the normal dist intact.
    if (fs.existsSync(extensionDir)) {
      throw new Error('Move the previous public-build folder out of the project before building a fresh release.');
    }
    ensureDir(path.join(extensionDir, 'icons'));
    ensureDir(path.join(extensionDir, 'assets'));
    for (const file of ['manifest.json', 'rules.json', 'README.md']) {
      fs.copyFileSync(path.join(rootDir, file), path.join(extensionDir, file));
    }
    for (const file of ['icon16.png', 'icon48.png', 'icon128.png']) {
      fs.copyFileSync(path.join(rootDir, 'icons', file), path.join(extensionDir, 'icons', file));
    }
    fs.copyFileSync(path.join(rootDir, 'assets/architecture.png'), path.join(extensionDir, 'assets/architecture.png'));
  }

  copyAssets();
  if (!watch) {
    await Promise.all(bundles.map(options => esbuild.build(options)));
    console.log('[Build] Success! Output ready in ' + (publicBuild ? 'public-build/' : 'dist/'));
    return;
  }
  const contexts = [];
  const watchers = [];
  let copyTimer;
  try {
    for (const options of bundles) {
      const context = await esbuild.context({ ...options, logLevel: 'info' });
      contexts.push(context);
      await context.watch();
    }
    const refreshAssets = () => {
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        try {
          copyAssets();
          console.log('[Build] Updated static assets');
        } catch (error) {
          console.error('[Build] Could not update static assets:', error.message);
        }
      }, 80);
    };
    for (const dir of ['src/popup', 'src/sidepanel', 'src/trading', 'src/background-fx', 'icons']) {
      watchers.push(fs.watch(path.join(rootDir, dir), (_, filename) => {
        if (!filename || /\.(?:html|css|png|svg)$/i.test(filename)) refreshAssets();
      }));
    }
    watchers.push(fs.watch(rootDir, (_, filename) => { if (filename === 'rules.json') refreshAssets(); }));
  } catch (error) {
    for (const watcher of watchers) watcher.close();
    await Promise.all(contexts.map(context => context.dispose()));
    throw error;
  }
  const stop = async () => {
    clearTimeout(copyTimer);
    for (const watcher of watchers) watcher.close();
    await Promise.all(contexts.map(context => context.dispose()));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

build().catch(error => {
  console.error('[Build] Build failed:', error.message);
  process.exitCode = 1;
});
