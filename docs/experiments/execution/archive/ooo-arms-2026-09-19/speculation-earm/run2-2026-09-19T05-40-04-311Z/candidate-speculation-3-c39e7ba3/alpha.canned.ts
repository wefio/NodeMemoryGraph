/**
 * The reference answer for the alpha unit, used by the canned worker: the instrument has to show the
 * task family accepts a correct submission before a model is paid to produce one.
 */
import type { Section } from "./interface.ts";

export function alphaSection(rows: readonly string[]): Section {
  return {
    id: "alpha",
    title: "Alpha",
    lines: rows.filter((row) => row !== "").slice().sort(),
  };
}
