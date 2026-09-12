import { describe, expect, it } from 'vitest';
import { assertAuthConfig, loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('falls back to development defaults when nothing is set', () => {
    const config = loadConfig({});

    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(4000);
    expect(config.WEB_ORIGIN).toBe('http://localhost:3000');
    expect(config.SMS_PROVIDER).toBe('console');
  });

  it('treats an empty value as absent, so an unfilled .env still boots', () => {
    const config = loadConfig({ JWT_SECRET: '', PORT: '' });

    expect(config.JWT_SECRET).toBeUndefined();
    expect(config.PORT).toBe(4000);
  });

  it('coerces PORT and rejects one out of range', () => {
    expect(loadConfig({ PORT: '8080' }).PORT).toBe(8080);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/);
  });

  it('rejects a JWT secret too short to be worth having', () => {
    expect(() => loadConfig({ JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('rejects a WEB_ORIGIN that is not a URL', () => {
    expect(() => loadConfig({ WEB_ORIGIN: 'localhost:3000' })).toThrow(/WEB_ORIGIN/);
  });
});

describe('assertAuthConfig', () => {
  const complete = {
    DATABASE_URL: 'postgresql://poker:poker@localhost:5432/poker',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
  };

  it('passes a fully configured environment through', () => {
    const config = assertAuthConfig(loadConfig(complete));

    expect(config.DATABASE_URL).toBe(complete.DATABASE_URL);
    expect(config.JWT_SECRET).toHaveLength(48);
  });

  it('names what is missing rather than failing at the first request', () => {
    expect(() => assertAuthConfig(loadConfig({}))).toThrow(
      /DATABASE_URL, REDIS_URL, JWT_SECRET, JWT_REFRESH_SECRET/,
    );
  });

  it('refuses to sign refresh tokens with the access secret', () => {
    expect(() =>
      assertAuthConfig(loadConfig({ ...complete, JWT_REFRESH_SECRET: complete.JWT_SECRET })),
    ).toThrow(/must be different/);
  });
});
