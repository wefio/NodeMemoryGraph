/**
 * Bound an entire Pi RPC operation. Pi's event timeout does not cover a prompt
 * request that never acknowledges, so evaluation helpers need one outer clock.
 */
export async function hardTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`Pi prompt exceeded the ${timeoutMs}ms evaluation timeout`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
