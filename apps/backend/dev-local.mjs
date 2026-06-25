/**
 * dev-local.mjs — zero-config LOCAL dev boot for the backend.
 *
 * Sets the dedicated dev-compose Postgres credentials (docker-compose.dev.yml)
 * + dummy WhatsApp secrets, then boots the server — so you can run the dev
 * console WITHOUT creating a .env file. Cross-shell (PowerShell / bash / zsh).
 *
 * Real environment variables and a .env still take precedence: `??=` only fills
 * values that are NOT already set. Dev-only throwaway credentials — never prod.
 *
 *   pnpm --filter @sivihub/whatsapp-hub-backend dev:local
 *
 * Requires the dev DB running:
 *   docker compose -f docker-compose.dev.yml up -d --wait
 */
const DEV_ENV = {
  DATABASE_URL: 'postgresql://app_rls:devpassword@localhost:5434/sivi_whatsapp_hub',
  DATABASE_ADMIN_URL: 'postgresql://postgres:devpassword@localhost:5434/sivi_whatsapp_hub',
  DATABASE_WEBHOOK_URL: 'postgresql://app_webhook:devpassword@localhost:5434/sivi_whatsapp_hub',
  AUTH_MODE: 'dev-header',
  PORT: '3002',
  LOG_LEVEL: 'info',
  WHATSAPP_VERIFY_TOKEN: 'local-dev-verify-token',
  WHATSAPP_APP_SECRET: 'local-dev-app-secret',
  APP_RLS_PASSWORD: 'devpassword',
  APP_WEBHOOK_PASSWORD: 'devpassword',
  ENABLE_DEV_ENDPOINTS: 'true',
};

for (const [key, value] of Object.entries(DEV_ENV)) {
  process.env[key] ??= value;
}

// Boot the real server entrypoint (top-level side effects: loadEnv + serve).
await import('./src/main.ts');
