import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export interface MagpieIdentity {
  origin?: string;
  agent?: string;
  session?: string;
  cwd?: string;
  kind?: string;
}

export interface MagpieBinding {
  sessionId: string;
  agentId: string;
  projectDir?: string;
  handle: string;
}

const HANDLE_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Sealed, time-limited handles cross Magpie's sessionless tool transport. */
export class MagpieSessions {
  private readonly directory: string;
  private pendingKey?: Promise<Buffer>;

  constructor(dataDirectory: string) {
    this.directory = join(dataDirectory, "magpie");
  }

  private key(): Promise<Buffer> {
    return (this.pendingKey ??= this.loadKey().catch((error: unknown) => {
      this.pendingKey = undefined;
      throw error;
    }));
  }

  private async loadKey(): Promise<Buffer> {
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, "session-key");
    const temporary = join(this.directory, `session-key-${randomUUID()}.pending`);
    await writeFile(temporary, randomBytes(32), { flag: "wx", mode: 0o600 });
    try {
      await link(temporary, path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    } finally {
      await unlink(temporary);
    }
    const key = await readFile(path);
    if (key.length !== 32) throw new Error("Invalid Magpie session key");
    return key;
  }

  async admit(identity: MagpieIdentity): Promise<MagpieBinding | null> {
    if (!["local", "magpie-key"].includes(identity.origin ?? "")) return null;
    if (!identity.agent?.trim() || !identity.session?.trim() || identity.kind === "subagent")
      return null;
    const id = createHmac("sha256", await this.key())
      .update(JSON.stringify([identity.agent, identity.session]))
      .digest("hex");
    return this.issue(`magpie-${id}`, identity.cwd);
  }

  async open(): Promise<MagpieBinding> {
    return this.issue(`magpie-${randomUUID()}`);
  }

  private async issue(sessionId: string, projectDir?: string): Promise<MagpieBinding> {
    const binding = {
      sessionId,
      agentId: sessionId,
      ...(projectDir && projectDir.length <= 2048 && isAbsolute(projectDir) ? { projectDir } : {}),
    };
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", await this.handleKey(), nonce);
    const body = Buffer.concat([
      cipher.update(JSON.stringify({ ...binding, expiresAt: Date.now() + HANDLE_LIFETIME_MS })),
      cipher.final(),
    ]);
    const handle = Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64url");
    return { ...binding, handle };
  }

  private async handleKey(): Promise<Buffer> {
    return createHmac("sha256", await this.key())
      .update("nmg-magpie-handle-v1")
      .digest();
  }

  async resolve(handle: unknown): Promise<MagpieBinding> {
    if (typeof handle !== "string" || handle.length > 8192)
      throw new Error("A Magpie session handle is required");
    const sealed = Buffer.from(handle, "base64url");
    if (sealed.length < 29 || sealed.toString("base64url") !== handle)
      throw new Error("Invalid Magpie session handle");
    const key = await this.handleKey();
    let scope: Omit<MagpieBinding, "handle"> & { expiresAt: number };
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
      decipher.setAuthTag(sealed.subarray(12, 28));
      const body = Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
      scope = JSON.parse(body.toString("utf8"));
    } catch {
      throw new Error("Invalid Magpie session handle");
    }
    if (scope.expiresAt <= Date.now()) throw new Error("Magpie session handle expired");
    return {
      sessionId: scope.sessionId,
      agentId: scope.agentId,
      projectDir: scope.projectDir,
      handle,
    };
  }
}
