const BASE_URL = 'https://web.moneylover.me/api';
const LOGIN_URL = `${BASE_URL}/user/login-url`;
const TOKEN_URL = 'https://oauth.moneylover.me/token';

class MoneyloverApiError extends Error {
  constructor(message, { code, detail } = {}) {
    super(message);
    this.name = 'MoneyloverApiError';
    this.code = code ?? null;
    if (detail) {
      this.detail = detail;
    }
  }
}

const ensureString = (value, name) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
};

const ensureDateString = date => {
  if (!date) {
    throw new Error('date is required');
  }
  if (date instanceof Date) {
    if (Number.isNaN(date.getTime())) {
      throw new Error('date is invalid');
    }
    return date.toISOString().slice(0, 10);
  }
  if (typeof date === 'string') {
    const trimmed = date.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      throw new Error('date must be in YYYY-MM-DD format');
    }
    return trimmed;
  }
  throw new Error('date must be a Date or YYYY-MM-DD string');
};

const readJson = async response => {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`Failed to parse JSON response: ${error.message}`);
  }
};

const parseApiPayload = payload => {
  const errorCode = payload?.error ?? payload?.e ?? 0;
  if (errorCode && errorCode !== 0) {
    const message = payload?.msg || payload?.message || 'Money Lover API error';
    throw new MoneyloverApiError(message, { code: errorCode, detail: payload });
  }
  return payload?.data ?? null;
};

export class MoneyloverClient {
  constructor(token) {
    this.token = ensureString(token, 'token');
  }

