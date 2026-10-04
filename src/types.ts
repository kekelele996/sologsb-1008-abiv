export type ReviewStatus = "draft" | "pending" | "confirmed" | "changes";

export interface Reply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
  replies: Reply[];
}

export interface TermBinding {
  id: string;
  source: string;
  target: string;
  required: boolean;
  confirmed: boolean;
}

export interface VersionSnapshot {
  id: string;
  label: string;
  createdAt: string;
  sourceText: string;
  targetText: string;
  status: ReviewStatus;
  terms: TermBinding[];
}

export interface SignItem {
  id: string;
  code: string;
  sourceText: string;
  targetLanguage: string;
  targetText: string;
  scenario: string;
  regulation: string;
  status: ReviewStatus;
  terms: TermBinding[];
  comments: ReviewComment[];
  versions: VersionSnapshot[];
  emergencyRevision: boolean;
  updatedAt: string;
}

export type WorkOrderStatus = "queued" | "posted" | "reprint" | "mismatch";
export type WorkOrderSaveState = "idle" | "saving" | "failed" | "saved";

export interface WorkOrder {
  id: string;
  signId: string;
  code: string;
  location: string;
  widthMm: number;
  heightMm: number;
  fontSize: number;
  translationVersionId: string | null;
  legacy: boolean;
  status: WorkOrderStatus;
  capacityIssue: boolean;
  saveState: WorkOrderSaveState;
  saveAttempts: number;
  postedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SignProject {
  id: string;
  title: string;
  location: string;
  activeSignId: string;
  signs: SignItem[];
  workOrders: WorkOrder[];
  updatedAt: string;
}

export interface PersistedProject {
  schema: 1;
  project: SignProject;
}

export interface DiffToken {
  type: "same" | "add" | "remove";
  value: string;
}
