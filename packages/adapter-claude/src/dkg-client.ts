/**
 * Thin HTTP client for the DKG daemon API.
 * Used by both the MCP server and the context sync script.
 */

import { loadAuthTokenSync } from '@origintrail-official/dkg-core';

export class DkgDaemonClient {
  readonly baseUrl: string;
  private readonly token: string | undefined;

  constructor(baseUrl: string = 'http://127.0.0.1:9200') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = loadAuthTokenSync();
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }

  async get(path: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${res.statusText}`);
    return res.json();
  }

  async post(path: string, body: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`POST ${path}: ${res.status} ${res.statusText}`);
    return res.json();
  }

  async healthCheck(): Promise<boolean> {
    try {
      const data = await this.get('/api/status');
      return !!(data?.peerId || data?.ok);
    } catch {
      return false;
    }
  }
}
