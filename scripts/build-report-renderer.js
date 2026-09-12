import { build } from 'esbuild';
import { compile } from 'sass';
import { createHash } from 'node:crypto';
import { readFile, mkdir, mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.local/report-renderers');
const bundled = await build({ entryPoints: ['src/reports/renderer-entry.js'], bundle: true, platform: 'node', format: 'esm', target: 'node22',
  packages: 'external', write: false, jsx: 'automatic', legalComments: 'none',
  plugins: [{ name: 'separate-report-styles', setup(builder) {
    builder.onLoad({ filter: /\.(scss|css)$/ }, () => ({ contents: '', loader: 'js' }));
    builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'next/link.js', external: true }));
  } }],
});
const sources = ['src/styles/design-system.scss', 'src/styles/custom.scss', 'src/styles/form-controls.scss', 'src/styles/checkbox.scss', 'src/styles/template-designer.scss'];
const styles = [await readFile('node_modules/bootstrap/dist/css/bootstrap.min.css', 'utf8')];
for (const source of sources) styles.push(compile(source, { style: 'compressed', quietDeps: true }).css);
for (const weight of [400, 500, 600]) {
  const font = await readFile(`node_modules/@fontsource/inter/files/inter-latin-${weight}-normal.woff2`);
  styles.push(`@font-face{font-family:Inter;font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${font.toString('base64')}) format('woff2')}`);
}
styles.push('html{font-size:16px}body{margin:0;font-family:Inter,Arial,sans-serif;color:#111827;background:white;-webkit-print-color-adjust:exact;print-color-adjust:exact}.coa-print-body--without-signature .state_transition_widget_img_container{display:none!important}.coa-print-body--without-image img:not(.state_transition_widget_img){display:none!important}');
const stylesheet = styles.join('\n');
const code = bundled.outputFiles[0].contents;
const dependencyLock = await readFile('package-lock.json');
const rendererId = createHash('sha256').update(code).update(stylesheet).update(dependencyLock).digest('hex');
const directory = path.join(root, rendererId);
await mkdir(root, { recursive: true, mode: 0o700 });
const staging = await mkdtemp(path.join(root, '.build-'));
try {
  await writeFile(path.join(staging, 'renderer.mjs'), code, { mode: 0o600 });
  await writeFile(path.join(staging, 'stylesheet.css'), stylesheet, { mode: 0o600 });
  try { await rename(staging, directory); }
  catch (error) {
    if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
    const existingCode = await readFile(path.join(directory, 'renderer.mjs'));
    const existingStyles = await readFile(path.join(directory, 'stylesheet.css'), 'utf8');
    if (!existingCode.equals(Buffer.from(code)) || existingStyles !== stylesheet) throw new Error('An existing report renderer failed its integrity check.');
  }
} finally { await rm(staging, { recursive: true, force: true }); }
const manifest = path.join(root, 'current.json');
const temporaryManifest = `${manifest}.${process.pid}.tmp`;
await writeFile(temporaryManifest, JSON.stringify({ rendererId }) + '\n', { mode: 0o600 });
await rename(temporaryManifest, manifest);
console.log(`Built report renderer ${rendererId}.`);
