import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// The macOS verification environment provides PDFKit. Inspect the actual PDF
// text geometry, including Chrome's separately rendered repeating page areas.
export async function pdfPageText(file, labels) {
  const script = `ObjC.import('Foundation'); ObjC.import('PDFKit');
    function run(argv) {
      const document = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
      const labels = JSON.parse(argv[1]);
      const pages = [];
      for (let index = 0; index < Number(document.pageCount); index++) {
        const page = document.pageAtIndex(index);
        const content = ObjC.unwrap(page.string);
        const rows = [];
        for (const label of labels) {
          let start = content.indexOf(label);
          while (start >= 0) {
            const box = page.selectionForRange($.NSMakeRange(start, label.length)).boundsForPage(page);
            rows.push({ label, bottom: box.origin.y, top: box.origin.y + box.size.height });
            start = content.indexOf(label, start + label.length);
          }
        }
        pages.push(rows);
      }
      return JSON.stringify(pages);
    }`;
  // Pass paths/data as arguments; neither is interpolated into shell code.
  const child = execute('osascript', ['-l', 'JavaScript', '-', file, JSON.stringify(labels)], { timeout: 15_000 });
  child.child.stdin.end(script);
  const { stdout } = await child;
  return JSON.parse(stdout);
}
