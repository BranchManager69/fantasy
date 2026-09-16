/** Read application SSE events; a validated result completes the request before EOF. */
export async function readAnalystStream(
  response: Response,
  onProgress: (message: string) => void,
): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The answer connection could not be opened.");
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data: string[] = [];

  const line = (value: string): Record<string, unknown> | undefined => {
    if (value !== "") {
      if (value.startsWith(":")) return;
      const separator = value.indexOf(":");
      const field = separator < 0 ? value : value.slice(0, separator);
      const content = separator < 0 ? "" : value.slice(separator + 1).replace(/^ /, "");
      if (field === "event") event = content;
      if (field === "data") data.push(content);
      return;
    }
    const kind = event;
    const payload = data.join("\n");
    event = "";
    data = [];
    if (!payload || !["progress", "error", "result"].includes(kind)) return;
    let update: unknown;
    try { update = JSON.parse(payload); }
    catch { throw new Error("The analyst sent an unreadable update. Please try again."); }
    if (!update || typeof update !== "object" || Array.isArray(update)) {
      throw new Error("The answer could not be read. Please try again.");
    }
    const fields = update as Record<string, unknown>;
    if (kind === "error") {
      throw new Error(typeof fields.error === "string" && fields.error
        ? fields.error : "The analyst could not finish this question.");
    }
    if (kind === "progress" && typeof fields.message === "string") onProgress(fields.message);
    if (kind === "result") {
      if (typeof fields.answer !== "string" || !fields.answer.trim() || !Array.isArray(fields.sources)) {
        throw new Error("The answer could not be read. Please try again.");
      }
      return fields;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      while (true) {
        const boundary = buffer.search(/[\r\n]/);
        if (boundary < 0) break;
        // A CRLF pair may be split between network chunks.
        if (!done && buffer[boundary] === "\r" && boundary === buffer.length - 1) break;
        const width = buffer[boundary] === "\r" && buffer[boundary + 1] === "\n" ? 2 : 1;
        const current = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + width);
        const result = line(current);
        if (result) return result;
      }
      if (done) throw new Error("The connection ended before an answer arrived.");
    }
  } finally {
    // Do not let a hung or failed transport cancellation discard a complete answer.
    // Cancelling on parser failure also tells the server to clean up the unfinished run.
    try { void reader.cancel().catch(() => undefined); } catch { /* Already closed. */ }
    try { reader.releaseLock(); } catch { /* A broken transport may already be detached. */ }
  }
}
