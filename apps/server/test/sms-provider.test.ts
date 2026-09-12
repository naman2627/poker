/**
 * Choosing a gateway is an environment variable, and no route handler ever
 * touches one directly — it goes through the OTP service, which holds it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSmsProvider } from '../src/sms/provider';
import { loadConfig } from '../src/config';

const message = { phone: '+14155552671', code: '424242', expiresInSec: 300 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createSmsProvider', () => {
  it('builds the one SMS_PROVIDER names', async () => {
    const console_ = await createSmsProvider(loadConfig({ SMS_PROVIDER: 'console' }));
    const msg91 = await createSmsProvider(
      loadConfig({ SMS_PROVIDER: 'msg91', SMS_API_KEY: 'key', SMS_SENDER_ID: 'template' }),
    );
    const twilio = await createSmsProvider(
      loadConfig({ SMS_PROVIDER: 'twilio', SMS_API_KEY: 'sid:token', SMS_SENDER_ID: '+15550000' }),
    );

    expect([console_.name, msg91.name, twilio.name]).toEqual(['console', 'msg91', 'twilio']);
  });

  it('defaults to the console provider, which is the safe one to forget', async () => {
    const provider = await createSmsProvider(loadConfig({}));

    expect(provider.name).toBe('console');
  });

  it('refuses to build a real gateway without its credentials', async () => {
    await expect(createSmsProvider(loadConfig({ SMS_PROVIDER: 'msg91' }))).rejects.toThrow(
      /SMS_API_KEY/,
    );
    await expect(createSmsProvider(loadConfig({ SMS_PROVIDER: 'twilio' }))).rejects.toThrow(
      /SMS_API_KEY/,
    );
    await expect(
      createSmsProvider(
        loadConfig({ SMS_PROVIDER: 'twilio', SMS_API_KEY: 'no-colon', SMS_SENDER_ID: '+1555' }),
      ),
    ).rejects.toThrow(/accountSid:authToken/);
  });
});

describe('the console provider', () => {
  it('prints the code, which is the whole point of it', async () => {
    const printed = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const provider = await createSmsProvider(loadConfig({ SMS_PROVIDER: 'console' }));

    await provider.sendOtp(message);

    expect(printed).toHaveBeenCalledTimes(1);
    expect(String(printed.mock.calls[0]?.[0])).toContain('424242');
    expect(String(printed.mock.calls[0]?.[0])).toContain('+14155552671');
  });
});

describe('the msg91 provider', () => {
  it('sends the code to msg91 and nowhere else', async () => {
    const printed = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    const provider = await createSmsProvider(
      loadConfig({ SMS_PROVIDER: 'msg91', SMS_API_KEY: 'secret-key', SMS_SENDER_ID: 'tmpl-1' }),
    );
    await provider.sendOtp(message);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain('msg91.com');
    expect(init?.headers).toMatchObject({ authkey: 'secret-key' });
    // The number goes without its plus, and the code rides in the body.
    expect(String(init?.body)).toContain('4155552671');
    expect(String(init?.body)).toContain('424242');
    expect(printed).not.toHaveBeenCalled();
  });

  it('reports a refusal without echoing the code', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 401 }));

    const provider = await createSmsProvider(
      loadConfig({ SMS_PROVIDER: 'msg91', SMS_API_KEY: 'k', SMS_SENDER_ID: 't' }),
    );

    await expect(provider.sendOtp(message)).rejects.toThrow(/msg91 answered 401/);
    await expect(provider.sendOtp(message)).rejects.not.toThrow(/424242/);
  });
});

describe('the twilio provider', () => {
  it('posts the message to the account in SMS_API_KEY', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 201 }));

    const provider = await createSmsProvider(
      loadConfig({
        SMS_PROVIDER: 'twilio',
        SMS_API_KEY: 'AC123:tok',
        SMS_SENDER_ID: '+15551110000',
      }),
    );
    await provider.sendOtp(message);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    expect(String(init?.body)).toContain('424242');
    expect(String(init?.body)).toContain(encodeURIComponent('+14155552671'));
  });

  it('reports a refusal', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));

    const provider = await createSmsProvider(
      loadConfig({ SMS_PROVIDER: 'twilio', SMS_API_KEY: 'AC1:tok', SMS_SENDER_ID: '+1555' }),
    );

    await expect(provider.sendOtp(message)).rejects.toThrow(/twilio answered 500/);
  });
});
