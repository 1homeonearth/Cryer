export function resolveCallbackHost(bind) {
  const raw = (bind || '').trim();
  if (!raw || raw === '0.0.0.0' || raw === '::' || raw === '::0') {
    return '127.0.0.1';
  }
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw;
  }
  if (raw.includes(':') && !raw.includes('.')) {
    return `[${raw}]`;
  }
  return raw;
}
