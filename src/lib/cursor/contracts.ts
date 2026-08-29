export interface CursorCredential {
  expiresAt: string;
  secret: string;
  userId: string;
}

export interface CursorConnectionStatus {
  accountEmail?: string | null;
  checkedAt: string;
  connected: boolean;
  expired?: boolean;
  expiresAt?: string | null;
  reconnectReason?: string | null;
  reconnectRequired?: boolean;
  updatedAt?: string | null;
}

export type CursorAuthFlowStatus =
  | "starting"
  | "processing"
  | "prompted"
  | "authenticated"
  | "canceled"
  | "expired"
  | "error";
