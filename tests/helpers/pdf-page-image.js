import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execute = promisify(execFile);

// Inspect actual PDF pixels through the native PDFKit available to these tests.
export async function pdfPageImage(file, pageIndex = 0) {
  const directory = await mkdtemp(path.join(tmpdir(), 'sampleify-pdf-image-'));
  const destination = path.join(directory, 'page.png');
  const script = `ObjC.import('AppKit'); ObjC.import('PDFKit');
    function run(argv) {
      const document = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
      const page = document.pageAtIndex(Number(argv[2]));
      const image = page.thumbnailOfSizeForBox($.NSMakeSize(1000,1400),0);
      const bitmap = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
      const data = bitmap.representationUsingTypeProperties(4,$.NSDictionary.dictionary);
      return String(data.writeToFileAtomically(argv[1],true));
    }`;
  try {
    const child = execute('osascript', ['-l', 'JavaScript', '-', path.resolve(file), destination, String(pageIndex)], { timeout: 15_000 });
    child.child.stdin.end(script); await child;
    return await readFile(destination);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
