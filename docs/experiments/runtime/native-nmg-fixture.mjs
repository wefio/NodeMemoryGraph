import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NmgService } from "../../../src/cli/service.ts";
import { httpHandler } from "../../../src/cli/http-server.ts";

export async function privateNmg(directory) {
  const dataDirectory = join(directory, "nmg-data");
  const service = new NmgService({ dataDirectory, environment: {} });
  const requests = [];
  const handler = httpHandler(service, "synthetic-private-nmg");
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(JSON.parse(body));
    });
    handler(request, response);
  });
  const close = async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise((done) => server.close(done));
    await service.close();
  };
  try {
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    await service.invoke("remember", {
      statement: "Atlas uses SQLite storage. NmgNativeExactEvidenceMarker",
      nodeName: "Atlas",
    });
    const memoryId = (await service.invoke("search", { query: "Atlas SQLite storage" })).results[0]
      .memory.id;
    await writeFile(
      join(dataDirectory, "nmg.sqlite.server.json"),
      JSON.stringify({
        pid: process.pid,
        transport: "http",
        host: "127.0.0.1",
        port: server.address().port,
        token: "synthetic-private-nmg",
      }),
    );
    return {
      dataDirectory,
      requests,
      memoryId,
      invoke: (method, params) => service.invoke(method, params),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
