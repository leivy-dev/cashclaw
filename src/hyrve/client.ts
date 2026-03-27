/**
 * HYRVE AI マーケットプレイス REST クライアント
 * https://api.hyrveai.com/v1
 *
 * 認証:
 *   - X-API-Key: ハートビート・ジョブ一覧（エージェント操作）
 *   - Bearer JWT: オーダー・ウォレット（ユーザー操作）
 * 手数料: 15%（エージェントは 85% 取得）
 */

import type { HyrveJob, HyrveOrder, HyrveWallet, HyrveAgentProfile } from "./types.js";

const HYRVE_API_BASE = "https://api.hyrveai.com/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const JWT_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5分前に更新

interface JwtState {
  token: string;
  expiresAt: number; // Unix ms
}

export class HyrveClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly email: string | undefined;
  private readonly password: string | undefined;
  private readonly agentId: string | undefined;
  private jwt: JwtState | null = null;

  constructor(
    apiKey: string,
    opts: {
      baseUrl?: string;
      email?: string;
      password?: string;
      agentId?: string;
    } = {},
  ) {
    this.apiKey = apiKey;
    this.baseUrl = opts.baseUrl ?? HYRVE_API_BASE;
    this.email = opts.email;
    this.password = opts.password;
    this.agentId = opts.agentId;
  }

  // --- JWT 管理 ---

  private async ensureJwt(): Promise<string> {
    const now = Date.now();
    if (this.jwt !== null && this.jwt.expiresAt - JWT_REFRESH_BUFFER_MS > now) {
      return this.jwt.token;
    }

    if (this.email === undefined || this.password === undefined) {
      throw new Error(
        "HYRVE JWT auth requires HYRVE_EMAIL and HYRVE_PASSWORD env vars",
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email: this.email, password: this.password }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HYRVE login error ${res.status}: ${text}`);
      }
      const data = (await res.json()) as {
        access_token?: string;
        expires_in?: number;
      };
      const token = data.access_token;
      if (token === undefined || token === "") {
        throw new Error("HYRVE login returned no access_token");
      }
      const expiresIn = data.expires_in ?? 3600;
      this.jwt = { token, expiresAt: now + expiresIn * 1000 };
      return token;
    } finally {
      clearTimeout(timer);
    }
  }

  // --- HTTP ベースリクエスト ---

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    auth: "api-key" | "jwt" = "api-key",
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let authHeader: string;
      if (auth === "jwt") {
        const token = await this.ensureJwt();
        authHeader = `Bearer ${token}`;
      } else {
        authHeader = this.apiKey; // X-API-Key は別ヘッダー
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      if (auth === "jwt") {
        headers["Authorization"] = authHeader;
      } else {
        headers["X-API-Key"] = authHeader;
      }

      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
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
    const id = this.agentId;
    if (id !== undefined && id !== "") {
      const res = await this.request<{ agent: HyrveAgentProfile }>(
        "GET",
        `/agents/${id}`,
      );
      return res.agent;
    }
    return this.request<HyrveAgentProfile>("GET", "/agents/me", undefined, "jwt");
  }

  async sendHeartbeat(): Promise<{ pending_jobs: number }> {
    const id = this.agentId;
    if (id === undefined || id === "") {
      throw new Error("HYRVE_AGENT_ID is required for heartbeat");
    }
    return this.request<{ ack: boolean; pending_jobs: number }>(
      "POST",
      `/agents/${id}/heartbeat`,
      {}, // empty body required by API
    );
  }

  // --- Jobs ---

  async listAvailableJobs(): Promise<HyrveJob[]> {
    const res = await this.request<{
      jobs?: HyrveJob[];
      data?: HyrveJob[];
    }>("GET", "/jobs");
    return res.jobs ?? res.data ?? [];
  }

  async getJob(jobId: string): Promise<HyrveJob> {
    return this.request<HyrveJob>("GET", `/jobs/${jobId}`);
  }

  // --- Orders ---

  async listOrders(status?: string): Promise<HyrveOrder[]> {
    const qs = new URLSearchParams({ role: "agent" });
    if (status !== undefined) qs.set("status", status);
    const res = await this.request<{ orders?: HyrveOrder[]; data?: HyrveOrder[] }>(
      "GET",
      `/orders?${qs.toString()}`,
      undefined,
      "jwt",
    );
    return res.orders ?? res.data ?? [];
  }

  async getOrder(orderId: string): Promise<HyrveOrder> {
    return this.request<HyrveOrder>("GET", `/orders/${orderId}`, undefined, "jwt");
  }

  async deliverJob(orderId: string, deliverable: string): Promise<void> {
    await this.request<unknown>(
      "POST",
      `/orders/${orderId}/deliver`,
      { deliverables: deliverable },
      "jwt",
    );
  }

  async completeOrder(orderId: string): Promise<void> {
    await this.request<unknown>("POST", `/orders/${orderId}/complete`, undefined, "jwt");
  }

  // --- Wallet ---

  async getWallet(): Promise<HyrveWallet> {
    const res = await this.request<{ wallet: HyrveWallet }>(
      "GET",
      "/wallet",
      undefined,
      "jwt",
    );
    return res.wallet;
  }

  async requestWithdraw(amount: number, currency = "USD"): Promise<void> {
    await this.request<unknown>("POST", "/wallet/withdraw", { amount, currency }, "jwt");
  }
}

/**
 * 環境変数から HyrveClient を生成する。
 * HYRVE_API_KEY がなければ null を返す。
 * HYRVE_EMAIL / HYRVE_PASSWORD が設定されていれば JWT auth も有効になる。
 */
export function createHyrveClientFromEnv(): HyrveClient | null {
  const apiKey = process.env.HYRVE_API_KEY;
  if (apiKey === undefined || apiKey === "") return null;
  return new HyrveClient(apiKey, {
    email: process.env.HYRVE_EMAIL,
    password: process.env.HYRVE_PASSWORD,
    agentId: process.env.HYRVE_AGENT_ID,
  });
}
