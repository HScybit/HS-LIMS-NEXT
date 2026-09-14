export const userSignatureByteLimit = 20 * 1024 * 1024;
export const signatureCanPreview = (mediaType) => typeof mediaType === 'string' && (mediaType.startsWith('image/') || mediaType === 'application/pdf');
