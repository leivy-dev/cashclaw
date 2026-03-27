/**
 * HYRVE AI マーケットプレイス REST クライアント
 * https://api.hyrveai.com/v1
 *
 * 認証: X-API-Key ヘッダー
 * 手数料: 15%（エージェントは 85% 取得）
 */

import type { HyrveJob, HyrveOrder, HyrveWallet, HyrveAgentProfile } from "./types.js";

const HYRVE_API_BASE = "https://api.hyrveai.com/v1";
const DEFAULT_TIMEOUT_MS = 30_000;

export class HyrveClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl = HYRVE_API_BASE) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "X-API-Key": this.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HYRVE API error ${res.status}: ${text}`);
      }

      return res.json() as Promise<T>;
    } finally {
      clearTimeout(timer);
    }
  }

  // --- Health ---

  async health(): Promise<{ status: string }> {
    return this.request<{ status: string }>("GET", "/health");
  }

  // --- Agent ---

  async getProfile(): Promise<HyrveAgentProfile> {
    return this.request<HyrveAgentProfile>("GET", "/agents/me");
  }

  // --- Jobs ---

  async listAvailableJobs(): Promise<HyrveJob[]> {
    const res = await this.request<{ jobs?: HyrveJob[]; data?: HyrveJob[] }>("GET", "/jobs");
    return res.jobs ?? res.data ?? [];
  }

  async getJob(jobId: string): Promise<HyrveJob> {
    return this.request<HyrveJob>("GET", `/jobs/${jobId}`);
  }

  async acceptJob(jobId: string, proposal?: string): Promise<HyrveOrder> {
    return this.request<HyrveOrder>("POST", `/jobs/${jobId}/accept`, {
      proposal,
    });
  }

  // --- Orders ---

  async listOrders(status?: string): Promise<HyrveOrder[]> {
    const qs = status !== undefined ? `?status=${encodeURIComponent(status)}` : "";
    const res = await this.request<{ orders?: HyrveOrder[]; data?: HyrveOrder[] }>(
      "GET",
      `/orders${qs}`,
    );
    return res.orders ?? res.data ?? [];
  }

  async getOrder(orderId: string): Promise<HyrveOrder> {
    return this.request<HyrveOrder>("GET", `/orders/${orderId}`);
  }

  async deliverJob(orderId: string, deliverable: string): Promise<void> {
    await this.request<unknown>("POST", `/orders/${orderId}/deliver`, {
      deliverable,
    });
  }

  async completeOrder(orderId: string): Promise<void> {
    await this.request<unknown>("POST", `/orders/${orderId}/complete`);
  }

  // --- Wallet ---

  async getWallet(): Promise<HyrveWallet> {
    return this.request<HyrveWallet>("GET", "/wallet");
  }

  async requestWithdraw(amount: number, currency = "USD"): Promise<void> {
    await this.request<unknown>("POST", "/wallet/withdraw", { amount, currency });
  }
}

/**
 * 環境変数 HYRVE_API_KEY からクライアントを生成する。
 * キーがなければ null を返す（未設定時はスキップ）。
 */
export function createHyrveClientFromEnv(): HyrveClient | null {
  const apiKey = process.env.HYRVE_API_KEY;
  if (apiKey === undefined || apiKey === "") return null;
  return new HyrveClient(apiKey);
}
