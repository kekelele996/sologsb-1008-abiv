import { uid } from "./data";
import type {
  RegisteredTranslation,
  SignItem,
  SignProject,
  WorkOrder,
  WorkOrderAudit,
  WorkOrderStatus,
} from "./types";
import { estimatedLines } from "./utils";

export const WORKORDER_STORAGE_KEY = "sologsb-1008-workorders";
export const WORKORDER_SCHEMA = 2;

export const WORKORDER_STATUS_LABELS: Record<WorkOrderStatus, string> = {
  printing: "待印制",
  to_install: "待挂牌",
  installed: "已挂牌",
  reprint: "退回重印",
  queued: "排队重印",
  done: "已完成",
};

export const TRANSLATION_SOURCE_LABELS: Record<RegisteredTranslation["source"], string> = {
  current: "登记时当前译文",
  snapshot: "升级快照补录",
  manual: "人工核对登记",
};

export type ReconcileResult = "completed" | "verified" | "changed" | "overflow" | "skipped";

const auditEntry = (action: string, detail: string): WorkOrderAudit => ({
  id: uid("audit"),
  at: new Date().toISOString(),
  action,
  detail,
});

const shortDate = (iso: string) => iso.slice(0, 10);

/** 预计行数：按牌面宽度和固定字号排版，不允许缩字号。 */
export function plateLineCount(text: string, order: Pick<WorkOrder, "plateWidth" | "fontSize">) {
  return estimatedLines(text, order.plateWidth, order.fontSize).length;
}

export function fitsPlate(order: Pick<WorkOrder, "plateWidth" | "plateLines" | "fontSize">, text: string) {
  return plateLineCount(text, order) <= order.plateLines;
}

/** 登记服务中心当前译文作为工单译文版本。 */
export function registerCurrentTranslation(
  sign: SignItem,
  source: RegisteredTranslation["source"] = "current",
): RegisteredTranslation {
  const latest = sign.versions[0];
  const matchesSnapshot = latest && latest.targetText === sign.targetText;
  return {
    text: sign.targetText,
    versionId: matchesSnapshot ? latest.id : null,
    versionLabel: matchesSnapshot ? latest.label : "当前译文（未快照）",
    capturedAt: new Date().toISOString(),
    source,
  };
}

/**
 * 挂牌前对账：按工单登记的译文版本与服务中心当前译文核对。
 * 译文改过一律退回重印，已挂上（甚至已完成）的牌子也不算完成；
 * 译文一致但牌面容量不足的排队等重印，不缩字号。
 */
export function reconcileOrder(order: WorkOrder, sign: SignItem | undefined): ReconcileResult {
  if (!sign) {
    order.audit.unshift(auditEntry("对账", "服务中心找不到对应标识，跳过"));
    return "skipped";
  }
  if (order.pendingVerification || !order.translation) {
    order.audit.unshift(auditEntry("对账", "译文版本未登记，待人工核对，跳过"));
    return "skipped";
  }
  if (order.translation.text !== sign.targetText) {
    const wasHung = order.status === "installed" || order.status === "done";
    order.status = "reprint";
    order.audit.unshift(
      auditEntry(
        "退回重印",
        `译文已变更（登记于 ${shortDate(order.translation.capturedAt)}），工单退回重印${wasHung ? "；已挂牌子不计完成" : ""}`,
      ),
    );
    return "changed";
  }
  if (!fitsPlate(order, order.translation.text)) {
    order.status = "queued";
    order.audit.unshift(
      auditEntry(
        "排队重印",
        `牌面容量不足：预计 ${plateLineCount(order.translation.text, order)} 行，容量 ${order.plateLines} 行；不缩字号，排队等重印`,
      ),
    );
    return "overflow";
  }
  if (order.status === "installed") {
    order.status = "done";
    order.audit.unshift(auditEntry("对账一致", "译文与登记版本相符，挂牌完成"));
    return "completed";
  }
  order.audit.unshift(auditEntry("对账一致", "译文与登记版本相符"));
  return "verified";
}

