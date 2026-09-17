import { parentPort, workerData } from 'node:worker_threads';
import ExcelJS from 'exceljs';

try {
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Master data');
  sheet.addRow(workerData.headers);
  sheet.getRow(1).font = { bold: true };
  for (const row of workerData.rows) {
    // Plain string values stay strings even when they begin with =, +, - or @.
    // Never recreate executable formulas or hyperlinks from uploaded provenance.
    const inserted = sheet.addRow(row);
    inserted.eachCell(cell => { if (cell.value instanceof Date) cell.numFmt = 'yyyy-mm-dd hh:mm:ss'; });
  }
  sheet.columns.forEach(column => { column.width = 24; });
  const output = new Uint8Array(await workbook.xlsx.writeBuffer());
  if (output.byteLength > 16 * 1_048_576) throw new Error('Workbook limit');
  parentPort.postMessage({ type: 'result', bytes: output.buffer }, [output.buffer]);
} catch {
  parentPort.postMessage({ type: 'error' });
}
