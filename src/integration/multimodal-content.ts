import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };
export type AmlContent = string | ContentPart[];
export type ImageDescriber = (dataUrl: string) => Promise<string>;

export interface ContentLimits {
  maxTextChars?: number;
  maxImageBytes?: number;
  maxImages?: number;
  maxParts?: number;
}

export class ContentValidationError extends Error {
  readonly code: "invalid_content" | "content_too_large";
  constructor(message: string, tooLarge = false) {
    super(message);
    this.name = "ContentValidationError";
    this.code = tooLarge ? "content_too_large" : "invalid_content";
  }
}

function imageSignature(bytes: Buffer, format: string): boolean {
  if (format === "png") return bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (format === "jpeg") return bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"));
  if (format === "gif") return /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"));
  return (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

function imageUrl(value: unknown, maxBytes: number): string {
  if (typeof value !== "string")
    throw new ContentValidationError("image_url.url must be a Base64 image data URL");
  if (value.length > Math.ceil(maxBytes / 3) * 4 + 128)
    throw new ContentValidationError("Image byte limit exceeded", true);
  const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match)
    throw new ContentValidationError(
      "image_url.url must be a PNG, JPEG, WebP or GIF Base64 data URL",
    );
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > maxBytes) throw new ContentValidationError("Image byte limit exceeded", true);
  if (bytes.toString("base64") !== match[2] || !imageSignature(bytes, match[1])) {
    throw new ContentValidationError(
      "Image encoding or signature does not match its declared format",
    );
  }
  return value;
}

function contentPart(value: unknown, maxImageBytes: number): ContentPart {
  if (!value || typeof value !== "object") throw new ContentValidationError("Invalid content part");
  const part = value as Record<string, unknown>;
  if (part.type === "text" && typeof part.text === "string")
    return { type: "text", text: part.text };
  if (part.type !== "image_url" || !part.image_url || typeof part.image_url !== "object") {
    throw new ContentValidationError("Only text and image_url content parts are supported");
  }
  const image = part.image_url as Record<string, unknown>;
  const url = imageUrl(image.url, maxImageBytes);
  if (
    image.detail !== undefined &&
    image.detail !== "auto" &&
    image.detail !== "low" &&
    image.detail !== "high"
  ) {
    throw new ContentValidationError("Invalid image detail");
  }
  return {
    type: "image_url",
    image_url: { url, ...(image.detail ? { detail: image.detail } : {}) },
  };
}

/** Validate the bounded AML Base64 image contract without fetching arbitrary URLs. */
export function normalizeContent(value: unknown, limits: ContentLimits = {}): AmlContent {
  const maxText = limits.maxTextChars ?? 128000;
  if (typeof value === "string") {
    if (!value.trim()) throw new ContentValidationError("Content must be nonempty");
    if (value.length > maxText)
      throw new ContentValidationError("Text character limit exceeded", true);
    return value;
  }
  if (!Array.isArray(value) || !value.length)
    throw new ContentValidationError("Content must be a string or a nonempty ordered parts array");
  if (value.length > (limits.maxParts ?? 32))
    throw new ContentValidationError("Content part count limit exceeded", true);
  const parts = value.map((part) => contentPart(part, limits.maxImageBytes ?? 1024 * 1024));
  const images = parts.filter((part) => part.type === "image_url").length;
  const text = contentText(parts);
  if (!images && !text.trim()) throw new ContentValidationError("Content must be nonempty");
  if (images > (limits.maxImages ?? 4) || text.length > maxText)
    throw new ContentValidationError("Content image/text limit exceeded", true);
  return parts;
}

export function contentText(content: AmlContent): string {
  return typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}

export function contentHasImages(content: AmlContent): boolean {
  return typeof content !== "string" && content.some((part) => part.type === "image_url");
}

/** A derived retrieval view only. Callers retain the original ordered source parts.
 * Supplied captions need no model. Opaque image hashes identify source bytes;
 * an optional model can enrich the view, but never answers a query. */
export async function describeContent(
  content: AmlContent,
  describeImage?: ImageDescriber,
): Promise<string> {
  if (typeof content === "string") return content;
  const fragments: string[] = [];
  for (const part of content) {
    if (part.type === "text") {
      fragments.push(part.text);
      continue;
    }
    const digest = createHash("sha256").update(part.image_url.url).digest("hex");
    if (!describeImage) {
      fragments.push(`[Image ${digest}]`);
      continue;
    }
    const description = await describeImage(part.image_url.url);
    if (typeof description !== "string" || !description.trim())
      throw new Error("Image description must be nonempty");
    fragments.push(`[Image ${digest}; derived description]\n${description}`);
  }
  return fragments.join("\n");
}
