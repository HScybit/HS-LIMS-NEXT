export function localRedirect(path, fallback = '/me') {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(path)) return fallback;
  try {
    const target = new URL(path, 'https://sampleify.invalid');
    if (target.origin !== 'https://sampleify.invalid' || ['/login', '/reset-password'].includes(target.pathname)) return fallback;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return fallback;
  }
}
