import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { HealthResponseSchema } from '@poker/shared';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createTestAuth } from './fakes';

describe('GET /health', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(loadConfig({ NODE_ENV: 'test' }), createTestAuth());
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers with a payload matching the shared schema', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(() => HealthResponseSchema.parse(response.json())).not.toThrow();
  });

  it('sets a CORS allow-origin for the configured web origin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:3000' },
    });

    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });
});
