// All Redis consumers use the same HTTPS REST root, including when copied from
// a dashboard with surrounding whitespace or a trailing slash.
export function redisRestUrl(raw) {
  const value = raw?.trim();
  if (!value || /[?#]/.test(value) || !URL.canParse(value)) return;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || !/^\/+$/u.test(url.pathname)) return;
  url.pathname = '/';
  return url;
}
