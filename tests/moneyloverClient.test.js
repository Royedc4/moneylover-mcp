import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoneyloverClient, MoneyloverApiError } from '../src/moneyloverClient.js';

const { Response } = globalThis;

if (typeof Response === 'undefined') {
  throw new Error('Fetch Response implementation is required for these tests.');
}

const originalFetch = global.fetch;

describe('MoneyloverClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('retrieves a token via getToken', async () => {
    const firstResponse = new Response(
      JSON.stringify({
        data: {
          request_token: 'req-token',
          login_url: 'https://web.moneylover.me/login?client=abc123'
        },
        error: 0
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );

    const secondResponse = new Response(
      JSON.stringify({ access_token: 'jwt-token' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );

    global.fetch
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(secondResponse);

    const token = await MoneyloverClient.getToken('user@example.com', 'password');

    expect(token).toBe('jwt-token');
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[1][0]).toBe('https://oauth.moneylover.me/token');
  });

  it('throws when API returns an error payload', async () => {
    const response = new Response(
      JSON.stringify({ error: 1, msg: 'user_unauthenticated' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );

    global.fetch.mockResolvedValueOnce(response);

    const client = new MoneyloverClient('token-123');
    await expect(client.getUserInfo()).rejects.toBeInstanceOf(MoneyloverApiError);
  });

  it('sends auth headers when calling protected endpoints', async () => {
    global.fetch.mockImplementation(async (_url, options) => {
      expect(options).toBeDefined();
      expect(options.method).toBe('POST');
      expect(options.headers.get('Authorization')).toBe('AuthJWT secure-token');
      return new Response(
        JSON.stringify({ error: 0, data: { email: 'user@example.com' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const client = new MoneyloverClient('secure-token');
    const data = await client.getUserInfo();

    expect(data).toEqual({ email: 'user@example.com' });
  });

  const ok = data =>
    new Response(JSON.stringify({ error: 0, data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  const bodyOf = call => JSON.parse(call[1].body);

  describe('editTransaction', () => {
    const existing = {
      _id: 'tx-1',
      account: { _id: 'wallet-1' },
      category: { _id: 'cat-old' },
      amount: 0.01,
      note: 'original',
      displayDate: '2026-08-09T00:00:00.000Z',
      with: [],
      exclude_report: false
    };

    it('merges changes over the current record and posts a full object', async () => {
      global.fetch
        .mockResolvedValueOnce(ok({ transactions: [existing] }))
        .mockResolvedValueOnce(ok({}));

      const client = new MoneyloverClient('secure-token');
      await client.editTransaction({ transactionId: 'tx-1', walletId: 'wallet-1', amount: 7.89 });

      const [url, options] = global.fetch.mock.calls[1];
      expect(url).toBe('https://web.moneylover.me/api/transaction/edit');
      expect(options.headers.get('dataformat')).toBe('json');
      expect(bodyOf(global.fetch.mock.calls[1])).toEqual({
        _id: 'tx-1',
        with: [],
        account: 'wallet-1',
        category: 'cat-old',
        amount: 7.89,
        note: 'original',
        displayDate: '2026-08-09',
        event: '',
        exclude_report: false,
        longtitude: 0,
        latitude: 0,
        addressName: '',
        addressDetails: '',
        addressIcon: '',
        image: ''
      });
    });

    it('skips the lookup when the current record is supplied', async () => {
      global.fetch.mockResolvedValueOnce(ok({}));

      const client = new MoneyloverClient('secure-token');
      await client.editTransaction({
        transactionId: 'tx-1',
        walletId: 'wallet-1',
        current: existing,
        note: 'updated'
      });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(bodyOf(global.fetch.mock.calls[0])).toMatchObject({ note: 'updated', amount: 0.01 });
    });

    it('throws when the transaction is absent from the wallet', async () => {
      // Fresh Response per call: the lookup widens its window up to three
      // times, and a Response body can only be consumed once.
      global.fetch.mockImplementation(async () => ok({ transactions: [] }));

      const client = new MoneyloverClient('secure-token');
      await expect(
        client.editTransaction({ transactionId: 'missing', walletId: 'wallet-1', amount: 1 })
      ).rejects.toThrow(/not found/i);
    });
  });

  describe('deleteTransaction', () => {
    it('defaults delRelated to false', async () => {
      global.fetch.mockResolvedValueOnce(ok({}));

      const client = new MoneyloverClient('secure-token');
      await client.deleteTransaction('tx-1');

      expect(global.fetch.mock.calls[0][0]).toBe('https://web.moneylover.me/api/transaction/delete');
      expect(bodyOf(global.fetch.mock.calls[0])).toEqual({ _id: 'tx-1', delRelated: false });
    });

    it('passes delRelated through for transfers', async () => {
      global.fetch.mockResolvedValueOnce(ok({}));

      const client = new MoneyloverClient('secure-token');
      await client.deleteTransaction('tx-1', { deleteRelated: true });

      expect(bodyOf(global.fetch.mock.calls[0])).toEqual({ _id: 'tx-1', delRelated: true });
    });
  });

  describe('getRelatedTransactions', () => {
    it('wraps a single id into the ids array the endpoint expects', async () => {
      global.fetch.mockResolvedValueOnce(ok([]));

      const client = new MoneyloverClient('secure-token');
      await client.getRelatedTransactions('tx-1');

      expect(global.fetch.mock.calls[0][0]).toBe('https://web.moneylover.me/api/transaction/related');
      expect(bodyOf(global.fetch.mock.calls[0])).toEqual({ ids: ['tx-1'] });
    });
  });
});
