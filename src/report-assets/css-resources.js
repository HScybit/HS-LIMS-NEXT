import { parse, walk, generate, ident } from 'css-tree';
import { tokenTypes } from 'css-tree/tokenizer';
import { HttpError } from '../auth/errors.js';

const imagePath = /^\/api\/report-assets\/images\/([a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12})$/i;
const opens = new Set([tokenTypes.Function, tokenTypes.LeftParenthesis, tokenTypes.LeftSquareBracket, tokenTypes.LeftCurlyBracket]);
const closes = new Set([tokenTypes.RightParenthesis, tokenTypes.RightSquareBracket, tokenTypes.RightCurlyBracket]);

function inspectCss(css) {
  if (typeof css !== 'string' || css.length > 1_000_000) throw new HttpError(422, 'custom_css_size_limit', 'The stylesheet exceeds the supported size.');
  let tokens = 0; let depth = 0; let parseFailed = false; const unsupported = new Set();
  const references = []; const images = new Set(); let ast;
  try {
    ast = parse(css, { positions: true, parseCustomProperty: true, onParseError: () => { parseFailed = true; }, onToken(type) {
      if (opens.has(type)) depth += 1;
      if (closes.has(type)) depth = Math.max(0, depth - 1);
      if (++tokens > 100_000 || depth > 100) throw new HttpError(422, 'custom_css_complexity_limit', 'The stylesheet exceeds 100000 tokens or 100 nesting levels.');
    } });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // Source authoring allows recoverable syntax warnings. A stylesheet that
    // cannot be inspected must not be accepted as a reproducible report asset.
    return { ast: null, imageIds: [], references, unsupported: new Set(['syntax']) };
  }
  function reference(node, value) {
    const match = value.match(imagePath);
    if (match) { const imageId = match[1].toLowerCase(); images.add(imageId); references.push({ node, imageId }); }
    else if (!/^#[a-z_][a-z\d_.:-]*$/i.test(value)) unsupported.add('external-resource');
  }
  walk(ast, (node) => {
    if (node.type === 'Raw') unsupported.add('syntax');
    if (node.type === 'Atrule') {
      const name = ident.decode(node.name).toLowerCase();
      if (['import', 'font-face', 'namespace', 'document', '-moz-document'].includes(name)) unsupported.add(name);
    }
    if (node.type === 'Declaration' && ['behavior', '-moz-binding'].includes(ident.decode(node.property).toLowerCase())) unsupported.add('executable');
    if (node.type === 'Url') reference(node, node.value);
    if (node.type === 'Function') {
      const name = ident.decode(node.name).toLowerCase();
      if (['expression', 'src', 'paint'].includes(name)) unsupported.add(name);
      if (name === 'url') {
        // Escaped function identifiers are represented as Function nodes by
        // CSSTree. Parse the original argument with the standard URL production.
        try {
          const source = css.slice(node.loc.start.offset, node.loc.end.offset);
          const value = parse(`url${source.slice(node.name.length)}`, { context: 'value', onParseError: (error) => { throw error; } }).children.first;
          if (value?.type !== 'Url') throw new Error('URL expected');
          reference(node, value.value);
        } catch { unsupported.add('syntax'); }
      }
      if (['image-set', '-webkit-image-set', 'image'].includes(name)) {
        node.children.forEach((child) => { if (child.type === 'String') reference(child, child.value); });
        // Substitution can turn a plain string into an image URL. Those dynamic
        // string resources need resolution before they can be frozen.
        walk(node, (child) => {
          if (child.type === 'Function' && ['var', 'attr', 'env'].includes(ident.decode(child.name).toLowerCase())) unsupported.add('dynamic-image');
        });
      }
    }
  });
  if (parseFailed) unsupported.add('syntax');
  if (images.size > 100) throw new HttpError(422, 'custom_css_image_limit', 'A stylesheet may reference at most 100 captured images.');
  return { ast, imageIds: [...images].sort(), references, unsupported };
}

export function customCssImageIds(css) {
  return inspectCss(css).imageIds;
}

function replaceImages(inspected, imageSources, initialBytes) {
  // Check the expansion before generating strings. Repeated references can
  // otherwise multiply a single allowed image into a very large stylesheet.
  let bytes = initialBytes;
  for (const { node, imageId } of inspected.references) {
    const source = imageSources.get(imageId);
    if (!source) throw new HttpError(409, 'report_asset_history_unavailable', 'A captured stylesheet image is unavailable.');
    bytes += Buffer.byteLength(source) + 16;
    if (bytes > 32 * 1024 * 1024) throw new HttpError(422, 'report_asset_size_limit', 'The expanded stylesheet exceeds 32 MiB.');
    if (node.type === 'Function') { node.type = 'Url'; delete node.name; delete node.children; }
    node.value = source;
  }
}

export function capturedCustomCss(css, imageSources) {
  const inspected = inspectCss(css);
  if (inspected.unsupported.size) throw new HttpError(422, 'report_css_not_captured', 'This stylesheet contains an unparsed rule or an uncaptured resource. Use captured report images; imported stylesheets and custom fonts must be captured before printing.');
  replaceImages(inspected, imageSources, Buffer.byteLength(css));
  const rendered = generate(inspected.ast);
  if (Buffer.byteLength(rendered) > 32 * 1024 * 1024) throw new HttpError(422, 'report_asset_size_limit', 'The expanded stylesheet exceeds 32 MiB.');
  return { css: rendered, imageIds: inspected.imageIds };
}

// Live organization styles retain the source's authored text and syntax-warning
// behavior. Replace only known immutable image URLs; publication is stricter.
export function currentCustomCss(css, imageSources) {
  const inspected = inspectCss(css);
  replaceImages(inspected, imageSources, Buffer.byteLength(css));
  let end = css.length; const pieces = [];
  for (const { node } of inspected.references.slice().sort((a, b) => b.node.loc.start.offset - a.node.loc.start.offset)) {
    pieces.push(css.slice(node.loc.end.offset, end), generate(node)); end = node.loc.start.offset;
  }
  pieces.push(css.slice(0, end));
  return { css: pieces.reverse().join(''), imageIds: inspected.imageIds };
}
