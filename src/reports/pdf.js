import { chromium } from 'playwright-core';
import { HttpError } from '../auth/errors.js';
import { printSettingsInput, defaultPrintSettings } from './input.js';

// Source pdfLayout.buildTemplateViewport measures at the printable paper width.
// Keep its CSS-pixel dimensions so responsive sections wrap before measurement.
const paperSizes = { A3: [1123, 1587], A4: [794, 1123], A5: [559, 794], Letter: [816, 1056], Legal: [816, 1344] };
function normalizedSettings(config) {
  return printSettingsInput(Object.fromEntries(Object.entries(config).filter(([key]) => Object.hasOwn(defaultPrintSettings, key))));
}

export function pdfViewport(config) {
  const settings = normalizedSettings(config);
  const dimensions = paperSizes[settings.pageSize];
  const [width, height] = settings.isLandscape ? [dimensions[1], dimensions[0]] : dimensions;
  return { width: Math.round(Math.max(width - 2 * Number(settings.xMargin), 320)), height: Math.max(height, 600) };
}

function pageChromeTemplate(html, stylesheet, xMargin) {
  if (!html) return '<div></div>';
  return `<style>${stylesheet}\nhtml{font-size:16px!important}body{margin:0!important;font-size:11px!important}#header,#footer{padding:0!important}</style><div style="box-sizing:border-box;width:100%;padding-left:${xMargin}px;padding-right:${xMargin}px;background:#fff;color:#1c2126;font-family:Inter,Arial,sans-serif;font-size:11px;line-height:1.35">${html}</div>`;
}

// Source PDF margins are CSS pixels, including measured page header/footer.
export function pdfOptions(config, chrome = {}, stylesheet = '') {
  const settings = normalizedSettings(config);
  const header = settings.printHeader ? chrome.header : null;
  const footer = settings.printFooter ? chrome.footer : null;
  return { format: settings.pageSize, landscape: settings.isLandscape, printBackground: true, preferCSSPageSize: false, scale: Number(settings.scale),
    margin: { top: `${(header?.height ?? 0) + (settings.useCustomTopMargin ? Number(settings.topMargin) : 0)}px`,
      right: `${settings.xMargin}px`, bottom: `${(footer?.height ?? 0) + (settings.useCustomBottomMargin ? Number(settings.bottomMargin) : 0)}px`, left: `${settings.xMargin}px` },
    ...(header?.html || footer?.html ? { displayHeaderFooter: true,
      headerTemplate: pageChromeTemplate(header?.html, stylesheet, settings.xMargin), footerTemplate: pageChromeTemplate(footer?.html, stylesheet, settings.xMargin) } : {}),
  };
}

export async function renderReportPdf({ html, printConfig, stylesheet }, { browser, timeoutMs = 30_000 } = {}) {
  const viewport = pdfViewport(printConfig);
  const launched = browser ?? await chromium.launch({ channel: 'chrome', headless: true, timeout: timeoutMs });
  let context; let timer; let timedOut = false;
  try {
    context = await launched.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', viewport, deviceScaleFactor: 1 });
    let blockedRequests = 0;
    await context.route('**/*', (route) => { blockedRequests += 1; return route.abort(); });
    const page = await context.newPage();
    timer = setTimeout(() => { timedOut = true; void context.close().catch(() => {}); }, timeoutMs);
    await page.setContent(html, { waitUntil: 'load', timeout: timeoutMs });
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(async () => { await document.fonts.ready; });
    if (blockedRequests) throw new HttpError(422, 'report_external_resource', 'The report contains a resource that has not been captured for printing.');
    const decodedImages = await page.evaluate(async () => {
      const decoded = await Promise.all([...document.images].map((image) => image.decode().then(() => true, () => false)));
      return decoded.every(Boolean);
    });
    if (!decodedImages) throw new HttpError(409, 'report_image_unavailable', 'A captured report image could not be decoded for printing.');
    const chrome = await page.evaluate(() => {
      function extract(attribute) {
        const elements = [...document.querySelectorAll(`[data-coa-report-body] > [${attribute}="true"], [data-coa-report-body] > .template-render-canvas > [${attribute}="true"]`)];
        const html = elements.map((element) => element.outerHTML).join('');
        const height = elements.reduce((sum, element) => sum + Math.ceil(element.getBoundingClientRect().height), 0);
        elements.forEach((element) => element.remove());
        return { html, height };
      }
      return { header: extract('data-is-header'), footer: extract('data-is-footer') };
    });
    if (blockedRequests) throw new HttpError(422, 'report_external_resource', 'The report contains a resource that has not been captured for printing.');
    const bytes = await page.pdf(pdfOptions(printConfig, chrome, stylesheet));
    if (bytes.length > 50 * 1024 * 1024) throw new HttpError(422, 'report_pdf_size_limit', 'The generated PDF exceeds the supported file size.');
    return bytes;
  } catch (error) {
    if (timedOut) throw new HttpError(504, 'report_pdf_timeout', 'The report did not finish rendering in time.');
    throw error;
  } finally {
    clearTimeout(timer);
    await context?.close().catch(() => {});
    if (!browser) await launched.close().catch(() => {});
  }
}
