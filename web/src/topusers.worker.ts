/// <reference lib="webworker" />
/**
 * Fetches and gunzips cells.bin.gz off the main thread, then hands the raw
 * buffer over as a transferable. Decoding it is only wrapping typed arrays, so
 * that part stays on the main thread where the data is used.
 */

import { readBody } from "./gz";

export type TopUsersRequest = { id: number; url: string } | { id: number; cancel: true };
export type TopUsersResponse =
  | { id: number; buffer: ArrayBuffer }
  | { id: number; error: string };

const inFlight = new Map<number, AbortController>();

self.onmessage = async (ev: MessageEvent<TopUsersRequest>) => {
  const msg = ev.data;
  if ("cancel" in msg) {
    inFlight.get(msg.id)?.abort();
    inFlight.delete(msg.id);
    return;
  }
  const ac = new AbortController();
  inFlight.set(msg.id, ac);
  try {
    const res = await fetch(msg.url, { signal: ac.signal });
    if (!res.ok) throw new Error(`${msg.url} (${res.status})`);
    const type = res.headers.get("content-type") ?? "";
    // A dev server's SPA fallback answers 200 with index.html; catch that early.
    if (type.startsWith("text/html")) throw new Error(`${msg.url}: HTML statt Binärdaten`);
    const buffer = await readBody(res, msg.url);
    const reply: TopUsersResponse = { id: msg.id, buffer };
    (self as unknown as Worker).postMessage(reply, [buffer]);
  } catch (err) {
    if (!ac.signal.aborted) {
      const reply: TopUsersResponse = { id: msg.id, error: String(err) };
      (self as unknown as Worker).postMessage(reply);
    }
  } finally {
    inFlight.delete(msg.id);
  }
};
