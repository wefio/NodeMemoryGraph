/**
 * NMG Console commands for the OpenCode CLI/TUI (v2 client plugin contract).
 *
 * Loaded separately from the service-side adapter: put `"./tui"` (this file's
 * package export) into the client's `plugins` config, or drop this package
 * directory into the global plugin directory where the client also scans
 * `package.json` exports. Everything here is deliberately defensive: client
 * plugin APIs (keymap/dialog/toast) vary between OpenCode builds, so every
 * registration is feature-tested and failures degrade to a silent no-op
 * instead of breaking TUI startup.
 *
 * Scope: global-only controls persisted into <dataDir>/board-wake.json
 * (wake on/off, budget, cooldown, interval, world broadcast). Per-session
 * actions (recall reads, board boards, memory writes) belong to the agent
 * conversation — this console intentionally does not touch "the current
 * session", because client plugins cannot bind to a service-side session.
 */
import {
  readWakeConfig,
  writeWakeConfig,
  type BoardWakeConfig,
} from "../src/integration/board-wake.ts";
import { resolveNmgDataDir } from "../src/cli/data-path.ts";

interface ConsoleContext {
  keymap?: {
    layer?: (factory: () => unknown) => unknown;
  };
  ui?: {
    dialog?: {
      select?: (input: {
        title: string;
        options: string[];
        [key: string]: unknown;
      }) => Promise<unknown>;
    };
    toast?: {
      show?: (input: { message: string; variant?: string; [key: string]: unknown }) => unknown;
    };
  };
}

function toast(context: ConsoleContext, message: string, variant = "info"): void {
  try {
    context.ui?.toast?.show?.({ message, variant });
  } catch {
    // Best-effort surface feedback only.
  }
}

function notify(context: ConsoleContext, message: string, variant?: string): void {
  toast(context, message, variant);
}

function wakeSummary(config: BoardWakeConfig): string {
  const budgetText = config.budget === 0 ? "不限制" : `${config.budget}/天`;
  const cooldownText =
    config.cooldownMs === 0 ? "无" : `${Math.round(config.cooldownMs / 60_000)} 分`;
  return `唤醒 ${config.enabled ? "开" : "关"} · 预算 ${budgetText} · 冷却 ${cooldownText} · 轮询 ${Math.round(
    config.intervalMs / 1_000,
  )} 秒 · 世界广播 ${config.worldBroadcast ? "开" : "关"}`;
}

async function choose(
  context: ConsoleContext,
  title: string,
  options: readonly string[],
): Promise<string | null> {
  const dialog = context.ui?.dialog?.select;
  if (typeof dialog !== "function") return null;
  try {
    const picked = await dialog({ title, options: [...options] });
    if (typeof picked === "number") return options[picked] ?? null;
    if (typeof picked === "string") return options.includes(picked) ? picked : null;
    return null;
  } catch {
    return null;
  }
}

async function wakeToggle(context: ConsoleContext, dataDir: string): Promise<void> {
  const current = readWakeConfig(dataDir);
  const picked = await choose(context, "黑板唤醒", ["开启", "关闭"]);
  if (!picked) return;
  writeWakeConfig({ ...current, enabled: picked === "开启" }, dataDir);
  notify(context, picked === "开启" ? "黑板唤醒已开启" : "黑板唤醒已关闭");
}

async function wakeWorld(context: ConsoleContext, dataDir: string): Promise<void> {
  const current = readWakeConfig(dataDir);
  const picked = await choose(context, "世界频道协作广播", ["开启", "关闭"]);
  if (!picked) return;
  writeWakeConfig({ ...current, worldBroadcast: picked === "开启" }, dataDir);
  notify(
    context,
    picked === "开启"
      ? "已开启世界频道协作广播：协作类新条目会同时发到世界频道拉其他 agent"
      : "已关闭世界频道协作广播",
  );
}

