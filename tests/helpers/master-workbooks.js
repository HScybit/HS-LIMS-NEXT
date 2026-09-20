import ExcelJS from 'exceljs';
import { crc32, deflateRawSync } from 'node:zlib';

export async function masterWorkbook(rows, configure) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('First'); sheet.addRows(rows);
  configure?.(workbook, sheet);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// Minimal synthetic ZIP fixtures allow deliberate CRC/size/flag corruption without another dependency.
export function workbookArchive(entries) {
  const localParts = []; const directoryParts = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name); const data = Buffer.from(entry.data ?? 'x');
    const method = entry.method ?? 8; const compressed = method === 0 ? data : deflateRawSync(data);
    const checksum = entry.crc ?? crc32(data); const size = entry.declaredSize ?? data.length; const flags = entry.flags ?? 0x800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    directoryParts.push(central, name); offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(directoryParts); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end]);
}

export const workbookParts = () => ['[Content_Types].xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels'].map(name => ({ name, data: '<invalid-for-decoding/>' }));
