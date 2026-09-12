import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { HttpError } from '../auth/errors.js';
import { pngFrames } from './png.js';
import { gifFrameCount, webpFrameCount } from './raster-container.js';

export const templateImageByteLimit = 10 * 1024 * 1024;
export const templateImagePixelLimit = 40_000_000;
export const templateImageFrameLimit = 200;
const mediaTypes = new Map([['png', 'image/png'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'], ['webp', 'image/webp']]);
const hash = (content) => createHash('sha256').update(content).digest('hex');
const decodeOptions = { failOn: 'warning', limitInputPixels: templateImagePixelLimit };

export async function validateTemplateImage(content, declaredType) {
  if (!Buffer.isBuffer(content) || !content.length) throw new HttpError(422, 'empty_template_image', 'Select a non-empty image.');
  if (content.length > templateImageByteLimit) throw new HttpError(413, 'template_image_size_limit', 'Template images can be at most 10 MiB.');
  const mediaType = declaredType === 'image/jpg' ? 'image/jpeg' : declaredType;
  if (![...mediaTypes.values()].includes(mediaType)) throw new HttpError(415, 'template_image_type', 'Only JPEG, PNG, GIF and WebP image files are allowed.');
  const decoder = sharp(content, { ...decodeOptions, animated: true });
  try {
    const metadata = await decoder.metadata();
    if (mediaTypes.get(metadata.format) !== mediaType) throw new HttpError(415, 'template_image_type', 'The image content does not match its declared type.');
    const animation = mediaType === 'image/png' ? pngFrames(content, { frameLimit: templateImageFrameLimit, pixelLimit: templateImagePixelLimit }) : null;
    const frameCount = animation?.frames.length ?? metadata.pages ?? 1;
    if (mediaType === 'image/gif' && gifFrameCount(content) !== frameCount || mediaType === 'image/webp' && webpFrameCount(content) !== frameCount) throw new Error('Image frame count does not match.');
    const height = metadata.pageHeight ?? metadata.height;
    if (!metadata.width || !height || metadata.width > 10000 || height > 10000 || frameCount > templateImageFrameLimit || metadata.width * height * frameCount > templateImagePixelLimit) {
      throw new HttpError(422, 'template_image_dimensions', 'Images must fit within 10,000 pixels per side, 200 frames and 40 megapixels across all frames.');
    }
    // Fully decode every GIF/WebP frame, or the PNG fallback. Metadata alone is insufficient.
    await decoder.stats();
    let printContent;
    if (animation) {
      for (const [index, value] of animation.frames.entries()) {
        const image = sharp(value.content, decodeOptions);
        try {
          if (index === 0) {
            // Each play starts with a transparent canvas, even with a separate fallback.
            const canvas = image.ensureAlpha().extend({ left: value.x, top: value.y,
              right: animation.width - value.width - value.x, bottom: animation.height - value.height - value.y,
              background: { r: 0, g: 0, b: 0, alpha: 0 } });
            if (metadata.orientation > 1) canvas.withMetadata({ orientation: metadata.orientation });
            printContent = await canvas.png().toBuffer();
            if (metadata.orientation > 1) {
              // Rotate the assembled canvas, including offsets, rather than the subframe.
              const oriented = sharp(printContent, decodeOptions);
              try { printContent = await oriented.autoOrient().png().toBuffer(); } finally { oriented.destroy(); }
            }
          } else await image.stats();
        } finally { image.destroy(); }
      }
    } else {
      const first = sharp(content, decodeOptions);
      try { printContent = await first.autoOrient().png().toBuffer(); } finally { first.destroy(); }
    }
    if (printContent.length > templateImageByteLimit) throw new HttpError(413, 'template_image_print_size_limit', 'The decoded print image exceeds 10 MiB. Use a smaller image.');
    const rotated = metadata.orientation >= 5;
    return { mediaType, width: rotated ? height : metadata.width, height: rotated ? metadata.width : height, frameCount,
      byteLength: content.length, sha256: hash(content), printContent, printByteLength: printContent.length, printSha256: hash(printContent) };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, 'invalid_template_image', 'The image could not be decoded. Select a valid JPEG, PNG, GIF or WebP file.');
  } finally { decoder.destroy(); }
}
