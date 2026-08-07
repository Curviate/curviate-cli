/**
 * `--preview` request renderer.
 *
 * Renders the fully-resolved request that *would* be sent to the API,
 * without making any SDK call or sending any server-side parameter.
 *
 * This feature is strictly client-side. It does NOT send any preview or
 * test parameter to the server. It is NOT a test mode or server-side stub.
 *
 * The rendered output shows:
 *   - The SDK method name
 *   - The resolved positional/path arguments
 *   - The assembled request body (with attachments shown as "name (N bytes)",
 *     never the raw bytes)
 *   - The effective account (if applicable)
 *
 * The API key is never included in the preview output.
 *
 * Valid only on write commands (W in the command table). On read commands,
 * the run-loop should reject with exit 2.
 */

export interface AttachmentPreview {
  name: string;
  buffer: Buffer;
}

export interface PreviewRequest {
  /** The SDK method being called, e.g. "invites.send". */
  method: string;
  /** Resolved path/positional arguments. */
  args: Record<string, unknown>;
  /** Assembled request body (without the API key). */
  body: Record<string, unknown>;
  /** The effective account id, if applicable. */
  account?: string;
  /** Attachments, rendered as "name (N bytes)" in the output. */
  attachments?: AttachmentPreview[];
}

export interface PreviewOutput {
  method: string;
  args: Record<string, unknown>;
  body: Record<string, unknown>;
  account?: string;
  /** Attachment descriptions, "name (N bytes)", never raw bytes. */
  attachments?: string[];
}

/**
 * Build the preview output object for `--preview` rendering.
 *
 * Attachment buffers are replaced with their description strings. No raw
 * bytes or API credentials are included.
 */
export function buildPreviewOutput(req: PreviewRequest): PreviewOutput {
  const result: PreviewOutput = {
    method: req.method,
    args: req.args,
    body: req.body,
  };

  if (req.account !== undefined) {
    result.account = req.account;
  }

  if (req.attachments && req.attachments.length > 0) {
    result.attachments = req.attachments.map(
      (a) => `${a.name} (${a.buffer.byteLength} bytes)`,
    );
  }

  return result;
}
