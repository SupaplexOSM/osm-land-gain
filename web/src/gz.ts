/**
 * The pipeline ships its bigger payloads pre-compressed as `*.gz`, so no server
 * has to gzip them per request. Some hosts and proxies unwrap `Content-Encoding`
 * on the way, so decide from the gzip magic bytes rather than from headers.
 */

const GZIP_MAGIC = 0x1f8b;

export function isGzip(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 2) return false;
  return new DataView(buf).getUint16(0, false) === GZIP_MAGIC;
}

export async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  if (!isGzip(buf)) return buf;
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/**
 * Read a response body, unwrapping our own gzip if the transport did not.
 * Decompressing the stream as it arrives avoids holding both the packed and the
 * unpacked copy in memory, which matters for the multi-megabyte payloads.
 */
export async function readBody(res: Response, url: string): Promise<ArrayBuffer> {
  const alreadyDecoded = Boolean(res.headers.get("content-encoding"));
  if (!url.endsWith(".gz") || alreadyDecoded || !res.body) {
    return gunzip(await res.arrayBuffer());
  }
  try {
    const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).arrayBuffer();
  } catch {
    // Some proxies unwrap the encoding without announcing it.
    const plain = await fetch(url);
    return gunzip(await plain.arrayBuffer());
  }
}

export async function fetchBinary(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${url} (${res.status})`);
  return readBody(res, url);
}

export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const buf = await fetchBinary(url, signal);
  return JSON.parse(new TextDecoder().decode(buf)) as T;
}

export async function fetchJsonOptional<T>(url: string, signal?: AbortSignal): Promise<T | null> {
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    return JSON.parse(new TextDecoder().decode(await readBody(res, url))) as T;
  } catch (err) {
    if (isAbortError(err)) throw err;
    return null;
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}
