import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgService } from "../../src/cli/service.ts";

async function withProject(
  run: (service: NmgService, projectDir: string) => void | Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "nmg-tessera-simhash-"));
  const service = new NmgService({ databasePath: join(root, "nmg.sqlite"), environment: {} });
  const projectDir = join(root, "project");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, "alpha.ts"),
    [
      "export const alpha = 1;",
      "// The indexing pipeline drains embedding batches.",
      "export function beta() { return alpha; }",
    ].join("\n"),
  );
  try {
    await run(service, projectDir);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("tessera simhash: write-time fingerprint stored and snippet relocates exactly", async () => {
  await withProject(async (service, projectDir) => {
    await service.invoke("remember", {
      statement: "alpha.ts pipeline drains batches",
      nodeName: "alpha pipeline",
      projectDir,
      tesserae: [
        {
          path: "alpha.ts",
          snippet: "The indexing pipeline drains embedding batches.",
          label: "pipeline note",
        },
      ],
    });
    const searched = await service.invoke("search", {
      query: "pipeline drains batches",
      projectDir,
    });
    const hit = searched.tesserae?.find((tessera: { path: string }) => tessera.path === "alpha.ts");
    assert.ok(hit, "tessera hit surfaces in search");
    assert.equal(hit.line, 2, "exact relocation resolves the current line");
    assert.ok(!hit.relocated, "exact hit is not marked relocated");
    assert.match(String(hit.fileSimhash ?? ""), /^[0-9a-f]{16}$/u, "write-time fingerprint stored");
  });
});

test("tessera simhash: snippet survives a small edit elsewhere in the file", async () => {
  await withProject(async (service, projectDir) => {
    await service.invoke("remember", {
      statement: "alpha.ts pipeline drains batches",
      nodeName: "alpha pipeline",
      projectDir,
      tesserae: [
        {
          path: "alpha.ts",
          snippet: "The indexing pipeline drains embedding batches.",
          label: "pipeline note",
        },
      ],
    });
    // Small edit in a DIFFERENT line: the snippet itself is untouched, so the
    // tessera resolves exactly (relocation is content-anchored, not line-based).
    writeFileSync(
      join(projectDir, "alpha.ts"),
      [
        "export const alpha = 1; // bumped",
        "// The indexing pipeline drains embedding batches.",
        "export function beta() { return alpha; }",
      ].join("\n"),
    );
    const searched = await service.invoke("search", {
      query: "pipeline drains batches",
      projectDir,
    });
    const hit = searched.tesserae?.find((tessera: { path: string }) => tessera.path === "alpha.ts");
    assert.ok(hit, "tessera hit still surfaces");
    assert.equal(hit.line, 2, "exact relocation survives the edit");
    assert.ok(!hit.relocated, "not relocated — the stored path still matches");
  });
});

test("tessera simhash: file moved elsewhere in the project is recovered", async () => {
  await withProject(async (service, projectDir) => {
    await service.invoke("remember", {
      statement: "alpha.ts pipeline drains batches",
      nodeName: "alpha pipeline",
      projectDir,
      tesserae: [
        {
          path: "alpha.ts",
          snippet: "The indexing pipeline drains embedding batches.",
          label: "pipeline note",
        },
      ],
    });
    // Move the file to a subdirectory with a tiny content touch.
    mkdirSync(join(projectDir, "lib"), { recursive: true });
    writeFileSync(
      join(projectDir, "lib", "alpha.ts"),
      [
        "export const alpha = 1;",
        "// The indexing pipeline drains embedding batches.",
        "export function beta() { return alpha; }",
      ].join("\n"),
    );
    // Remove the original so the stored path is gone.
    const { rmSync } = await import("node:fs");
    rmSync(join(projectDir, "alpha.ts"));
    const searched = await service.invoke("search", {
      query: "pipeline drains batches",
      projectDir,
    });
    const hit = searched.tesserae?.find(
      (tessera: { path: string }) => tessera.path === "lib/alpha.ts",
    );
    assert.ok(hit, "moved file tessera recovered at the new path");
    assert.equal(hit.line, 2);
    assert.ok(hit.relocated, "recovered hit is marked relocated");
  });
});

test("tessera simhash: unrelated content rewrite reports stale, not relocated", async () => {
  await withProject(async (service, projectDir) => {
    await service.invoke("remember", {
      statement: "alpha.ts pipeline drains batches",
      nodeName: "alpha pipeline",
      projectDir,
      tesserae: [
        {
          path: "alpha.ts",
          snippet: "The indexing pipeline drains embedding batches.",
          label: "pipeline note",
        },
      ],
    });
    // Full rewrite: unrelated document — must stay honestly stale.
    writeFileSync(
      join(projectDir, "alpha.ts"),
      [
        "import { z } from 'zod';",
        "export const schema = z.object({ id: z.string() });",
        "export type Row = z.infer<typeof schema>;",
      ].join("\n"),
    );
    const searched = await service.invoke("search", {
      query: "pipeline drains batches",
      projectDir,
    });
    const hit = searched.tesserae?.find((tessera: { path: string }) => tessera.path === "alpha.ts");
    assert.ok(hit, "tessera hit still surfaces");
    assert.equal(hit.line, undefined, "no line resolved");
    assert.ok(hit.stale, "honestly stale after unrelated rewrite");
  });
});
