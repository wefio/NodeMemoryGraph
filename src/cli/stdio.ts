import { createInterface } from "node:readline";

import {
  NMG_PROTOCOL_VERSION,
  NmgProtocolError,
  type NmgRequest,
  type NmgResponse,
} from "./protocol.ts";
import { NmgService } from "./service.ts";

const MAX_LINE_BYTES = 1_048_576;

export async function serveStdio(service: NmgService): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const response = await handleLine(service, line);
      process.stdout.write(`${JSON.stringify(response)}\n`);
      if (service.shutdownRequested) break;
    }
  } finally {
    lines.close();
    service.close();
  }
}

export async function handleLine(service: NmgService, line: string): Promise<NmgResponse> {
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
    return errorResponse(null, new NmgProtocolError("REQUEST_TOO_LARGE", "request exceeds 1 MiB"));
  }
  let request: NmgRequest;
  try {
    request = JSON.parse(line) as NmgRequest;
  } catch {
    return errorResponse(null, new NmgProtocolError("PARSE_ERROR", "request is not valid JSON"));
  }
  return service.dispatch(request);
}

function errorResponse(id: null, error: NmgProtocolError): NmgResponse {
  return {
    protocol: NMG_PROTOCOL_VERSION,
    id,
    ok: false,
    error: { code: error.code, message: error.message },
  };
}
