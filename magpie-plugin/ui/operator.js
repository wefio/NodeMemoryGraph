/* global window, document, parent, addEventListener */
(() => {
  let revision = 0;
  let period = "today";
  let pending = false;
  let nextBridgeId = 0;
  const bridgeCalls = new Map();
  const token = globalThis.NMG_OPERATOR_TOKEN;
  delete globalThis.NMG_OPERATOR_TOKEN;
  const byId = (id) => document.getElementById(id);
  const number = (value) => (Number.isFinite(value) ? new Intl.NumberFormat().format(value) : "—");
  const message = (text, error = false) => {
    byId("message").textContent = text;
    byId("message").dataset.error = String(error);
  };

  function bridge(method, params) {
    if (parent === window) return Promise.reject(new Error("当前页面未连接 Magpie 窗口"));
    const id = ++nextBridgeId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        bridgeCalls.delete(id);
        reject(new Error("Magpie 用量接口暂不可用"));
      }, 2000);
      bridgeCalls.set(id, { resolve, reject, timer });
      parent.postMessage({ magpie: 1, id, method, params }, "*");
    });
  }

  function theme(value) {
    if (!value) return;
    document.documentElement.style.colorScheme = value.dark ? "dark" : "light";
    for (const [key, entry] of Object.entries(value.tokens ?? {}))
      document.documentElement.style.setProperty(`--magpie-${key}`, entry);
  }

  addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.magpie !== 1) return;
    const value = event.data;
    if (value.event === "theme") {
      theme(value.data);
      return;
    }
    const call = bridgeCalls.get(value.id);
    if (!call) return;
    clearTimeout(call.timer);
    bridgeCalls.delete(value.id);
    if (value.error) call.reject(new Error(value.error));
    else call.resolve(value.result);
  });

  async function api(path, payload) {
    const response = await fetch(path, {
      method: payload ? "POST" : "GET",
      headers: { "content-type": "application/json", "x-nmg-operator": token },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "记忆服务请求失败");
    return result;
  }

  function activity(rows) {
    const grouped = new Map();
    for (const row of rows ?? []) {
      const key = `${row.day}/${row.kind}`;
      const entry = grouped.get(key) ?? {
        day: row.day,
        kind: row.kind,
        success: 0,
        empty: 0,
        failure: 0,
      };
      entry[row.outcome] = row.count;
      grouped.set(key, entry);
    }
    const body = byId("activity");
    body.replaceChildren();
    for (const row of grouped.values()) {
      const line = document.createElement("tr");
      for (const value of [
        row.day,
        row.kind === "automaticRecall" ? "自动召回" : "主动搜索",
        number(row.success),
        number(row.empty),
        number(row.failure),
      ]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        line.appendChild(cell);
      }
      body.appendChild(line);
    }
    if (!grouped.size) {
      const row = body.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 5;
      cell.textContent = "当前统计期尚无搜索记录";
    }
  }

  function embeddingUsage(rows) {
    const body = byId("embedding-usage");
    body.replaceChildren();
    if (!rows?.length) {
      const cell = body.insertRow().insertCell();
      cell.colSpan = 6;
      cell.textContent = rows ? "当前统计期尚无向量请求" : "当前 daemon 尚未提供向量用量";
      return;
    }
    const latency = (ms) => (Number.isFinite(ms) ? `${number(Math.round(ms))} ms` : "—");
    for (const row of rows) {
      const line = body.insertRow();
      for (const value of [
        `${row.provider} / ${row.model}`,
        number(row.requests),
        number(row.failed),
        number(row.cancelled),
        latency(row.averageMs),
        latency(row.maxMs),
      ])
        line.insertCell().textContent = value;
    }
  }

  async function usage() {
    try {
      const value = await bridge("read", { name: "usage:summary", params: { period } });
      byId("gateway-usage").textContent =
        `请求 ${number(value.calls)} · 输入 ${number(value.input)} token · 输出 ${number(value.output)} token · 缓存读取 ${number(value.cacheRead)} token`;
    } catch (error) {
      byId("gateway-usage").textContent = error.message;
    }
  }

  function renderConfiguration(config, embedding) {
    byId("current-model").textContent = config.active
      ? `${config.active.provider} / ${config.active.model}`
      : embedding.provider
        ? `${embedding.provider} · ${embedding.indexId ?? "索引尚未准备"}`
        : "当前使用词法检索";
    byId("config-source").textContent =
      config.source === "managed"
        ? `配置来源：NMG 托管设置 · key ${config.active?.keyConfigured ? "已配置" : "未配置"}`
        : "配置来源：daemon 启动环境";
    byId("candidate-actions").hidden = !config.candidate;
    byId("job").textContent = config.job
      ? `候选索引 ${{ running: "构建中", ready: "已就绪", failed: "构建失败", cancelled: "已取消" }[config.job.state]}`
      : config.candidate
        ? `候选 ${config.candidate.provider} / ${config.candidate.model}`
        : "";
    for (const button of document.querySelectorAll("[data-action]"))
      button.disabled =
        config.job?.state === "running" && button.dataset.action !== "cancelCandidate";
  }

  async function refresh() {
    if (pending) return;
    pending = true;
    byId("refresh").disabled = true;
    try {
      const { status, metrics } = await api("api/snapshot");
      const config = metrics.configuration;
      revision = config.revision;
      byId("health").textContent = "记忆服务已连接";
      byId("store").textContent =
        `${metrics.counts?.backend ?? "未知后端"} · ${metrics.counts?.namespace ?? "未知命名空间"}`;
      byId("memories").textContent = number(metrics.counts?.memories);
      byId("nodes").textContent = number(metrics.counts?.nodes);
      byId("vectors").textContent = number(status.embedding.health?.indexed?.records);
      byId("bytes").textContent = Number.isFinite(status.storage.bytes)
        ? `${number(Math.round(status.storage.bytes / 1024))} KiB`
        : "—";
      renderConfiguration(config, status.embedding);
      activity(metrics.activity);
      embeddingUsage(metrics.embeddingUsage);
      byId("updated").textContent = `快照时间 ${new Date(metrics.measuredAt).toLocaleString()}`;
      message("");
    } catch (error) {
      byId("health").textContent = "记忆服务不可用";
      message(error.message, true);
    } finally {
      pending = false;
      byId("refresh").disabled = false;
    }
  }

  async function operation(action, extra = {}) {
    try {
      const result = await api("api/operator", { action, revision, ...extra });
      await refresh();
      message(
        action === "testCandidate" ? `连接成功 · ${number(result.dimensions)} 维` : "设置已更新",
      );
    } catch (error) {
      message(error.message, true);
    }
  }

  byId("refresh").addEventListener("click", () => {
    void refresh();
    void usage();
  });
  byId("edit-model").addEventListener("click", () => {
    byId("model-form").hidden = !byId("model-form").hidden;
  });
  for (const button of document.querySelectorAll("[data-action]"))
    button.addEventListener("click", () => {
      void operation(button.dataset.action, {
        useManaged: button.dataset.action === "activateCandidate",
      });
    });
  for (const button of document.querySelectorAll(".period"))
    button.addEventListener("click", () => {
      period = button.dataset.period;
      for (const other of document.querySelectorAll(".period"))
        other.setAttribute("aria-pressed", String(other === button));
      void usage();
    });
  byId("save-model").addEventListener("click", () => {
    const form = byId("model-form");
    if (!form.reportValidity()) return;
    const data = Object.fromEntries(new FormData(form));
    const config = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== ""));
    if (config.dimensions) config.dimensions = Number(config.dimensions);
    void operation("saveCandidate", { config }).finally(() => {
      form.elements.apiKey.value = "";
    });
  });
  void bridge("hello")
    .then(theme)
    .then(usage)
    .catch(() => {
      byId("gateway-usage").textContent = "Magpie 网关用量不可用";
    });
  void refresh();
  setInterval(() => {
    if (!document.hidden) void refresh();
  }, 5000);
})();
