/**
 * Attachment loading for write commands.
 *
 * Reads a file path to a Buffer. A missing or unreadable file produces a
 * usage error (exit 2) before any SDK call is made. The bytes are never
 * logged and never echoed; `--preview` renders attachments as
 * `<name> (N bytes)` via lib/preview.ts.
 *
 * v2 wire shape: every write with attachments is `application/json`;
 * there is NO multipart op on the served surface. Attachments travel as
 * base64-encoded objects (`{content, content_type, filename}`, sometimes with
 * `send_mode: "file"` to send audio as a download). `toAttachmentPayload`
 * is the shared Buffer->wire-object converter for every command that attaches
 * files (message/post/recruiter/sales-nav).
 */

import * as fs from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

/** A usage-error that the run-loop maps to exit 2. */
export class AttachError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = "AttachError";
  }
}

/**
 * Read a file at `filePath` into a Buffer.
 *
 * @throws {AttachError} (exitCode 2) if the file is missing or unreadable.
 */
export async function readAttachment(filePath: string): Promise<Buffer> {
  try {
    const buf = await readFile(filePath);
    return buf;
  } catch (err: unknown) {
    const filename = basename(filePath);
    const reason =
      err instanceof Error ? err.message : "unknown error";
    throw new AttachError(
      `Cannot read attachment "${filename}": ${reason}. Pass a valid file path.`,
    );
  }
}

/**
 * Build a preview description for an attachment (name + byte length).
 * Bytes are never included in the preview output.
 */
export function describeAttachment(filePath: string, buf: Buffer): string {
  return `${basename(filePath)} (${buf.byteLength} bytes)`;
}

/** The v2 wire shape for a base64-encoded attachment (content/content_type/filename). */
export interface AttachmentPayload {
  content: string;
  content_type: string;
  filename: string;
  /** `file`: send as a download, audio included. Absent: the API's default (audio is a voice note, anything else a file). */
  send_mode?: "file";
}

/**
 * Minimal, dependency-free extension->MIME map covering the file types the
 * CLI's own help text documents (images, common docs, and voice/video
 * attachments). Unknown extensions fall back to `application/octet-stream`,
 * a generic but valid content_type; the served surface does not reject on it.
 */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

/** Guess a file's MIME type from its extension. Never throws. */
export function guessContentType(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Encode a loaded attachment into the v2 wire shape: base64 content plus a
 * best-effort content_type and the original filename.
 */
export function toAttachmentPayload(filePath: string, buf: Buffer, sendMode?: "file"): AttachmentPayload {
  return {
    content: buf.toString("base64"),
    content_type: guessContentType(filePath),
    filename: basename(filePath),
    ...(sendMode ? { send_mode: sendMode } : {}),
  };
}

/** Whether the API would read this file as audio, so send it as a voice note unless `send_mode` says `file`. */
export function isAudioFile(filePath: string): boolean {
  return guessContentType(filePath).startsWith("audio/");
}

/**
 * EML-38: a file to upload as one raw request, read from disk while it is sent (`fs.openAsBlob`, a file-backed Blob),
 * never held whole in memory; its size checked against `maxBytes` before any request. The path is read here, on the
 * user's machine: the server never fetches a path or a URL.
 * ponytail: a Node without `openAsBlob` (before 18.19 / 19.8) reads the file whole; drop the fallback with Node 18.
 */
export async function openUpload(filePath: string, maxBytes: number): Promise<{ data: Blob | Buffer; size: number }> {
  const filename = basename(filePath);
  let size: number;
  try {
    const st = await stat(filePath);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
  } catch (err: unknown) {
    throw new AttachError(`Cannot read attachment "${filename}": ${err instanceof Error ? err.message : "unknown error"}. Pass a valid file path.`);
  }
  if (size > maxBytes) throw new AttachError(`"${filename}" is ${size} bytes, over the ${maxBytes / (1024 * 1024)} MiB a file may be; nothing was sent. A link usually lands better than a file.`);
  // No type of our own: the server reads the file's type from its name and bytes, as for a buffer.
  const open = (fs as unknown as { openAsBlob?: (p: string) => Promise<Blob> }).openAsBlob;
  return { data: open ? await open(filePath) : await readAttachment(filePath), size };
}
