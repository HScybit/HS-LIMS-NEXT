import sanitizeHtml from 'sanitize-html';
import { HttpError } from '../auth/errors.js';
import { uuid } from '../templates/input.js';

const tags = ['p', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'mark', 'small', 'a', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'figure', 'figcaption', 'img',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'colgroup', 'col'];
const tagSet = new Set(tags);
const size = '(?:0|[0-9]+(?:\\.[0-9]+)?(?:px|pt|pc|in|cm|mm|em|rem|%))';
const dimension = new RegExp(`^(?:${size}|auto|none|min-content|max-content|fit-content)$`, 'i');
const spacing = new RegExp(`^(?:${size}|auto)(?:\\s+(?:${size}|auto)){0,3}$`, 'i');
const color = /^(?:#[0-9a-f]{3,8}|[a-z]+|(?:rgb|hsl)a?\([0-9.,%+\-/\s]+\))$/i;
const border = new RegExp(`^(?:(?:${size}|thin|medium|thick|none|solid|dotted|dashed|double|groove|ridge|inset|outset|#[0-9a-f]{3,8}|[a-z]+|(?:rgb|hsl)a?\\([0-9.,%+\\-/\\s]+\\))(?:\\s+|$)){1,3}$`, 'i');
const styles = {
  color: [color], 'background-color': [color], 'font-family': [/^[a-z0-9 ,"'_-]{1,200}$/i],
  'font-size': [dimension], 'font-weight': [/^(?:normal|bold|bolder|lighter|[1-9]00)$/], 'font-style': [/^(?:normal|italic|oblique)$/],
  'line-height': [dimension, /^(?:normal|[0-9]+(?:\.[0-9]+)?)$/],
  'text-align': [/^(?:left|right|center|justify|start|end)$/], 'vertical-align': [/^(?:top|middle|bottom|baseline|sub|super)$/],
  'text-decoration': [/^(?:none|underline|line-through|overline)(?:\s+(?:underline|line-through|overline))*$/],
  'text-transform': [/^(?:none|capitalize|uppercase|lowercase)$/], 'white-space': [/^(?:normal|nowrap|pre|pre-wrap|pre-line|break-spaces)$/],
  'word-break': [/^(?:normal|break-all|keep-all|break-word)$/], 'overflow-wrap': [/^(?:normal|anywhere|break-word)$/],
  'border-collapse': [/^(?:collapse|separate)$/], 'border-spacing': [spacing], 'table-layout': [/^(?:auto|fixed)$/],
  float: [/^(?:left|right|none)$/], clear: [/^(?:left|right|both|none)$/],
  display: [/^(?:block|inline|inline-block|table|table-row|table-cell|none)$/],
  'list-style-type': [/^[a-z-]{1,40}$/], 'list-style-position': [/^(?:inside|outside)$/],
};
for (const key of ['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height']) styles[key] = [dimension];
for (const key of ['margin', 'padding']) {
  styles[key] = [spacing];
  for (const side of ['top', 'right', 'bottom', 'left']) styles[`${key}-${side}`] = [dimension];
}
for (const key of ['border', 'border-top', 'border-right', 'border-bottom', 'border-left']) {
  styles[key] = [border]; styles[`${key}-color`] = [color]; styles[`${key}-width`] = [spacing];
  styles[`${key}-style`] = [/^(?:none|solid|dotted|dashed|double|groove|ridge|inset|outset)$/];
}

function unsupported() { throw new HttpError(422, 'unsafe_report_html', 'The content contains unsupported or executable markup.'); }
function imageId(source) {
  const match = /^\/api\/report-assets\/images\/([0-9a-f-]{36})$/i.exec(source ?? '');
  if (!match) throw new HttpError(422, 'report_image_not_captured', 'Upload report images before adding them to the content.');
  return uuid(match[1], 'Report image').toLowerCase();
}

// HTML here is authored rich content, never serialized designer/configuration
// state. Resolve immutable image IDs separately and pin them with the version.
export function reportContentHtml(input, { imageSources } = {}) {
  if (typeof input !== 'string' || input.length > 1_000_000) throw new HttpError(400, 'invalid_report_html', 'Report content must contain at most 1,000,000 characters.');
  const images = new Set(); let depth = 0; let nodes = 0; let resolvedBytes = new TextEncoder().encode(input).byteLength;
  const html = sanitizeHtml(input, {
    allowedTags: tags,
    allowedAttributes: { '*': ['class', 'style', 'title', 'dir', 'lang'], a: ['href', 'target', 'rel'], img: ['src', 'alt', 'width', 'height'],
      td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan', 'scope'], col: ['span', 'width'], colgroup: ['span'], ol: ['start', 'reversed', 'type'], li: ['value'] },
    allowedClasses: { '*': [/^[a-z0-9_-]{1,100}$/i] }, allowedStyles: { '*': styles },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'], allowedSchemesByTag: { img: imageSources ? ['data'] : [] }, allowProtocolRelative: false,
    onOpenTag(name, attributes) {
      nodes += 1; depth += 1;
      if (nodes > 20_000 || depth > 100) throw new HttpError(422, 'report_content_limit', 'The report content exceeds the supported layout size.');
      if (!tagSet.has(name)) unsupported();
      for (const key of Object.keys(attributes)) if (/^on|:|^(?:srcdoc|formaction|is|srcset)$/i.test(key)) unsupported();
      if (attributes.style && /\\|\/\*|url\s*\(|expression\s*\(|@|behavior\s*:|-moz-binding/i.test(attributes.style)) unsupported();
      if (name === 'a' && attributes.href && !/^(?:https?:\/\/|mailto:|tel:|#|\/(?!\/))/i.test(attributes.href.trim())) unsupported();
      if (name === 'img') {
        const id = imageId(attributes.src); images.add(id);
        resolvedBytes += imageSources?.get(id)?.length ?? 0;
        if (resolvedBytes > 32 * 1024 * 1024) throw new HttpError(422, 'report_asset_size_limit', 'The expanded report images exceed the supported document size.');
      }
      for (const key of ['rowspan', 'colspan', 'span']) if (attributes[key] && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(attributes[key])) unsupported();
    },
    onCloseTag() { depth -= 1; },
    transformTags: {
      a: (tagName, attributes) => ({ tagName, attribs: { ...attributes, target: attributes.target === '_blank' ? '_blank' : '_self', rel: 'noopener noreferrer' } }),
      img: (tagName, attributes) => {
        const id = imageId(attributes.src);
        const source = imageSources?.get(id);
        if (imageSources && !/^data:image\/(?:png|jpeg|webp|gif|avif|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/.test(source ?? '')) {
          throw new HttpError(409, 'report_image_unavailable', 'A captured report image is unavailable.');
        }
        return { tagName, attribs: { ...attributes, src: source ?? `/api/report-assets/images/${id}` } };
      },
    },
  });
  return { html, imageIds: [...images] };
}
