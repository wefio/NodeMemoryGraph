// normalizePath(path) normalizes a POSIX-style path.
// This stage covers paths built from ordinary segments separated by single slashes. The remaining
// cases of the contract arrive with the next handoff.
//
// In-scope grammar: ordinary segments (excluding the special segments "." and "..") joined by
// exactly one '/' between them, with no leading or trailing '/'. For such input the normalized
// form is identical to the input, since there is nothing to collapse.
export function normalizePath(path: string): string {
  // Reject anything outside this stage's grammar so later handoffs own those cases.
  if (path.length === 0) {
    throw new Error("normalizePath: out of scope (empty path)");
  }
  if (path.startsWith("/") || path.endsWith("/")) {
    throw new Error("normalizePath: out of scope (leading or trailing slash)");
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "") {
      throw new Error("normalizePath: out of scope (empty segment)");
    }
    if (segment === "." || segment === "..") {
      throw new Error("normalizePath: out of scope (dot segment)");
    }
  }
  // Ordinary segments only, already separated by single slashes: the join is the normalized form.
  return segments.join("/");
}
