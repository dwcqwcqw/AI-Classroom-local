import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const sourceRoot = path.join(root, 'node_modules', 'katex', 'dist');
const targetRoot = path.join(root, 'public', 'vendor', 'katex');

await mkdir(targetRoot, { recursive: true });

const assets = [
  ['katex.min.js', 'katex.min.js'],
  ['contrib/auto-render.min.js', 'auto-render.min.js'],
  ['katex.min.css', 'katex.min.css'],
];

for (const [sourceName, targetName] of assets) {
  let contents = await readFile(path.join(sourceRoot, sourceName), 'utf8');
  if (targetName.endsWith('.css')) {
    // Reuse the already shipped WOFF2 font set instead of copying a second
    // KaTeX font directory into every deployment.
    contents = contents.replaceAll('url(fonts/', 'url(../video-export/fonts/');
  }
  await writeFile(path.join(targetRoot, targetName), contents);
}

console.log('[sync-katex-runtime] synced browser assets');
