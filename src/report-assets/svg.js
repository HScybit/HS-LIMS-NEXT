import { DOMParser } from '@xmldom/xmldom';
import postcss from 'postcss';
import { HttpError } from '../auth/errors.js';

const svgNamespace = 'http://www.w3.org/2000/svg';
const tags = new Set(['svg', 'g', 'defs', 'symbol', 'use', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath', 'title', 'desc', 'style', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern', 'marker']);
const properties = new Set(['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'color', 'display', 'visibility', 'clip-path', 'clip-rule', 'mask',
  'marker-start', 'marker-mid', 'marker-end', 'vector-effect', 'paint-order', 'shape-rendering', 'text-rendering', 'color-interpolation',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'text-anchor', 'dominant-baseline', 'alignment-baseline',
  'baseline-shift', 'writing-mode', 'letter-spacing', 'word-spacing', 'text-decoration', 'stop-color', 'stop-opacity']);
const attributes = new Set(['id', 'class', 'style', 'version', 'baseProfile', 'viewBox', 'preserveAspectRatio', 'width', 'height', 'x', 'y',
  'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'transform', 'pathLength', 'dx', 'dy', 'rotate', 'textLength',
  'lengthAdjust', 'href', 'offset', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'fx', 'fy', 'fr', 'clipPathUnits', 'maskUnits',
  'maskContentUnits', 'patternUnits', 'patternContentUnits', 'patternTransform', 'markerUnits', 'markerWidth', 'markerHeight', 'refX', 'refY',
  'orient', 'startOffset', 'method', 'spacing', 'type', 'role', 'aria-label', 'aria-labelledby', 'aria-hidden', ...properties]);
const referencePattern = /^#([A-Za-z_][A-Za-z0-9_.:-]{0,199})$/;
const maxNodes = 20_000;

function unsupported() { throw new HttpError(422, 'unsafe_report_svg', 'Use a static SVG with local vector shapes, styles and references. Scripts, external resources and animation are not supported.'); }
function limit() { throw new HttpError(422, 'report_svg_limit', 'The SVG exceeds the supported layout or reference size.'); }

function localReference(value, references) {
  const match = referencePattern.exec(value.trim());
  if (!match) unsupported();
  references.add(match[1]);
}

function styleValue(value, references) {
  // Escaped identifiers and comment-separated tokens are intentionally outside
  // this static SVG profile, including encoded resource-loading constructs.
  if (/\\|\/\*|\*\/|[\u0000-\u0008\u000b\u000c\u000e-\u001f]|@|expression\s*\(|var\s*\(/i.test(value)) unsupported();
  const remaining = value.replace(/url\(\s*(['"]?)(#[A-Za-z_][A-Za-z0-9_.:-]{0,199})\1\s*\)/gi, (_match, _quote, reference) => {
    localReference(reference, references); return '';
  });
  if (/url\s*\(|(?:https?|file|data|javascript):/i.test(remaining)) unsupported();
}

function stylesheet(value, references, inline = false) {
  styleValue(value, references);
  let root;
  try { root = postcss.parse(inline ? `svg{${value}}` : value, { from: undefined }); }
  catch { unsupported(); }
  if (inline && (root.nodes.length !== 1 || root.first.type !== 'rule' || root.first.selector !== 'svg')) unsupported();
  let nodes = 0;
  root.walk((node) => {
    if (++nodes > maxNodes) limit();
    if (node.type === 'comment') return;
    if (node.type === 'rule') {
      if (node.parent !== root) unsupported();
      return;
    }
    if (node.type !== 'decl' || node.parent.type !== 'rule' || !properties.has(node.prop.toLowerCase())) unsupported();
    styleValue(node.value, references);
  });
}

// Return no rewritten markup: the immutable original bytes are authoritative.
// Every consumer validates them before constructing an SVG image response.
export function validateReportSvg(content) {
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(content); }
  catch { unsupported(); }
  if (!source || content.length > 10 * 1024 * 1024 || /<!DOCTYPE/i.test(source)) unsupported();
  let openings = 0;
  for (const character of source) if (character === '<' && ++openings > maxNodes * 2 + 1) limit();
  let document;
  try { document = new DOMParser({ onError: () => { throw new Error('Invalid XML'); } }).parseFromString(source, 'image/svg+xml'); }
  catch { unsupported(); }
  if (document.doctype || document.documentElement?.localName !== 'svg' || document.documentElement.namespaceURI !== svgNamespace) unsupported();
  const records = new Map(); const identities = new Map(); let nodes = 0;
  const pending = [{ node: document, depth: 0 }];
  while (pending.length) {
    const { node, depth } = pending.pop();
    if (++nodes > maxNodes || depth > 100) limit();
    if (node.nodeType === 7) {
      if (node.parentNode !== document || node.target !== 'xml' || !/^\s*<\?xml\s/.test(source)
        || /encoding\s*=\s*['"](?!utf-8['"])/i.test(node.data)) unsupported();
    } else if (![1, 3, 4, 8, 9].includes(node.nodeType)) unsupported();
    if (node.nodeType === 1) {
      if (node.namespaceURI !== svgNamespace || !tags.has(node.localName)) unsupported();
      const record = { children: [], references: new Set() }; records.set(node, record);
      for (let index = 0; index < node.attributes.length; index += 1) {
        const attribute = node.attributes.item(index);
        if (attribute.namespaceURI === 'http://www.w3.org/2000/xmlns/') continue;
        if (attribute.namespaceURI === 'http://www.w3.org/XML/1998/namespace' && ['space', 'lang'].includes(attribute.localName)) continue;
        if (attribute.namespaceURI && !(attribute.namespaceURI === 'http://www.w3.org/1999/xlink' && attribute.localName === 'href')) unsupported();
        if (!attributes.has(attribute.localName)) unsupported();
        if (attribute.localName === 'id') {
          if (!referencePattern.test(`#${attribute.value}`) || identities.has(attribute.value)) unsupported();
          identities.set(attribute.value, node);
        } else if (attribute.localName === 'href') localReference(attribute.value, record.references);
        else if (attribute.localName === 'style') stylesheet(attribute.value, record.references, true);
        else if (!['class', 'role', 'aria-label', 'aria-labelledby', 'aria-hidden'].includes(attribute.localName)) styleValue(attribute.value, record.references);
      }
      if (node.localName === 'style') stylesheet(node.textContent, record.references);
    }
    for (let child = node.lastChild; child; child = child.previousSibling) {
      if (child.nodeType === 1 && records.has(node)) records.get(node).children.push(child);
      pending.push({ node: child, depth: depth + 1 });
    }
  }
  for (const record of records.values()) for (const reference of record.references) {
    const target = identities.get(reference); if (!target) unsupported(); record.children.push(target);
  }
  const visiting = new Set(); const sizes = new Map();
  function expandedSize(node, depth = 0) {
    if (depth > 100 || visiting.has(node)) limit();
    if (sizes.has(node)) return sizes.get(node);
    visiting.add(node); let size = 1;
    for (const child of records.get(node).children) {
      size += expandedSize(child, depth + 1); if (size > maxNodes) limit();
    }
    visiting.delete(node); sizes.set(node, size); return size;
  }
  expandedSize(document.documentElement);
}
