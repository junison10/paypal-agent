'use strict';

const crypto = require('crypto');

const SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';
const LIVE_BASE_URL = 'https://api-m.paypal.com';

/**
 * PayPal REST client (sandbox by default).
 * Uses the injected fetchImpl when provided, otherwise global fetch.
 */
class PayPalClient {
  constructor({ clientId, clientSecret, mode = 'sandbox', fetchImpl } = {}) {
    if (!clientId || !clientSecret) {
      throw new Error('PayPalClient requires clientId and clientSecret');
    }
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.mode = mode;
    this.baseUrl = mode === 'live' ? LIVE_BASE_URL : SANDBOX_BASE_URL;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('PayPalClient requires a fetch implementation');
    }
    this._accessToken = null;
    this._accessTokenExpiresAt = 0;
  }

  async getAccessToken() {
    if (this._accessToken && Date.now() < this._accessTokenExpiresAt) {
      return this._accessToken;
    }
    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`PayPal token request failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    if (!data.access_token) {
      throw new Error('PayPal token response did not contain access_token');
    }
    // Cache with a 60s safety buffer before the real expiry.
    const ttlMs = Math.max(0, (Number(data.expires_in) || 3600) - 60) * 1000;
    this._accessToken = data.access_token;
    this._accessTokenExpiresAt = Date.now() + ttlMs;
    return this._accessToken;
  }

  async _request(path, method, body) {
    const token = await this.getAccessToken();
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`PayPal ${method} ${path} failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  /**
   * @param {object} opts
   * @param {number|string} opts.amount
   * @param {string} [opts.currency='USD']
   * @param {string} [opts.recipientEmail]
   * @param {string} [opts.invoiceId]
   * @param {string} [opts.memo]
   */
  async createOrder({ amount, currency = 'USD', recipientEmail, invoiceId, memo } = {}) {
    if (amount === undefined || amount === null || Number(amount) <= 0) {
      throw new Error('createOrder requires a positive amount');
    }
    const purchaseUnit = {
      amount: {
        currency_code: currency,
        value: Number(amount).toFixed(2),
      },
    };
    if (recipientEmail) {
      purchaseUnit.payee = { email_address: recipientEmail };
    }
    if (invoiceId) {
      purchaseUnit.custom_id = invoiceId;
    }
    if (memo) {
      purchaseUnit.description = memo;
    }
    return this._request('/v2/checkout/orders', 'POST', {
      intent: 'CAPTURE',
      purchase_units: [purchaseUnit],
    });
  }

  async captureOrder(orderId) {
    if (!orderId) throw new Error('captureOrder requires an orderId');
    return this._request(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, 'POST', {});
  }

  async getOrder(orderId) {
    if (!orderId) throw new Error('getOrder requires an orderId');
    return this._request(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, 'GET');
  }
}

/** In-memory mock with the identical interface — no network, no real money. */
class MockPayPalClient {
  constructor(_opts = {}) {
    this.mode = 'mock';
  }

  async getAccessToken() {
    return 'MOCK-ACCESS-TOKEN';
  }

  async createOrder({ amount, currency = 'USD', recipientEmail, invoiceId, memo } = {}) {
    if (amount === undefined || amount === null || Number(amount) <= 0) {
      throw new Error('createOrder requires a positive amount');
    }
    const id = `MOCK-ORDER-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    const purchaseUnit = {
      amount: { currency_code: currency, value: Number(amount).toFixed(2) },
    };
    this._lastAmount = { ...purchaseUnit.amount };
    if (recipientEmail) purchaseUnit.payee = { email_address: recipientEmail };
    if (invoiceId) purchaseUnit.custom_id = invoiceId;
    if (memo) purchaseUnit.description = memo;
    return { id, status: 'CREATED', intent: 'CAPTURE', purchase_units: [purchaseUnit] };
  }

  async captureOrder(orderId) {
    if (!orderId) throw new Error('captureOrder requires an orderId');
    const captureId = `MOCK-CAPTURE-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    // Amount is echoed from the order when known; fall back to a placeholder.
    const amount = this._lastAmount || { currency_code: 'USD', value: '0.00' };
    return {
      id: orderId,
      status: 'COMPLETED',
      purchase_units: [
        {
          payments: {
            captures: [{ id: captureId, status: 'COMPLETED', amount }],
          },
        },
      ],
    };
  }

  async getOrder(orderId) {
    if (!orderId) throw new Error('getOrder requires an orderId');
    return {
      id: orderId,
      status: 'APPROVED',
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: { currency_code: 'USD', value: '0.00' },
          payments: { captures: [] },
        },
      ],
    };
  }
}

module.exports = { PayPalClient, MockPayPalClient, SANDBOX_BASE_URL, LIVE_BASE_URL };
