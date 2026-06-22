import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const app = buildApp();
    const res = await app.request('/health');

    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string; service: string; ts: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('sivi-whatsapp-hub');
    expect(typeof body.ts).toBe('string');
  });
});
