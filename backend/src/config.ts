export interface Config {
  port: number;
  appUrl: string;
  jwtSecret: string;
  cookieSecure: boolean;
  rateLimit: boolean;
  calendarMode: 'mock' | 'google';
  google: { clientId: string; clientSecret: string; redirectUri: string };
  tokenEncryptionKey: string;
  anthropicApiKey?: string;
  anthropicModel: string;
  frontendDist?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const prod = env.NODE_ENV === 'production';
  const port = Number(env.PORT ?? 4000);
  const googleConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  if (prod && (!env.JWT_SECRET || env.JWT_SECRET.length < 32)) throw new Error('JWT_SECRET (32+ chars) is required in production');
  if (prod && googleConfigured && !env.TOKEN_ENCRYPTION_KEY) throw new Error('TOKEN_ENCRYPTION_KEY is required with Google OAuth');
  return {
    port,
    appUrl: env.APP_URL ?? `http://localhost:${port}`,
    jwtSecret: env.JWT_SECRET ?? 'dev-only-secret-change-me-dev-only-secret',
    cookieSecure: prod,
    rateLimit: env.RATE_LIMIT !== 'off',
    calendarMode: googleConfigured ? 'google' : 'mock',
    google: {
      clientId: env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
      redirectUri: env.GOOGLE_REDIRECT_URI ?? `http://localhost:${port}/api/auth/google/callback`,
    },
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY ?? '00'.repeat(32),
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    anthropicModel: env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
    frontendDist: env.FRONTEND_DIST,
  };
}