interface LegacyWorkOrder {
  id?: string;
  code?: string;
  signId?: string;
  location?: string;
  plateWidth?: number;
  plateLines?: number;
  fontSize?: number;
  status?: WorkOrderStatus;
  translation?: RegisteredTranslation | null;
  pendingVerification?: boolean;
  audit?: WorkOrderAudit[];
  createdAt?: string;
  updatedAt?: string;
}

/**
 * 旧工单升级：schema 1 的工单没有登记译文版本，按工单创建时间
 * 找当时的版本快照补上；对不上的先标记待核对，等人工确认。
 */
export function migrateWorkOrders(raw: unknown, project: SignProject): { orders: WorkOrder[]; migrated: boolean } {
  const candidate = raw as { schema?: number; orders?: WorkOrder[] } | WorkOrder[] | null;
  if (
    candidate &&
    !Array.isArray(candidate) &&
    candidate.schema === WORKORDER_SCHEMA &&
    Array.isArray(candidate.orders)
  ) {
    return { orders: candidate.orders, migrated: false };
  }
  const legacyList: LegacyWorkOrder[] = Array.isArray(candidate)
    ? candidate
    : Array.isArray(candidate?.orders)
      ? candidate.orders
      : [];
  return { orders: legacyList.map((legacy) => migrateOne(legacy, project)), migrated: true };
}

