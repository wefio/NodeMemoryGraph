import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

interface ObjectValue {
  body: Buffer;
  etag: string;
}

/** Protocol fixture, not an AWS emulator: object CRUD, conditional writes and range reads. */
export async function startObjectServer() {
  const objects = new Map<string, ObjectValue>();
  const requests: string[] = [];
  const fault = { rejectWrites: false, conditionalWrites: 0 };
  const server = createServer((request, response) => {
    if (request.headers["if-match"] || request.headers["if-none-match"])
      fault.conditionalWrites += 1;
    if (request.method === "PUT" && fault.rejectWrites) {
      response.writeHead(403).end("<Error><Code>AccessDenied</Code></Error>");
      return;
    }
    void handle(request, response, objects, requests).catch((error: unknown) => {
      response.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No S3 test port");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    objects,
    requests,
    fault,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  objects: Map<string, ObjectValue>,
  requests: string[],
) {
  const url = new URL(request.url!, "http://localhost");
  const key = decodeURIComponent(url.pathname);
  requests.push(`${request.method} ${key}`);
  if (url.searchParams.has("list-type")) return list(url, response, objects);
  const value = objects.get(key);
  if (request.method === "PUT") return put(request, response, objects, key);
  if (request.method === "DELETE") {
    objects.delete(key);
    response.writeHead(204).end();
    return;
  }
  if (!value) {
    response
      .writeHead(404, { "content-type": "application/xml" })
      .end("<Error><Code>NoSuchKey</Code></Error>");
    return;
  }
  read(request, response, value);
}

async function put(
  request: IncomingMessage,
  response: ServerResponse,
  objects: Map<string, ObjectValue>,
  key: string,
) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const current = objects.get(key);
  if (
    (request.headers["if-none-match"] === "*" && current) ||
    (request.headers["if-match"] && request.headers["if-match"] !== current?.etag)
  ) {
    response.writeHead(412).end("<Error><Code>PreconditionFailed</Code></Error>");
    return;
  }
  const body = Buffer.concat(chunks);
  const etag = `"${createHash("md5").update(body).digest("hex")}"`;
  objects.set(key, { body, etag });
  response.writeHead(200, { etag }).end();
}

function read(request: IncomingMessage, response: ServerResponse, value: ObjectValue) {
  const headers: Record<string, string | number> = {
    etag: value.etag,
    "content-length": value.body.length,
    "last-modified": "Thu, 05 Nov 2026 00:00:00 GMT",
    "accept-ranges": "bytes",
  };
  if (request.method === "HEAD") {
    response.writeHead(200, headers).end();
    return;
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
  if (!range) {
    response.writeHead(200, headers).end(value.body);
    return;
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, value.body.length - Number(range[2]));
  const end =
    range[1] && range[2]
      ? Math.min(Number(range[2]), value.body.length - 1)
      : value.body.length - 1;
  const body = value.body.subarray(start, end + 1);
  headers["content-range"] = `bytes ${start}-${end}/${value.body.length}`;
  headers["content-length"] = body.length;
  response.writeHead(206, headers).end(body);
}

function xml(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}

function list(url: URL, response: ServerResponse, objects: Map<string, ObjectValue>) {
  const bucket = `${url.pathname.replace(/\/$/, "")}/`;
  const prefix = url.searchParams.get("prefix") ?? "";
  const delimiter = url.searchParams.get("delimiter");
  const keys = [...objects.keys()].filter((key) => key.startsWith(bucket + prefix)).sort();
  const common = new Set<string>();
  const contents: string[] = [];
  for (const full of keys) {
    const key = full.slice(bucket.length);
    const split = delimiter ? key.indexOf(delimiter, prefix.length) : -1;
    if (split >= 0) {
      common.add(key.slice(0, split + 1));
      continue;
    }
    const value = objects.get(full)!;
    contents.push(
      `<Contents><Key>${xml(key)}</Key><Size>${value.body.length}</Size><ETag>${xml(value.etag)}</ETag><LastModified>2026-11-05T00:00:00.000Z</LastModified></Contents>`,
    );
  }
  response
    .writeHead(200, { "content-type": "application/xml" })
    .end(
      `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>nmg-test</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${contents.length}</KeyCount><IsTruncated>false</IsTruncated>${contents.join("")}${[...common].map((key) => `<CommonPrefixes><Prefix>${xml(key)}</Prefix></CommonPrefixes>`).join("")}</ListBucketResult>`,
    );
}
