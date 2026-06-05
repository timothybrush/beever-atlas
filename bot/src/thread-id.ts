/**
 * Helpers for parsing Chat SDK thread ids.
 *
 * Thread ids follow the pattern `"<platform>:<channelId>:<thread>"`
 * (e.g. `"slack:C123:1700000000.000100"`). The platform prefix is the only
 * place the post-time platform is recoverable, since the SDK `Thread`/`Message`
 * objects passed to handlers do not carry a platform field.
 */

/** Extract the channel id (second segment), falling back to the whole id. */
export function extractChannelId(threadId: string): string {
  const parts = threadId.split(":");
  return parts.length >= 2 ? parts[1] : threadId;
}

/**
 * Extract the platform (first segment), lower-cased. Returns `"unknown"` for
 * malformed ids so the renderer degrades to a safe generic format rather than
 * throwing.
 */
export function extractPlatform(threadId: string): string {
  const parts = threadId.split(":");
  return parts.length >= 2 && parts[0] ? parts[0].toLowerCase() : "unknown";
}
