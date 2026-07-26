import { existsSync } from "node:fs";

export function resolveBenchmarkData(
  label: string,
  override: string | undefined,
  candidates: readonly string[],
): string {
  if (override) {
    if (!existsSync(override)) throw new Error(`${label} override does not exist: ${override}`);
    return override;
  }
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;
  throw new Error(
    `${label} data is unavailable. Checked:\n${candidates.map((path) => `- ${path}`).join("\n")}\n` +
      "Run npm run benchmark:setup or provide the documented environment override.",
  );
}
