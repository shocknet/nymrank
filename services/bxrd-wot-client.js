'use strict';

const zlib = require('zlib');
const readline = require('readline');
const { Readable } = require('stream');
const { normalizeEtag } = require('./bxrd-constants');

class BxrdWotClient {
  constructor(config) {
    this.baseUrl = config.apiBaseUrl.replace(/\/$/, '');
    this.bearerToken = config.bearerToken;
  }

  authHeaders(extra = {}) {
    return {
      Authorization: `Bearer ${this.bearerToken}`,
      ...extra
    };
  }

  async fetchDelta(sinceMs) {
    const url = `${this.baseUrl}/wot?since=${encodeURIComponent(sinceMs)}`;
    const res = await fetch(url, { headers: this.authHeaders() });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`BXRD delta failed: ${res.status} ${text}`);
      err.statusCode = res.status;
      throw err;
    }
    const body = await res.json();
    if (!body.success || !body.data) {
      throw new Error('BXRD delta: invalid response shape');
    }
    return body.data;
  }

  /**
   * @returns {{ status: number, etag: string|null, computedAt: string|null, stream: Readable|null, rowCount: number|null }}
   */
  async openSnapshotGz({ etag }) {
    const headers = this.authHeaders();
    if (etag) {
      headers['If-None-Match'] = etag.includes('"') ? etag : `"${etag}"`;
    }

    const url = `${this.baseUrl}/wot/export.ndjson.gz`;
    const res = await fetch(url, { headers });

    if (res.status === 304) {
      return {
        status: 304,
        etag: normalizeEtag(etag),
        computedAt: null,
        stream: null,
        rowCount: null
      };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`BXRD snapshot failed: ${res.status} ${text}`);
      err.statusCode = res.status;
      throw err;
    }

    const newEtag = normalizeEtag(res.headers.get('etag'));
    const computedAt = res.headers.get('x-bxrd-computed-at');
    const rowCountHeader = res.headers.get('x-bxrd-row-count');
    const rowCount = rowCountHeader ? parseInt(rowCountHeader, 10) : null;

    const webStream = res.body;
    if (!webStream) {
      throw new Error('BXRD snapshot: empty body');
    }

    const nodeStream = Readable.fromWeb(webStream);
    const gunzip = zlib.createGunzip();
    nodeStream.pipe(gunzip);

    return {
      status: 200,
      etag: newEtag,
      computedAt,
      stream: gunzip,
      rowCount
    };
  }

  async *iterateNdjsonLines(readable) {
    const rl = readline.createInterface({ input: readable, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        yield JSON.parse(trimmed);
      }
    } finally {
      rl.close();
    }
  }
}

module.exports = BxrdWotClient;
