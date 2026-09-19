// normalizePath(path) normalizes a POSIX-style path.
//
// Contract:
//   - repeated slashes collapse: a//b -> a/b
//   - a "." segment is removed: a/./b -> a/b
//   - a ".." segment removes the segment before it: ./a/../b -> b
//   - a ".." above the root of an absolute path is dropped: /../a -> /a
//   - a trailing slash is removed: a/ -> a
//   - an empty path is "."
//
// Absolute paths (leading '/') remain absolute; relative paths never gain a
// leading '/'. Ordinary segments separated by single slashes are already in
// normalized form.
export function normalizePath(path: string): string {
  if (path.length === 0) {
    return ".";
  }
  const isAbsolute = path.startsWith("/");
  const segments = path.split("/");
  const result: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      // Repeated/edge slashes and "." segments contribute nothing.
      continue;
    }
    if (segment === "..") {
      // Pop the previous segment if there is one; above the root of an
      // absolute path (or an empty stack) the ".." is dropped.
      if (result.length > 0 && result[result.length - 1] !== "..") {
        result.pop();
      } else if (!isAbsolute) {
        result.push("..");
      }
      continue;
    }
    result.push(segment);
  }
  const joined = result.join("/");
  if (isAbsolute) {
    return "/" + joined;
  }
  return joined.length === 0 ? "." : joined;
}
