import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MagpieInvoke } from "./types.ts";

export class MagpiePageService {
  private readonly token = randomBytes(32).toString("base64url");
  private server?: Server;
  private readonly invoke: MagpieInvoke;
  private readonly uiDirectory: string;
  private readonly port: number;

  constructor(invoke: MagpieInvoke, uiDirectory: string, port: number) {
    this.invoke = invoke;
    this.uiDirectory = uiDirectory;
    this.port = port;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => {
      void this.respond(request, response).catch((error: unknown) => {
        response.statusCode = 400;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : "NMG management request failed",
          }),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "127.0.0.1", resolve);
    });
    this.server = server;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }

  private authorized(request: IncomingMessage): boolean {
    const value = request.headers["x-nmg-operator"];
    if (typeof value !== "string") return false;
    const candidate = Buffer.from(value);
    const expected = Buffer.from(this.token);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }

  private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    if (request.headers.host !== `127.0.0.1:${this.port}`) {
      response.writeHead(403).end();
      return;
    }
    const origin = request.headers.origin;
    if (origin && origin !== "null" && origin !== `http://127.0.0.1:${this.port}`) {
      response.writeHead(403).end();
      return;
    }
    const path = new URL(request.url ?? "/", `http://127.0.0.1:${this.port}`).pathname;
    if (await this.servePageAsset(request, response, path, origin)) return;
    if (!this.authorized(request)) {
      response.writeHead(403).end();
      return;
    }
    if (origin) response.setHeader("access-control-allow-origin", origin);
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && path === "/api/snapshot") {
      const [status, metrics] = await Promise.all([
        this.invoke("status", {}),
        this.invoke("operator", { action: "snapshot" }),
      ]);
      response.end(JSON.stringify({ status, metrics }));
      return;
    }
    if (request.method === "POST" && path === "/api/operator") {
      const input = await this.readBody(request);
      if (
        ![
          "saveCandidate",
          "testCandidate",
          "buildCandidate",
          "activateCandidate",
          "cancelCandidate",
        ].includes(String(input.action))
      )
        throw new Error("Unsupported page operation");
      response.end(JSON.stringify(await this.invoke("operator", input)));
      return;
    }
    response.writeHead(404).end();
  }

  private async servePageAsset(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
    origin: string | undefined,
  ): Promise<boolean> {
    if (request.method === "OPTIONS") {
      response.setHeader("access-control-allow-origin", origin ?? "null");
      response.setHeader("access-control-allow-methods", "GET, POST");
      response.setHeader("access-control-allow-headers", "content-type, x-nmg-operator");
      response.writeHead(204).end();
      return true;
    }
    if (request.method === "GET" && path === "/") {
      await this.page(response);
      return true;
    }
    if (request.method === "GET" && path === "/operator.js") {
      response.setHeader("content-type", "text/javascript; charset=utf-8");
      response.end(await readFile(join(this.uiDirectory, "operator.js")));
      return true;
    }
    return false;
  }

  private async page(response: ServerResponse): Promise<void> {
    const nonce = randomBytes(16).toString("base64url");
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader(
      "content-security-policy",
      `default-src 'none'; script-src 'self' http://127.0.0.1:${this.port} 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self' http://127.0.0.1:${this.port}; frame-ancestors 'self' http://127.0.0.1:* https://magpie.localhost http://wails.localhost`,
    );
    const html = await readFile(join(this.uiDirectory, "operator.html"), "utf8");
    response.end(
      html
        .replaceAll("__NMG_NONCE__", nonce)
        .replace("__NMG_OPERATOR_TOKEN__", JSON.stringify(this.token)),
    );
  }

  private async readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      length += buffer.length;
      if (length > 65536) throw new Error("Management request is too large");
      chunks.push(buffer);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid management request");
    return value as Record<string, unknown>;
  }
}
