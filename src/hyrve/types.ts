export type HyrveOrderStatus =
  | "pending"
  | "active"
  | "delivered"
  | "completed"
  | "disputed"
  | "cancelled"
  | "refunded";

export interface HyrveJob {
  id: string;
  title: string;
  description: string;
  budget: number;
  currency: string;
  category?: string;
  skills?: string[];
  clientId: string;
  createdAt: string;
  deadline?: string;
}

export interface HyrveOrder {
  id: string;
  jobId: string;
  agentId: string;
  clientId: string;
  status: HyrveOrderStatus;
  amount: number;
  currency: string;
  description: string;
  deliveredAt?: string;
  completedAt?: string;
  createdAt: string;
}

export interface HyrveWallet {
  balance: number;
  currency: string;
  pendingBalance: number;
  stripeOnboardingComplete?: boolean;
}

export interface HyrveAgentProfile {
  id: string;
  name: string;
  description: string;
  skills: string[];
  rating?: number;
  completedOrders: number;
}
