import type { SignItem, WorkOrder } from "../types";
import { analyzeSign } from "../utils";

const MM_TO_PX = 3.7795; // 96dpi 下毫米到像素的换算

export interface ReconcileOutcome {
  status: WorkOrder["status"];
  reason: string;
}

/**
 * 对账：按工单登记的译文版本与服务中心当前译文比对。
 * - 旧工单（未记版本）尝试按当时快照补上，补不上的标待核对。
 * - 登记版本快照不存在 → 待核对。
 * - 登记版本快照的译文与当前译文不一致 → 退回重印（已挂上的牌子不算完成）。
 */
export function reconcileOrder(order: WorkOrder, sign: SignItem | undefined): ReconcileOutcome {
  if (!sign) return { status: "mismatch", reason: "工单关联的标识不存在，待核对" };
  if (order.translationVersionId === null) {
    const match = sign.versions.find((version) => version.targetText === sign.targetText);
    if (match) {
      const isLatest = sign.versions[0]?.id === match.id;
      return isLatest
        ? { status: order.status === "posted" ? "posted" : "queued", reason: "已按快照补登译文版本，版本一致" }
        : { status: "reprint", reason: "译文已更新，工单登记的是旧快照，需退回重印" };
    }
    return { status: "mismatch", reason: "旧工单未登记译文版本，且无匹配快照，待核对" };
  }
  const snapshot = sign.versions.find((version) => version.id === order.translationVersionId);
  if (!snapshot) return { status: "mismatch", reason: "登记的译文版本快照已不存在，待核对" };
  if (snapshot.targetText !== sign.targetText) {
    return { status: "reprint", reason: `译文已修改（登记版本：${snapshot.label}），需退回重印` };
  }
  return { status: order.status === "posted" ? "posted" : "queued", reason: "译文版本一致" };
}

export interface CapacityOutcome {
  fits: boolean;
  reason: string;
  lines: number;
  lineCapacity: number;
}

/**
 * 牌面容量校核：按牌面尺寸（毫米）和牌面字号折算像素后判断容量。
 * 放不下的排队等重印，不缩字号。
 */
export function checkFaceCapacity(sign: SignItem, order: WorkOrder): CapacityOutcome {
  const widthPx = Math.max(120, Math.round(order.widthMm * MM_TO_PX));
  const heightPx = Math.max(40, Math.round(order.heightMm * MM_TO_PX));
  const analysis = analyzeSign(sign, widthPx, order.fontSize);
  const lineHeightPx = order.fontSize * 1.25;
  const verticalCapacity = Math.max(1, Math.floor(heightPx / lineHeightPx));
  const verticalOverflow = analysis.lines.length > verticalCapacity;
  if (analysis.overflow || verticalOverflow) {
    return {
      fits: false,
      reason: `牌面容量不足（${analysis.lines.length} 行 / 上限 ${verticalCapacity} 行），排队等重印，不缩字号`,
      lines: analysis.lines.length,
      lineCapacity: verticalCapacity,
    };
  }
  return { fits: true, reason: "牌面容量合适", lines: analysis.lines.length, lineCapacity: verticalCapacity };
}

/**
 * 升级旧工单：把未记译文版本的工单按当时快照补上，对不上的标记为待核对。
 */
export function migrateLegacyOrders(signs: SignItem[], workOrders: WorkOrder[]): WorkOrder[] {
  return workOrders.map((order) => {
    if (!order.legacy || order.translationVersionId !== null) return order;
    const sign = signs.find((item) => item.id === order.signId);
    if (!sign) return { ...order, status: "mismatch" as const };
    const match = sign.versions.find((version) => version.targetText === sign.targetText);
    if (match) {
      return {
        ...order,
        legacy: false,
        translationVersionId: match.id,
        status: order.status === "posted" ? "posted" : "queued",
      };
    }
    return { ...order, status: "mismatch" as const };
  });
}
