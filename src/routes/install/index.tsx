import { $, component$, useSignal, useVisibleTask$ } from "@builder.io/qwik";
import { Link, type DocumentHead } from "@builder.io/qwik-city";
import { createSeedProject, STATUS_LABELS, uid } from "../../data";
import type { SignProject, WorkOrder, WorkOrderStatus } from "../../types";
import { diffText } from "../../utils";
import {
  createLegacyWorkOrders,
  createSeedWorkOrders,
  fitsPlate,
  migrateWorkOrders,
  plateLineCount,
  reconcileOrder,
  registerCurrentTranslation,
  TRANSLATION_SOURCE_LABELS,
  WORKORDER_SCHEMA,
  WORKORDER_STATUS_LABELS,
  WORKORDER_STORAGE_KEY,
  type ReconcileResult,
} from "../../workorders";

const PROJECT_STORAGE_KEY = "sologsb-1008-project-v1";
const STATUS_ORDER: WorkOrderStatus[] = ["printing", "to_install", "installed", "reprint", "queued", "done"];

export const head: DocumentHead = {
  title: "市政施工队 · 挂牌工单台",
  meta: [{ name: "description", content: "安装工单、牌面尺寸、挂牌位置与挂牌前译文版本对账" }],
};

function statusBadge(status: WorkOrderStatus) {
  if (status === "done") return "badge-success";
  if (status === "reprint") return "badge-error";
  if (status === "queued") return "badge-warning";
  if (status === "installed") return "badge-info";
  if (status === "to_install") return "badge-secondary";
  return "badge-neutral";
}

const RECONCILE_TOAST: Record<ReconcileResult, string> = {
  completed: "对账一致，挂牌完成",
  verified: "对账一致",
  changed: "译文已变更，工单退回重印",
  overflow: "牌面容量不足，排队等重印",
  skipped: "无法对账：译文版本待核对",
};

