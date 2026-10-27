/**
 * Request normalisation for the EdgeOne handler.
 *
 * Makers hands the handler a `Request`-like object whose body is not a WHATWG
 * ReadableStream (`request.body.getReader` is missing), while worker.mjs streams
 * bodies through `getReader()`. Wrapping the body in a real ReadableStream is
 * cheaper and less invasive than teaching worker.mjs a second body shape, and it
 * keeps the 6 MiB limit in one place.
 */
export function normalizeRequest(request) {
  if (!request?.body || typeof request.body.getReader === "function") return request;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const reader =
          typeof request.body.getReader === "function"
            ? request.body.getReader()
            : typeof request.body[Symbol.asyncIterator] === "function"
              ? request.body[Symbol.asyncIterator]()
              : null;
        if (reader) {
          for (;;) {
            const next = await reader.next();
            if (next.done) break;
            controller.enqueue(toBytes(next.value));
          }
        } else {
          controller.enqueue(toBytes(await materialize(request.body)));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: stream,
    duplex: "half",
  });
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new TextEncoder().encode(String(value));
}

async function materialize(body) {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return toBytes(body);
  if (typeof body.arrayBuffer === "function") return new Uint8Array(await body.arrayBuffer());
  if (typeof body.text === "function") return await body.text();
  return JSON.stringify(body);
}
