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

export async function loadReportRenderer() {
  const rendererId = await currentRendererId();
  const directory = path.join(root, rendererId);
  const [code, stylesheet, dependencyLock] = await Promise.all([
    readFile(path.join(directory, 'renderer.mjs')), readFile(path.join(directory, 'stylesheet.css'), 'utf8'), readFile('package-lock.json'),
  ]);
  const actualId = createHash('sha256').update(code).update(stylesheet).update(dependencyLock).digest('hex');
  if (actualId !== rendererId) throw new Error('The report renderer does not match this release. Build and restart the worker.');
  const renderer = await import(pathToFileURL(path.join(directory, 'renderer.mjs')).href);
  return { rendererId, stylesheet, renderReportDocument: renderer.renderReportDocument, renderReportPdf: renderer.renderReportPdf };
}