export default component$(() => {
  const project = useSignal<SignProject>(createSeedProject());
  const orders = useSignal<WorkOrder[]>([]);
  const hydrated = useSignal(false);
  const saveState = useSignal<"saved" | "pending" | "failed">("saved");
  const simulateFailure = useSignal(false);
  const toast = useSignal("");
  const showCreate = useSignal(false);
  const formSignId = useSignal("");
  const formLocation = useSignal("");
  const formWidth = useSignal(480);
  const formLines = useSignal(3);
  const formFont = useSignal(42);

  const signOf = (order: WorkOrder) => project.value.signs.find((sign) => sign.id === order.signId);
  const formSign = () => project.value.signs.find((sign) => sign.id === formSignId.value) ?? project.value.signs[0];
  const stats = () => STATUS_ORDER.map((status) => ({ status, count: orders.value.filter((order) => order.status === status).length }));

  /** 只写施工队自己的存储；失败时只重试本侧，服务中心那份照旧。 */
  const persist = $(() => {
    if (!hydrated.value) return;
    if (simulateFailure.value) {
      saveState.value = "failed";
      return;
    }
    try {
      localStorage.setItem(
        WORKORDER_STORAGE_KEY,
        JSON.stringify({ schema: WORKORDER_SCHEMA, orders: orders.value, updatedAt: new Date().toISOString() }),
      );
      saveState.value = "saved";
    } catch {
      saveState.value = "failed";
    }
  });

  const mutate = $((update: (draft: WorkOrder[]) => void) => {
    const draft = structuredClone(orders.value);
    update(draft);
    orders.value = draft;
  });

  const createOrder = $(() => {
    const sign = formSign();
    if (!sign) return;
    const now = new Date().toISOString();
    const order: WorkOrder = {
      id: uid("wo"),
      code: `WO-${1000 + orders.value.length + 1}`,
      signId: sign.id,
      location: formLocation.value.trim() || sign.scenario,
      plateWidth: formWidth.value,
      plateLines: formLines.value,
      fontSize: formFont.value,
      status: "printing",
      translation: registerCurrentTranslation(sign),
      pendingVerification: false,
      audit: [{ id: uid("audit"), at: now, action: "创建工单", detail: "按服务中心当前译文登记版本" }],
      createdAt: now,
      updatedAt: now,
    };
    if (!fitsPlate(order, order.translation!.text)) {
      order.status = "queued";
      order.audit.unshift({
        id: uid("audit"),
        at: now,
        action: "排队重印",
        detail: `牌面容量不足：预计 ${plateLineCount(order.translation!.text, order)} 行，容量 ${order.plateLines} 行；不缩字号，排队等重印`,
      });
    }
    mutate((draft) => {
      draft.unshift(order);
    });
    showCreate.value = false;
    formLocation.value = "";
    toast.value = `工单 ${order.code} 已创建${order.status === "queued" ? "，容量不足排队等重印" : ""}`;
  });

  const reconcileOne = $((id: string) => {
    mutate((draft) => {
      const order = draft.find((item) => item.id === id);
      if (!order) return;
      const sign = project.value.signs.find((item) => item.id === order.signId);
      const result = reconcileOrder(order, sign);
      order.updatedAt = new Date().toISOString();
      toast.value = `${order.code}：${RECONCILE_TOAST[result]}`;
    });
  });

  const reconcileAll = $(() => {
    mutate((draft) => {
      const tally: Record<ReconcileResult, number> = { completed: 0, verified: 0, changed: 0, overflow: 0, skipped: 0 };
      for (const order of draft) {
        const sign = project.value.signs.find((item) => item.id === order.signId);
        tally[reconcileOrder(order, sign)] += 1;
        order.updatedAt = new Date().toISOString();
      }
      toast.value = `对账完成：退回重印 ${tally.changed} · 排队重印 ${tally.overflow} · 挂牌完成 ${tally.completed} · 一致 ${tally.verified} · 待核对 ${tally.skipped}`;
    });
  });

  const advance = $((id: string, next: WorkOrderStatus, note: string) => {
    mutate((draft) => {
      const order = draft.find((item) => item.id === id);
      if (!order) return;
      order.status = next;
      order.updatedAt = new Date().toISOString();
      order.audit.unshift({ id: uid("audit"), at: order.updatedAt, action: "状态推进", detail: note });
    });
  });

  /** 退回重印 / 待核对时，按服务中心当前译文重新登记版本并重新排印。 */
  const registerCurrent = $((id: string, source: "current" | "manual") => {
    mutate((draft) => {
      const order = draft.find((item) => item.id === id);
      const sign = order ? project.value.signs.find((item) => item.id === order.signId) : undefined;
      if (!order || !sign) return;
      order.translation = registerCurrentTranslation(sign, source);
      order.pendingVerification = false;
      order.updatedAt = new Date().toISOString();
      const action = source === "manual" ? "人工核对" : "重新登记";
      if (!fitsPlate(order, order.translation.text)) {
        order.status = "queued";
        order.audit.unshift({ id: uid("audit"), at: order.updatedAt, action, detail: "已按当前译文登记；牌面容量不足，排队等重印（不缩字号）" });
      } else {
        order.status = "printing";
        order.audit.unshift({ id: uid("audit"), at: order.updatedAt, action, detail: "已按当前译文登记版本，安排重印" });
      }
      toast.value = `${order.code} 已按当前译文登记`;
    });
  });

  const updatePlate = $((id: string, field: "plateWidth" | "plateLines" | "fontSize", value: number) => {
    if (!Number.isFinite(value) || value <= 0) return;
    mutate((draft) => {
      const order = draft.find((item) => item.id === id);
      if (!order) return;
      order[field] = Math.round(value);
      order.updatedAt = new Date().toISOString();
      if (order.status === "queued" && order.translation && fitsPlate(order, order.translation.text)) {
        order.status = "printing";
        order.audit.unshift({ id: uid("audit"), at: order.updatedAt, action: "重新排印", detail: "牌面调整后容量足够，重新排印" });
      }
    });
  });

  const updateLocation = $((id: string, location: string) => {
    mutate((draft) => {
      const order = draft.find((item) => item.id === id);
      if (!order) return;
      order.location = location;
      order.updatedAt = new Date().toISOString();
    });
  });

  const importLegacy = $(() => {
    const existing = new Set(orders.value.map((order) => order.code));
    const legacy = createLegacyWorkOrders().filter((order) => !existing.has(order.code ?? ""));
    if (!legacy.length) {
      toast.value = "旧版工单样例已全部导入";
      return;
    }
    const migrated = migrateWorkOrders(legacy, project.value).orders;
    mutate((draft) => {
      draft.push(...migrated);
    });
    const pending = migrated.filter((order) => order.pendingVerification).length;
    toast.value = `已导入 ${migrated.length} 张旧工单：${migrated.length - pending} 张按当时快照补录，${pending} 张待核对`;
  });

  useVisibleTask$(({ track }) => {
    track(() => hydrated.value);
    if (hydrated.value) return;
    try {
      const storedProject = JSON.parse(localStorage.getItem(PROJECT_STORAGE_KEY) ?? "") as { schema: number; project: SignProject };
      if (storedProject.schema === 1 && storedProject.project?.signs?.length) project.value = storedProject.project;
    } catch {
      // 服务中心数据不可用时使用内置示例，本页只读引用，不写回。
    }
    try {
      const raw = localStorage.getItem(WORKORDER_STORAGE_KEY);
      if (raw) {
        const result = migrateWorkOrders(JSON.parse(raw), project.value);
        orders.value = result.orders;
        if (result.migrated) toast.value = "旧工单已升级：译文版本按当时快照补录，对不上的标记待核对";
      } else {
        orders.value = createSeedWorkOrders();
      }
    } catch {
      orders.value = createSeedWorkOrders();
    }
    hydrated.value = true;
  });

  useVisibleTask$(({ track, cleanup }) => {
    track(() => hydrated.value);
    if (!hydrated.value) return;
    track(() => orders.value);
    track(() => simulateFailure.value);
    saveState.value = "pending";
    const timer = window.setTimeout(() => persist(), 450);
    cleanup(() => window.clearTimeout(timer));
  });

  return (
    <div data-theme="corporate" class="min-h-screen bg-slate-100 pb-10 text-slate-800">
      <header class="navbar sticky top-0 z-40 min-h-16 border-b border-amber-900 bg-[#5c3d12] px-5 text-white shadow-lg">
        <div class="navbar-start gap-3">
          <div class="grid h-10 w-10 place-items-center rounded-xl border border-white/20 bg-white/10 font-black">施</div>
          <div>
            <div class="text-xs uppercase tracking-[0.2em] text-amber-200">Municipal Crew</div>
            <div class="font-bold">市政施工队 · 挂牌工单台</div>
          </div>
        </div>
        <div class="navbar-end gap-3">
          <span class={`badge badge-outline ${saveState.value === "failed" ? "badge-error" : saveState.value === "pending" ? "badge-warning" : "badge-success"}`}>
            {saveState.value === "failed" ? "本侧保存失败" : saveState.value === "pending" ? "保存中…" : "本侧已保存"}
          </span>
          <label class="flex cursor-pointer items-center gap-1 text-xs text-amber-100">
            <input type="checkbox" class="toggle toggle-xs" checked={simulateFailure.value} onChange$={(_, element) => (simulateFailure.value = element.checked)} />
            模拟存储故障
          </label>
          <Link href="/" class="btn btn-ghost btn-sm">← 语言服务中心</Link>
        </div>
      </header>

      {saveState.value === "failed" && (
        <div class="alert alert-error sticky top-16 z-30 flex rounded-none border-x-0 py-2 text-white">
          <span class="flex-1">施工队侧保存失败：只影响本侧，服务中心那份照旧。修好存储后重试本侧即可。</span>
          <button class="btn btn-xs btn-outline text-white" onClick$={persist}>重试本侧保存</button>
        </div>
      )}

      <div class="mx-auto max-w-6xl space-y-4 p-5">
        <section class="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-4 shadow-sm">
          {stats().map(({ status, count }) => (
            <span key={status} class={`badge badge-lg gap-1 ${statusBadge(status)}`}>
              {WORKORDER_STATUS_LABELS[status]} {count}
            </span>
          ))}
          <div class="ml-auto flex flex-wrap gap-2">
            <button class="btn btn-sm btn-primary" onClick$={reconcileAll}>挂牌前对账（全部）</button>
            <button class="btn btn-sm btn-outline" onClick$={() => (showCreate.value = !showCreate.value)}>{showCreate.value ? "收起" : "新建工单"}</button>
            <button class="btn btn-sm btn-outline" onClick$={importLegacy}>导入旧版工单（模拟升级）</button>
          </div>
        </section>

        {showCreate.value && (
          <section class="rounded-2xl bg-white p-4 shadow-sm">
            <h2 class="font-bold">新建安装工单</h2>
            <p class="text-xs text-slate-500">创建时按服务中心当前译文登记版本；牌面放不下的排队等重印，不缩字号。</p>
            <div class="mt-3 grid gap-3 md:grid-cols-5">
              <label class="form-control">
                <span class="label-text mb-1 text-xs font-bold text-slate-500">标识</span>
                <select class="select select-sm select-bordered" value={formSignId.value || formSign()?.id} onChange$={(_, element) => (formSignId.value = element.value)}>
                  {project.value.signs.map((sign) => (
                    <option key={sign.id} value={sign.id}>{`${sign.code} · ${sign.scenario}`}</option>
                  ))}
                </select>
              </label>
              <label class="form-control">
                <span class="label-text mb-1 text-xs font-bold text-slate-500">挂牌位置</span>
                <input class="input input-sm input-bordered" placeholder="默认取适用场景" value={formLocation.value} onInput$={(_, element) => (formLocation.value = element.value)} />
              </label>
              <label class="form-control">
                <span class="label-text mb-1 text-xs font-bold text-slate-500">牌面宽度 px</span>
                <input type="number" min="120" class="input input-sm input-bordered" value={formWidth.value} onInput$={(_, element) => (formWidth.value = Number(element.value))} />
              </label>
              <label class="form-control">
                <span class="label-text mb-1 text-xs font-bold text-slate-500">容量行数</span>
                <input type="number" min="1" class="input input-sm input-bordered" value={formLines.value} onInput$={(_, element) => (formLines.value = Number(element.value))} />
              </label>
              <label class="form-control">
                <span class="label-text mb-1 text-xs font-bold text-slate-500">字号 px（固定）</span>
                <input type="number" min="12" class="input input-sm input-bordered" value={formFont.value} onInput$={(_, element) => (formFont.value = Number(element.value))} />
              </label>
            </div>
            {formSign() && (
              <div class="mt-3 flex flex-wrap items-center gap-3 text-xs">
                <span class="text-slate-500">{formSign().targetLanguage} · 审校状态：{STATUS_LABELS[formSign().status]}</span>
                <span class={plateLineCount(formSign().targetText, { plateWidth: formWidth.value, fontSize: formFont.value }) <= formLines.value ? "font-bold text-success" : "font-bold text-error"}>
                  预计 {plateLineCount(formSign().targetText, { plateWidth: formWidth.value, fontSize: formFont.value })} 行 / 容量 {formLines.value} 行
                  {plateLineCount(formSign().targetText, { plateWidth: formWidth.value, fontSize: formFont.value }) <= formLines.value ? "，放得下" : "，放不下，将排队等重印"}
                </span>
                <button class="btn btn-sm btn-primary ml-auto" onClick$={createOrder}>创建工单</button>
              </div>
            )}
          </section>
        )}

        <section class="grid gap-4 lg:grid-cols-2">
          {orders.value.length === 0 && <div class="rounded-2xl border border-dashed bg-white p-10 text-center text-sm text-slate-400">还没有安装工单。</div>}
          {orders.value.map((order) => {
            const sign = signOf(order);
            const changed = Boolean(sign && order.translation && order.translation.text !== sign.targetText);
            const needed = order.translation ? plateLineCount(order.translation.text, order) : 0;
            const fits = order.translation ? fitsPlate(order, order.translation.text) : false;
            return (
              <article key={order.id} class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div class="flex items-center justify-between gap-2">
                  <span class="font-mono text-sm font-bold">{order.code}</span>
                  <div class="flex gap-1">
                    {order.pendingVerification && <span class="badge badge-warning">待核对</span>}
                    <span class={`badge ${statusBadge(order.status)}`}>{WORKORDER_STATUS_LABELS[order.status]}</span>
                  </div>
                </div>

                <div class="mt-2 text-sm">
                  {sign ? (
                    <span><strong>{sign.code}</strong> · {sign.scenario} · {sign.targetLanguage} · 审校状态 {STATUS_LABELS[sign.status]}</span>
                  ) : (
                    <span class="text-error">服务中心记录缺失（{order.signId}）</span>
                  )}
                </div>

                <label class="form-control mt-2">
                  <span class="label-text mb-1 text-xs font-bold text-slate-500">挂牌位置</span>
                  <input class="input input-sm input-bordered" value={order.location} onInput$={(_, element) => updateLocation(order.id, element.value)} />
                </label>

                <div class="mt-2 grid grid-cols-3 gap-2">
                  <label class="form-control">
                    <span class="label-text mb-1 text-xs font-bold text-slate-500">牌面宽度 px</span>
                    <input type="number" min="120" class="input input-sm input-bordered" value={order.plateWidth} onInput$={(_, element) => updatePlate(order.id, "plateWidth", Number(element.value))} />
                  </label>
                  <label class="form-control">
                    <span class="label-text mb-1 text-xs font-bold text-slate-500">容量行数</span>
                    <input type="number" min="1" class="input input-sm input-bordered" value={order.plateLines} onInput$={(_, element) => updatePlate(order.id, "plateLines", Number(element.value))} />
                  </label>
                  <label class="form-control">
                    <span class="label-text mb-1 text-xs font-bold text-slate-500">字号 px（固定）</span>
                    <input type="number" min="12" class="input input-sm input-bordered" value={order.fontSize} onInput$={(_, element) => updatePlate(order.id, "fontSize", Number(element.value))} />
                  </label>
                </div>
                <div class={`mt-1 text-xs ${fits ? "text-success" : "font-bold text-error"}`}>
                  {order.translation ? `登记译文预计 ${needed} 行 / 容量 ${order.plateLines} 行${fits ? "，放得下" : "，放不下：排队等重印，不缩字号"}` : "未登记译文版本"}
                </div>

                <div class="mt-3 rounded-xl bg-slate-50 p-3 text-xs">
                  {order.translation ? (
                    <>
                      <div class="flex flex-wrap items-center gap-2">
                        <span class="font-bold">登记译文版本：{order.translation.versionLabel}</span>
                        <span class="badge badge-ghost badge-sm">{TRANSLATION_SOURCE_LABELS[order.translation.source]}</span>
                        <span class="text-slate-400">登记于 {new Date(order.translation.capturedAt).toLocaleString()}</span>
                      </div>
                      {changed && sign && (
                        <div class="mt-2">
                          <div class="font-bold text-error">服务中心译文已变更（登记版 → 当前版）：</div>
                          <div class="mt-1 rounded-lg bg-slate-900 p-2 leading-6 text-slate-100">
                            {diffText(order.translation.text, sign.targetText).map((token, index) => (
                              <span key={index} class={token.type === "add" ? "rounded bg-green-400/25 text-green-200" : token.type === "remove" ? "bg-red-400/25 text-red-200 line-through" : ""}>{token.value}</span>
                            ))}
                          </div>
                        </div>
                      )}
                      {!changed && sign && <div class="mt-1 text-success">与服务中心当前译文一致</div>}
                    </>
                  ) : (
                    <div class="font-bold text-warning">旧工单未登记译文版本{order.pendingVerification ? "，对不上当时快照，待人工核对" : ""}</div>
                  )}
                </div>

                <div class="mt-3 flex flex-wrap items-center gap-2">
                  {order.status !== "done" && !order.pendingVerification && order.translation && (
                    <button class="btn btn-xs btn-primary" onClick$={() => reconcileOne(order.id)}>对账</button>
                  )}
                  {order.status === "printing" && (
                    <button class="btn btn-xs btn-outline" onClick$={() => advance(order.id, "to_install", "印制完成，待现场挂牌")}>印制完成</button>
                  )}
                  {order.status === "to_install" && (
                    <button class="btn btn-xs btn-outline" onClick$={() => advance(order.id, "installed", "现场已挂牌，待对账确认完成")}>现场挂牌</button>
                  )}
                  {(order.status === "reprint" || order.status === "queued") && (
                    <button class="btn btn-xs btn-outline" onClick$={() => registerCurrent(order.id, "current")}>按当前译文登记重印</button>
                  )}
                  {order.pendingVerification && (
                    <button class="btn btn-xs btn-warning" onClick$={() => registerCurrent(order.id, "manual")}>核对并登记当前译文</button>
                  )}
                  {order.status === "installed" && <span class="text-xs text-slate-400">已挂牌≠完成，须对账一致才算完成</span>}
                  {order.status === "queued" && <span class="text-xs text-slate-400">加大牌面容量后自动重新排印</span>}
                  {order.status === "done" && changed && <span class="text-xs font-bold text-warning">服务中心译文已有新版本，如需更新请新建工单</span>}
                </div>

                <div class="mt-3 border-t border-slate-100 pt-2">
                  <div class="text-xs font-bold text-slate-400">工单记录</div>
                  <ul class="mt-1 space-y-1 text-xs text-slate-500">
                    {order.audit.slice(0, 3).map((entry) => (
                      <li key={entry.id}>
                        <span class="font-mono">{entry.at.slice(5, 16).replace("T", " ")}</span> <strong>{entry.action}</strong>：{entry.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              </article>
            );
          })}
        </section>

        <p class="text-center text-xs text-slate-400">
          服务中心译文与施工队工单各记一份：本页只读引用服务中心数据，工单保存在本侧存储（{WORKORDER_STORAGE_KEY}），互不回写。
        </p>
      </div>

      {toast.value && <div class="toast toast-end z-50"><div class="alert alert-success"><span>{toast.value}</span></div></div>}
    </div>
  );
});
