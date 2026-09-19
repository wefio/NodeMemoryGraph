// normalizePath(path) normalizes a POSIX-style path.
// This stage covers paths built from ordinary segments separated by single slashes. The remaining
// cases of the contract arrive with the next handoff.
export function normalizePath(path: string): string {
  const isAbsolute = path.startsWith("/");
  const out: string[] = [];

  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!isAbsolute) {
        out.push("..");
      }
      continue;
    }
    out.push(segment);
  }

  const joined = out.join("/");
  if (isAbsolute) {
    return "/" + joined;
  }
  return joined === "" ? "." : joined;
}
