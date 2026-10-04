import { $, component$, useSignal, useVisibleTask$, type QRL, type Signal } from "@builder.io/qwik";
import { uid } from "../data";
import type { SignProject, WorkOrder } from "../types";
import { cloneTerms } from "../utils";
import { checkFaceCapacity, migrateLegacyOrders, reconcileOrder } from "./utils";

interface OrdersPanelProps {
  project: Signal<SignProject>;
  commit: QRL<(label: string, update: (draft: SignProject) => void) => void>;
  toast: Signal<string>;
}

const STATUS_META: Record<WorkOrder["status"], { label: string; cls: string }> = {
  queued: { label: "待挂牌", cls: "badge-neutral" },
  posted: { label: "已挂牌", cls: "badge-success" },
  reprint: { label: "退回重印", cls: "badge-error" },
  mismatch: { label: "待核对", cls: "badge-warning" },
};

const SAVE_META: Record<WorkOrder["saveState"], { label: string; cls: string }> = {
  idle: { label: "未保存", cls: "badge-ghost" },
  saving: { label: "保存中…", cls: "badge-info" },
  failed: { label: "保存失败", cls: "badge-error" },
  saved: { label: "已保存", cls: "badge-success" },
};

export const OrdersPanel = component$<OrdersPanelProps>(({ project, commit, toast }) => {
  const simulateFailure = useSignal(true);

  useVisibleTask$(() => {
    reconcileAll();
  });

  const signOf = (order: WorkOrder) => project.value.signs.find((sign) => sign.id === order.signId);
  const versionLabel = (signId: string, versionId: string | null) => {
    if (versionId === null) return "未登记";
    const sign = project.value.signs.find((item) => item.id === signId);
    return sign?.versions.find((version) => version.id === versionId)?.label ?? "快照已不存在";
  };

  const counts = project.value.workOrders.reduce(
    (acc, order) => {
      acc[order.status] += 1;
      return acc;
    },
    { queued: 0, posted: 0, reprint: 0, mismatch: 0 } as Record<WorkOrder["status"], number>,
  );

  const reconcileAll = $(() => {
    commit("工单对账", (draft) => {
      for (const order of draft.workOrders) {
        const sign = draft.signs.find((item) => item.id === order.signId);
        const outcome = reconcileOrder(order, sign);
        order.status = outcome.status;
        if (sign) order.capacityIssue = !checkFaceCapacity(sign, order).fits;
        if (order.status !== "posted") order.postedAt = null;
      }
    });
    toast.value = "对账完成：译文改过的工单已退回重印";
  });

  const migrateLegacy = $(() => {
    commit("升级旧工单", (draft) => {
      draft.workOrders = migrateLegacyOrders(draft.signs, draft.workOrders);
    });
    toast.value = "旧工单已按快照升级，对不上的标记为待核对";
  });

  const saveWorkOrder = $(async (orderId: string) => {
    const order = project.value.workOrders.find((item) => item.id === orderId);
    if (!order) return;
    const firstAttempt = order.saveAttempts === 0;
    commit("保存工单", (draft) => {
      const item = draft.workOrders.find((entry) => entry.id === orderId);
      if (item) {
        item.saveState = "saving";
        item.saveAttempts += 1;
        item.updatedAt = new Date().toISOString();
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const failed = simulateFailure.value && firstAttempt;
    commit(failed ? "工单保存失败" : "工单保存成功", (draft) => {
      const item = draft.workOrders.find((entry) => entry.id === orderId);
      if (item) item.saveState = failed ? "failed" : "saved";
    });
    toast.value = failed
      ? "施工队保存失败：服务中心译文未受影响，可只重试本侧"
      : "施工队工单已保存（服务中心译文照旧）";
  });

  const createOrder = $(() => {
    const sign = project.value.signs[0];
    if (!sign) return;
    const id = uid("wo");
    commit("新建施工工单", (draft) => {
      draft.workOrders.unshift({
        id,
        signId: sign.id,
        code: `WO-${new Date().getFullYear()}-${String(draft.workOrders.length + 101).padStart(4, "0")}`,
        location: "待补充",
        widthMm: 600,
        heightMm: 200,
        fontSize: 48,
        translationVersionId: sign.versions[0]?.id ?? null,
        legacy: false,
        status: "queued",
        capacityIssue: false,
        saveState: "idle",
        saveAttempts: 0,
        postedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
    saveWorkOrder(id);
  });

  const registerVersion = $((orderId: string) => {
    commit("登记译文版本", (draft) => {
      const order = draft.workOrders.find((item) => item.id === orderId);
      const sign = draft.signs.find((item) => item.id === order?.signId);
      if (!order || !sign) return;
      if (!sign.versions.length) {
        sign.versions.unshift({
          id: uid("version"),
          label: `版本 ${sign.versions.length + 1}`,
          createdAt: new Date().toISOString(),
          sourceText: sign.sourceText,
          targetText: sign.targetText,
          status: sign.status,
          terms: cloneTerms(sign.terms),
        });
      }
      order.translationVersionId = sign.versions[0].id;
      order.legacy = false;
      order.status = "queued";
    });
    toast.value = "已登记当前译文版本，可重新对账";
  });

  const postOrder = $((orderId: string) => {
    const order = project.value.workOrders.find((item) => item.id === orderId);
    const sign = order ? project.value.signs.find((item) => item.id === order.signId) : undefined;
    if (!order || !sign) return;
    const capacity = checkFaceCapacity(sign, order);
    if (!capacity.fits) {
      toast.value = "牌面容量不足，已排队等重印，不缩字号";
      return;
    }
    commit("挂牌", (draft) => {
      const item = draft.workOrders.find((entry) => entry.id === orderId);
      if (item) {
        item.status = "posted";
        item.capacityIssue = false;
        item.postedAt = new Date().toISOString();
      }
    });
    toast.value = "已挂牌";
  });

  const reprintOrder = $((orderId: string) => {
    commit("退回重印", (draft) => {
      const order = draft.workOrders.find((item) => item.id === orderId);
      if (order) {
        order.status = "reprint";
        order.postedAt = null;
      }
    });
    toast.value = "工单已退回重印";
  });

  return (
    <div class="space-y-4">
      <div class="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <div class="flex flex-wrap gap-2 text-sm">
          <span class="badge badge-lg badge-neutral gap-1">待挂牌 {counts.queued}</span>
          <span class="badge badge-lg badge-success gap-1">已挂牌 {counts.posted}</span>
          <span class="badge badge-lg badge-error gap-1">退回重印 {counts.reprint}</span>
          <span class="badge badge-lg badge-warning gap-1">待核对 {counts.mismatch}</span>
        </div>
        <div class="ml-auto flex flex-wrap items-center gap-2">
          <label class="label cursor-pointer gap-2 text-xs">
            <span class="label-text">模拟施工队保存失败</span>
            <input type="checkbox" class="toggle toggle-sm toggle-warning" checked={simulateFailure.value} onChange$={(_, el) => (simulateFailure.value = el.checked)} />
          </label>
          <button class="btn btn-sm btn-outline" onClick$={migrateLegacy}>升级旧工单</button>
          <button class="btn btn-sm btn-outline" onClick$={createOrder}>新建工单</button>
          <button class="btn btn-sm btn-primary" onClick$={reconcileAll}>对账</button>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-4 xl:grid-cols-[320px_1fr]">
        <aside class="space-y-3">
          <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div class="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">语言服务中心</div>
            <div class="mt-1 text-lg font-bold text-slate-800">译文与版本</div>
            <p class="mt-1 text-xs leading-5 text-slate-500">管中文原文、译文和审校状态；挂牌前按工单登记的译文版本对账。</p>
          </div>
          {project.value.signs.map((sign) => (
            <div key={sign.id} class="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
              <div class="flex items-center justify-between">
                <span class="font-mono text-xs font-bold text-slate-500">{sign.code}</span>
                <span class="badge badge-sm badge-outline">{sign.targetLanguage}</span>
              </div>
              <div class="mt-2 line-clamp-2 text-sm font-semibold text-slate-700">{sign.targetText}</div>
              <div class="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                <span>审校状态：{sign.status}</span>
                <span>{sign.versions.length ? `已存 ${sign.versions.length} 版` : "未保存版本"}</span>
              </div>
            </div>
          ))}
        </aside>

        <section class="space-y-3">
          <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div class="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">市政施工队</div>
            <div class="mt-1 text-lg font-bold text-slate-800">安装工单与挂牌</div>
            <p class="mt-1 text-xs leading-5 text-slate-500">管安装工单、牌面尺寸和挂牌位置；保存失败只重试本侧，服务中心译文照旧。</p>
          </div>

          {project.value.workOrders.length === 0 && (
            <div class="rounded-xl border border-dashed p-8 text-center text-sm text-slate-400">还没有施工工单，点击「新建工单」创建。</div>
          )}

          {project.value.workOrders.map((order) => {
            const sign = signOf(order);
            const outcome = sign ? reconcileOrder(order, sign) : undefined;
            const capacity = sign ? checkFaceCapacity(sign, order) : undefined;
            const registeredLabel = versionLabel(order.signId, order.translationVersionId);
            const currentLabel = sign?.versions[0]?.label ?? "未保存版本";
            const changed = outcome?.status === "reprint";
            return (
              <div key={order.id} class={`rounded-xl border-l-4 bg-white p-4 shadow-sm ${STATUS_META[order.status].cls.replace("badge-", "border-")}`}>
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-mono text-sm font-bold">{order.code}</span>
                  <span class={`badge badge-sm ${STATUS_META[order.status].cls}`}>{STATUS_META[order.status].label}</span>
                  <span class={`badge badge-sm ${SAVE_META[order.saveState].cls}`}>{SAVE_META[order.saveState].label}</span>
                  {order.legacy && <span class="badge badge-sm badge-ghost">旧工单</span>}
                  <span class="ml-auto text-[11px] text-slate-400">{new Date(order.updatedAt).toLocaleString()}</span>
                </div>

                <div class="mt-3 grid gap-2 text-sm md:grid-cols-2">
                  <div><span class="text-slate-400">关联标识：</span>{sign?.code ?? "—"}</div>
                  <div><span class="text-slate-400">挂牌位置：</span>{order.location}</div>
                  <div><span class="text-slate-400">牌面尺寸：</span>{order.widthMm} × {order.heightMm} mm</div>
                  <div><span class="text-slate-400">牌面字号：</span>{order.fontSize} px（不缩字号）</div>
                </div>

                <div class="mt-3 rounded-lg bg-slate-50 p-3 text-xs">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="text-slate-500">登记译文版本：</span>
                    <span class={order.translationVersionId === null ? "font-bold text-warning" : "font-bold"}>{registeredLabel}</span>
                    <span class="text-slate-400">/</span>
                    <span class="text-slate-500">当前版本：</span>
                    <span class="font-bold">{currentLabel}</span>
                  </div>
                  {outcome && <div class={`mt-1 ${changed ? "font-bold text-error" : order.status === "mismatch" ? "font-bold text-warning" : "text-slate-500"}`}>{outcome.reason}</div>}
                  {capacity && (
                    <div class={`mt-1 ${capacity.fits ? "text-slate-500" : "font-bold text-error"}`}>
                      容量校核：{capacity.fits ? "牌面容量合适" : capacity.reason}
                    </div>
                  )}
                </div>

                <div class="mt-3 flex flex-wrap gap-2">
                  <button class="btn btn-xs btn-outline" onClick$={() => registerVersion(order.id)}>登记当前版本</button>
                  <button class="btn btn-xs btn-outline" onClick$={() => reprintOrder(order.id)}>退回重印</button>
                  {order.status === "posted" ? (
                    <button class="btn btn-xs btn-success" disabled>已挂牌{order.postedAt ? ` · ${new Date(order.postedAt).toLocaleString()}` : ""}</button>
                  ) : (
                    <button class="btn btn-xs btn-primary" onClick$={() => postOrder(order.id)} disabled={!capacity?.fits || order.status === "mismatch"}>挂牌</button>
                  )}
                  {order.saveState === "failed" && (
                    <button class="btn btn-xs btn-error" onClick$={() => saveWorkOrder(order.id)}>重试保存（仅本侧）</button>
                  )}
                </div>
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
});