function migrateOne(legacy: LegacyWorkOrder, project: SignProject): WorkOrder {
  const order: WorkOrder = {
    id: legacy.id ?? uid("wo"),
    code: legacy.code ?? "WO-未知",
    signId: legacy.signId ?? "",
    location: legacy.location ?? "",
    plateWidth: Number(legacy.plateWidth) || 480,
    plateLines: Number(legacy.plateLines) || 3,
    fontSize: Number(legacy.fontSize) || 42,
    status: legacy.status ?? "printing",
    translation: legacy.translation ?? null,
    pendingVerification: Boolean(legacy.pendingVerification),
    audit: Array.isArray(legacy.audit) ? legacy.audit : [],
    createdAt: legacy.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (order.translation) return order;
  const sign = project.signs.find((item) => item.id === order.signId);
  const snapshot = sign?.versions
    .filter((version) => version.createdAt <= order.createdAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (sign && snapshot) {
    order.translation = {
      text: snapshot.targetText,
      versionId: snapshot.id,
      versionLabel: snapshot.label,
      capturedAt: snapshot.createdAt,
      source: "snapshot",
    };
    order.audit.unshift(
      auditEntry("升级补录", `旧工单未登记译文版本，按当时快照「${snapshot.label}」（${shortDate(snapshot.createdAt)}）补上`),
    );
  } else {
    order.pendingVerification = true;
    order.audit.unshift(auditEntry("升级补录", "找不到当时快照，先标记待核对"));
  }
  return order;
}

export function createSeedWorkOrders(): WorkOrder[] {
  return [
    {
      id: "wo-1001",
      code: "WO-1001",
      signId: "sign-exit",
      location: "地下一层 2 号疏散通道",
      plateWidth: 720,
      plateLines: 6,
      fontSize: 36,
      status: "installed",
      translation: {
        text: "EMERGENCY EXIT\nIn an emergency, leave quickly in the direction shown. Do not use the elevator.",
        versionId: "version-exit-1",
        versionLabel: "版本 1",
        capturedAt: "2026-09-25T02:30:00.000Z",
        source: "current",
      },
      pendingVerification: false,
      audit: [
        { id: "audit-1001-2", at: "2026-09-26T07:10:00.000Z", action: "状态推进", detail: "现场已挂牌，待对账确认完成" },
        { id: "audit-1001-1", at: "2026-09-25T02:30:00.000Z", action: "创建工单", detail: "按服务中心当前译文登记版本" },
      ],
      createdAt: "2026-09-25T02:30:00.000Z",
      updatedAt: "2026-09-26T07:10:00.000Z",
    },
    {
      id: "wo-1002",
      code: "WO-1002",
      signId: "sign-platform",
      location: "站台层 3 号候车区立柱",
      plateWidth: 480,
      plateLines: 4,
      fontSize: 40,
      status: "to_install",
      translation: {
        text: "Waiting Area\nPlease queue behind the yellow line.",
        versionId: "version-platform-1",
        versionLabel: "版本 1",
        capturedAt: "2026-09-26T01:20:00.000Z",
        source: "snapshot",
      },
      pendingVerification: false,
      audit: [
        { id: "audit-1002-2", at: "2026-09-27T06:00:00.000Z", action: "状态推进", detail: "印制完成，待现场挂牌" },
        { id: "audit-1002-1", at: "2026-09-26T01:20:00.000Z", action: "创建工单", detail: "按「版本 1」快照登记译文" },
      ],
      createdAt: "2026-09-26T01:20:00.000Z",
      updatedAt: "2026-09-27T06:00:00.000Z",
    },
    {
      id: "wo-1003",
      code: "WO-1003",
      signId: "sign-water",
      location: "公园东门服务亭外墙",
      plateWidth: 320,
      plateLines: 2,
      fontSize: 40,
      status: "installed",
      translation: {
        text: "飲料水\n茶殻や果物の皮などを流さないでください。",
        versionId: null,
        versionLabel: "当前译文（未快照）",
        capturedAt: "2026-09-27T03:40:00.000Z",
        source: "current",
      },
      pendingVerification: false,
      audit: [
        { id: "audit-1003-2", at: "2026-09-28T08:20:00.000Z", action: "状态推进", detail: "现场已挂牌，待对账确认完成" },
        { id: "audit-1003-1", at: "2026-09-27T03:40:00.000Z", action: "创建工单", detail: "按服务中心当前译文登记版本" },
      ],
      createdAt: "2026-09-27T03:40:00.000Z",
      updatedAt: "2026-09-28T08:20:00.000Z",
    },
    {
      id: "wo-1004",
      code: "WO-1004",
      signId: "sign-smoking",
      location: "门诊楼主入口右侧",
      plateWidth: 480,
      plateLines: 3,
      fontSize: 32,
      status: "printing",
      translation: {
        text: "INTERDICTION DE FUMER\nCigarettes électroniques incluses.",
        versionId: null,
        versionLabel: "当前译文（未快照）",
        capturedAt: "2026-09-28T09:00:00.000Z",
        source: "current",
      },
      pendingVerification: false,
      audit: [
        { id: "audit-1004-1", at: "2026-09-28T09:00:00.000Z", action: "创建工单", detail: "按服务中心当前译文登记版本" },
      ],
      createdAt: "2026-09-28T09:00:00.000Z",
      updatedAt: "2026-09-28T09:00:00.000Z",
    },
  ];
}

/** schema 1 旧工单样例：没有登记译文版本，用于演示升级补录流程。 */
export function createLegacyWorkOrders(): LegacyWorkOrder[] {
  return [
    {
      id: "wo-legacy-101",
      code: "WO-2609-101",
      signId: "sign-exit",
      location: "地下一层 1 号疏散通道",
      plateWidth: 720,
      plateLines: 6,
      fontSize: 36,
      status: "installed",
      createdAt: "2026-09-19T08:00:00.000Z",
      updatedAt: "2026-09-19T08:00:00.000Z",
    },
    {
      id: "wo-legacy-102",
      code: "WO-2609-102",
      signId: "sign-platform",
      location: "站台层 5 号候车区",
      plateWidth: 480,
      plateLines: 4,
      fontSize: 40,
      status: "to_install",
      createdAt: "2026-09-22T10:00:00.000Z",
      updatedAt: "2026-09-22T10:00:00.000Z",
    },
    {
      id: "wo-legacy-103",
      code: "WO-2609-103",
      signId: "sign-water",
      location: "公园西门服务亭",
      plateWidth: 480,
      plateLines: 3,
      fontSize: 36,
      status: "installed",
      createdAt: "2026-09-20T09:00:00.000Z",
      updatedAt: "2026-09-20T09:00:00.000Z",
    },
  ];
}
