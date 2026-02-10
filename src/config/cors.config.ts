import { env } from './env.config';

/**
 * Normalize an origin by stripping trailing slashes.
 */
function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, '');
}

/**
 * Build the production origin allowlist from FRONTEND_URL and FRONTEND_URLS.
 */
function buildAllowlist(): string[] {
  const origins: string[] = [];

  if (env.FRONTEND_URL) {
    origins.push(normalizeOrigin(env.FRONTEND_URL));
  }

  if ((env as any).FRONTEND_URLS) {
    const extra = ((env as any).FRONTEND_URLS as string)
      .split(',')
      .map((s) => normalizeOrigin(s.trim()))
      .filter(Boolean);
    origins.push(...extra);
  }

  return origins;
}

const allowlist = buildAllowlist();

/**
 * Check if a production origin is in the allowlist.
 */
export function isAllowedOrigin(origin: string): boolean {
  return allowlist.includes(normalizeOrigin(origin));
}

/**
 * Check if an origin matches common development patterns.
 */
export function isAllowedDevOrigin(origin: string): boolean {
  return (
    origin.startsWith('http://localhost:') ||
    origin.startsWith('http://127.0.0.1:') ||
    origin.startsWith('https://localhost:') ||
    origin.startsWith('http://192.168.') ||
    origin.startsWith('http://10.0.2.2:') ||
    /^http:\/\/172\.(1[6-9]|2[0-9]|3[0-1])\./.test(origin)
  );
}