async function wakeBudget(context: ConsoleContext, dataDir: string): Promise<void> {
  const current = readWakeConfig(dataDir);
  const picked = await choose(context, "每日唤醒上限", ["不限制", "3/天", "8/天", "15/天"]);
  if (!picked) return;
  const budget = picked === "不限制" ? 0 : Number(picked.split("/")[0]);
  writeWakeConfig({ ...current, budget }, dataDir);
  notify(context, `黑板唤醒预算已设为 ${budget === 0 ? "不限制" : `${budget}/天`}`);
}

async function wakeCooldown(context: ConsoleContext, dataDir: string): Promise<void> {
  const current = readWakeConfig(dataDir);
  const picked = await choose(context, "唤醒冷却", ["无", "10 分钟", "30 分钟", "1 小时"]);
  if (!picked) return;
  const cooldownMs =
    picked === "无"
      ? 0
      : picked === "10 分钟"
        ? 600_000
        : picked === "30 分钟"
          ? 1_800_000
          : 3_600_000;
  writeWakeConfig({ ...current, cooldownMs }, dataDir);
  notify(
    context,
    `黑板唤醒冷却已设为 ${cooldownMs === 0 ? "无" : `${Math.round(cooldownMs / 60_000)} 分钟`}`,
  );
}

async function wakeInterval(context: ConsoleContext, dataDir: string): Promise<void> {
  const current = readWakeConfig(dataDir);
  const picked = await choose(context, "唤醒轮询", ["5 秒", "30 秒", "60 秒", "5 分钟"]);
  if (!picked) return;
  const intervalMs =
    picked === "5 秒" ? 5_000 : picked === "30 秒" ? 30_000 : picked === "60 秒" ? 60_000 : 300_000;
  writeWakeConfig({ ...current, intervalMs }, dataDir);
  notify(context, `黑板唤醒轮询已设为 ${Math.round(intervalMs / 1_000)} 秒`);
}

async function runConsole(context: ConsoleContext, dataDir: string): Promise<void> {
  const current = readWakeConfig(dataDir);
  const picked = await choose(context, "NMG 控制台", [
    `唤醒：开启/关闭（当前 ${current.enabled ? "开" : "关"}）`,
    `唤醒：世界广播（当前 ${current.worldBroadcast ? "开" : "关"}）`,
    `唤醒：每日预算（当前 ${current.budget === 0 ? "不限制" : `${current.budget}/天`}）`,
    `唤醒：冷却（当前 ${current.cooldownMs === 0 ? "无" : `${Math.round(current.cooldownMs / 60_000)} 分`}）`,
    `唤醒：轮询（当前 ${Math.round(current.intervalMs / 1_000)} 秒）`,
    "唤醒：查看状态",
  ]);
  if (!picked) return;
  if (picked.startsWith("唤醒：开启/关闭")) return void wakeToggle(context, dataDir);
  if (picked.startsWith("唤醒：世界广播")) return void wakeWorld(context, dataDir);
  if (picked.startsWith("唤醒：每日预算")) return void wakeBudget(context, dataDir);
  if (picked.startsWith("唤醒：冷却")) return void wakeCooldown(context, dataDir);
  if (picked.startsWith("唤醒：轮询")) return void wakeInterval(context, dataDir);
  notify(context, `NMG · ${wakeSummary(readWakeConfig(dataDir))}`);
}

/** OpenCode v2 client plugin: `export default { id, setup }`. */
export default {
  id: "nmg-console",
  setup: (clientContext: ConsoleContext): undefined => {
    try {
      const dataDir = resolveNmgDataDir();
      const layer = clientContext.keymap?.layer;
      if (typeof layer !== "function") return;
      layer.call(clientContext.keymap, () => ({
        mode: "global",
        commands: [
          {
            id: "nmg.console",
            title: "NMG 控制台",
            palette: true,
            slash: { name: "nmg", arguments: "" },
            run: () => {
              void runConsole(clientContext, dataDir);
            },
          },
        ],
        bindings: [],
      }));
      notify(clientContext, "NMG 控制台已加载（/nmg）");
    } catch {
      // A client plugin must never break TUI startup.
    }
    return undefined;
  },
};
