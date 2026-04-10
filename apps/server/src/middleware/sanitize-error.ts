/**
 * Sanitize error messages for production — strip filesystem paths and stack traces.
 */

const isDev = process.env.NODE_ENV !== 'production';

const SENSITIVE_PATTERNS = [
  /\/[^\s:]+\.(ts|js|mjs|cjs)/g,   // File paths
  /at\s+\S+\s+\(/g,                 // Stack frames
  /node_modules/g,                   // Module paths
  /ENOENT|EACCES|EPERM/g,           // OS error codes
];

export function sanitizeError(error: unknown, fallback = 'Internal error'): string {
  if (isDev) {
    return error instanceof Error ? error.message : String(error);
  }

  const raw = error instanceof Error ? error.message : String(error);

  // If the message contains sensitive filesystem info, replace with fallback
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(raw)) return fallback;
    pattern.lastIndex = 0; // Reset regex state
  }

  return raw;
}