  static async getToken(email, password) {
    const loginResponse = await fetch(LOGIN_URL, { method: 'POST' });
    if (!loginResponse.ok) {
      throw new Error(`Failed to initiate login: HTTP ${loginResponse.status}`);
    }

    const loginPayload = await readJson(loginResponse);
    const requestToken = loginPayload?.data?.request_token;
    const loginUrl = loginPayload?.data?.login_url;

    if (!requestToken || !loginUrl) {
      throw new Error('Login response missing request_token or login_url');
    }

    let clientParam = '';
    try {
      const parsed = new URL(loginUrl);
      clientParam = parsed.searchParams.get('client') ?? '';
    } catch (error) {
      throw new Error(`Unable to parse login URL: ${error.message}`);
    }

    if (!clientParam) {
      throw new Error('Login URL missing client parameter');
    }

    const form = new URLSearchParams();
    form.set('email', ensureString(email, 'email'));
    form.set('password', ensureString(password, 'password'));

    const tokenResponse = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${requestToken}`,
        Client: clientParam,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form.toString()
    });

    if (!tokenResponse.ok) {
      throw new Error(`Failed to retrieve access token: HTTP ${tokenResponse.status}`);
    }

    const tokenPayload = await readJson(tokenResponse);
    const accessToken = tokenPayload?.access_token;
    if (!accessToken) {
      throw new Error('Access token not present in response');
    }
    return accessToken;
  }

  async getUserInfo() {
    return this.#post('/user/info');
  }

  async getWallets() {
    return this.#post('/wallet/list');
  }

  async getCategories(walletId) {
    const form = new URLSearchParams();
    form.set('walletId', ensureString(walletId, 'walletId'));
    return this.#post('/category/list', {
      body: form.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
  }

  // Keyed by walletId. /category/list returns wallet-local IDs that the
  // transaction/add endpoint rejects with HTTP 524. The only IDs that work
  // are the global ones embedded in existing transactions. This method
  // discovers and caches them for the session.
  #categoryGlobalCache = new Map();
  #CATEGORY_CACHE_TTL_MS = 5 * 60 * 1000;

  async getCategoryGlobalIds(walletId) {
    const wid = ensureString(walletId, 'walletId');
    const cached = this.#categoryGlobalCache.get(wid);
    if (cached && Date.now() - cached.fetchedAt < this.#CATEGORY_CACHE_TTL_MS) {
      return cached.categories;
    }

    const endDate = new Date().toISOString().slice(0, 10);
    const data = await this.getTransactions(wid, '2020-01-01', endDate);
    const txs = data?.transactions ?? [];

    const seen = new Map();
    for (const tx of txs) {
      const cat = tx.category;
      if (!cat?._id) continue;
      if (!seen.has(cat._id)) {
        seen.set(cat._id, {
          _id: cat._id,
          name: cat.name,
          type: cat.type,
          icon: cat.icon ?? null,
          parent: cat.parent
            ? { _id: cat.parent._id, name: cat.parent.name, type: cat.parent.type }
            : null
        });
      }
      const par = cat.parent;
      if (par?._id && !seen.has(par._id)) {
        seen.set(par._id, {
          _id: par._id,
          name: par.name,
          type: par.type,
          icon: par.icon ?? null,
          parent: null
        });
      }
    }

    const categories = [...seen.values()];
    this.#categoryGlobalCache.set(wid, { fetchedAt: Date.now(), categories });
    return categories;
  }

  async getTransactions(walletId, startDate, endDate) {
    const payload = {
      walletId: ensureString(walletId, 'walletId'),
      startDate: ensureString(startDate, 'startDate'),
      endDate: ensureString(endDate, 'endDate')
    };
    return this.#post('/transaction/list', {
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' }
    });
  }

  async addTransaction(params) {
    if (!params || typeof params !== 'object') {
      throw new Error('params is required');
    }

    const payload = {
      with: Array.isArray(params.with) ? params.with : [],
      account: ensureString(params.walletId ?? params.WalletID, 'walletId'),
      category: ensureString(params.categoryId ?? params.CategoryID, 'categoryId'),
      amount: ensureString(params.amount ?? params.Amount, 'amount'),
      note: typeof params.note === 'string' ? params.note : params.Note ?? '',
      displayDate: ensureDateString(params.date ?? params.Date)
    };

    const campaignId = params.campaignId ?? params.CampaignID ?? params.campaign;
    if (typeof campaignId === 'string' && campaignId.trim() !== '') {
      payload.event = campaignId.trim();
    }

    return this.#post('/transaction/add', {
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // /transaction/edit is a full replace, not a patch: every field the web app
  // sends has to be present or the server blanks it. Callers pass only what
  // changes; we merge over the current record fetched from /transaction/list.
  // Note the asymmetry with /transaction/add — there amount is a string, here
  // the web client sends it as a number.
  async editTransaction(params) {
    if (!params || typeof params !== 'object') {
      throw new Error('params is required');
    }

    const id = ensureString(params.transactionId ?? params._id, 'transactionId');
    const current = params.current ?? (await this.#findTransaction(id, params.walletId));

    const pick = (next, prev, fallback) => (next !== undefined ? next : prev !== undefined ? prev : fallback);

    const payload = {
      _id: id,
      with: Array.isArray(params.with) ? params.with : current?.with ?? [],
      account: ensureString(params.walletId ?? current?.account?._id ?? current?.account, 'walletId'),
      category: ensureString(params.categoryId ?? current?.category?._id, 'categoryId'),
      amount: Number(pick(params.amount, current?.amount)),
      note: pick(params.note, current?.note, ''),
      displayDate: ensureDateString(
        params.date ?? (current?.displayDate ? String(current.displayDate).slice(0, 10) : undefined)
      ),
      event: pick(params.campaignId, current?.campaign?.[0]?._id, ''),
      exclude_report: Boolean(pick(params.excludeReport, current?.exclude_report, false)),
      longtitude: Number(pick(params.longitude, current?.longtitude, 0)),
      latitude: Number(pick(params.latitude, current?.latitude, 0)),
      addressName: pick(params.addressName, current?.addressName, ''),
      addressDetails: pick(params.addressDetails, current?.addressDetails, ''),
      addressIcon: pick(params.addressIcon, current?.addressIcon, ''),
      image: pick(params.image, current?.image, '')
    };

    if (!Number.isFinite(payload.amount)) {
      throw new Error('amount is required and must be numeric');
    }

    return this.#post('/transaction/edit', {
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json', dataformat: 'json' }
    });
  }

  // delRelated controls the transfer twin: a transfer is two linked records
  // (see getRelatedTransactions), and deleting one leg with delRelated=false
  // leaves the other stranded, silently desyncing the two wallets.
  async deleteTransaction(transactionId, { deleteRelated = false } = {}) {
    const payload = {
      _id: ensureString(transactionId, 'transactionId'),
      delRelated: Boolean(deleteRelated)
    };

    return this.#post('/transaction/delete', {
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json', dataformat: 'json' }
    });
  }

  // Returns the opposite leg(s) of a transfer. Takes an ARRAY under `ids` —
  // passing `_id` instead yields error 706 "Not authorized", which is a
  // malformed-payload response, not a real auth failure.
  async getRelatedTransactions(transactionIds) {
    const ids = (Array.isArray(transactionIds) ? transactionIds : [transactionIds]).map((id, index) =>
      ensureString(id, `transactionIds[${index}]`)
    );
    if (ids.length === 0) {
      throw new Error('transactionIds is required');
    }

    return this.#post('/transaction/related', {
      body: JSON.stringify({ ids }),
      headers: { 'Content-Type': 'application/json', dataformat: 'json' }
    });
  }

  // /transaction/list is the only read path, so locating one record means
  // scanning a window around it. Widened progressively to keep the common
  // case (a recent transaction) cheap.
  async #findTransaction(transactionId, walletId) {
    if (!walletId) {
      throw new Error('walletId is required when the current transaction is not supplied');
    }
    const wid = ensureString(walletId, 'walletId');
    const today = new Date();
    const end = new Date(today.getFullYear() + 1, 11, 31).toISOString().slice(0, 10);

    for (const yearsBack of [1, 5, 20]) {
      const start = new Date(today.getFullYear() - yearsBack, 0, 1).toISOString().slice(0, 10);
      const data = await this.getTransactions(wid, start, end);
      const found = (data?.transactions ?? []).find(tx => tx._id === transactionId);
      if (found) {
        return found;
      }
    }

    throw new Error(`Transaction ${transactionId} not found in wallet ${wid}`);
  }

  async #post(path, { body, headers } = {}) {
    const requestHeaders = new Headers({
      Authorization: `AuthJWT ${this.token}`,
      'Cache-Control': 'no-cache, max-age=0, no-store, no-transform, must-revalidate'
    });

    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        requestHeaders.set(key, value);
      }
    }

    const response = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: requestHeaders,
      body
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Money Lover API request failed: HTTP ${response.status} - ${detail}`);
    }

    const payload = await readJson(response);
    return parseApiPayload(payload);
  }
}

export { MoneyloverApiError };

export const CategoryType = Object.freeze({
  INCOME: 1,
  EXPENSE: 2
});

export default MoneyloverClient;
