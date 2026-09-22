import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HttpError } from '../auth/errors.js';

const root = path.resolve('.local/report-renderers');

export async function currentRendererId() {
  try {
    const manifest = JSON.parse(await readFile(path.join(root, 'current.json'), 'utf8'));
    if (!/^[a-f0-9]{64}$/.test(manifest.rendererId)) throw new Error('Invalid renderer manifest.');
    return manifest.rendererId;
  } catch {
    throw new HttpError(503, 'report_renderer_unavailable', 'Report printing is temporarily unavailable.');
  }
}

async function rendererFiles(rendererId) {
  if (!/^[a-f0-9]{64}$/.test(rendererId)) throw new HttpError(404, 'report_renderer_unavailable', 'The report stylesheet is unavailable.');
  const directory = path.join(root, rendererId);
  const [code, stylesheet, dependencyLock] = await Promise.all([
    readFile(path.join(directory, 'renderer.mjs')), readFile(path.join(directory, 'stylesheet.css'), 'utf8'), readFile('package-lock.json'),
  ]);
  const actualId = createHash('sha256').update(code).update(stylesheet).update(dependencyLock).digest('hex');
  if (actualId !== rendererId) throw new Error('The report renderer does not match this release. Build and restart the worker.');
  return { directory, stylesheet };
}

export async function loadReportStylesheet(rendererId) {
  try { return (await rendererFiles(rendererId)).stylesheet; }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'report_renderer_unavailable', 'The report stylesheet is temporarily unavailable.');
  }
}

export async function loadReportRenderer() {
  const rendererId = await currentRendererId(); const { directory, stylesheet } = await rendererFiles(rendererId);
  // The renderer is a built artifact outside the application bundle; the web server loads it at runtime like the worker script does.
  const renderer = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(path.join(directory, 'renderer.mjs')).href);
  return { rendererId, stylesheet, renderReportDocument: renderer.renderReportDocument, renderReportPdf: renderer.renderReportPdf };
}
