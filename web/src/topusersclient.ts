/** Main-thread side of the top-user worker, with a plain-fetch fallback. */

import { fetchBinary } from "./gz";
import { TopUsers } from "./topusers";
import type { TopUsersRequest, TopUsersResponse } from "./topusers.worker";

type Pending = { resolve: (value: TopUsers) => void; reject: (err: unknown) => void };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function ensureWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./topusers.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
  worker.onmessage = (ev: MessageEvent<TopUsersResponse>) => {
    const slot = pending.get(ev.data.id);
    if (!slot) return;
    pending.delete(ev.data.id);
    if ("error" in ev.data) slot.reject(new Error(ev.data.error));
    else {
      try {
        slot.resolve(TopUsers.decode(ev.data.buffer));
      } catch (err) {
        slot.reject(err);
      }
    }
  };
  worker.onerror = () => {
    for (const slot of pending.values()) slot.reject(new Error("Worker abgestürzt"));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

export type TopUsersHandle = {
  ready: Promise<TopUsers>;
  cancel: () => void;
};

export function loadTopUsers(url: string): TopUsersHandle {
  const w = ensureWorker();
  if (!w) {
    const ac = new AbortController();
    return {
      ready: fetchBinary(url, ac.signal).then((buf) => TopUsers.decode(buf)),
      cancel: () => ac.abort(),
    };
  }
  const id = nextId++;
  const ready = new Promise<TopUsers>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const req: TopUsersRequest = { id, url };
    w.postMessage(req);
  });
  return {
    ready,
    cancel: () => {
      const slot = pending.get(id);
      if (!slot) return;
      pending.delete(id);
      const req: TopUsersRequest = { id, cancel: true };
      w.postMessage(req);
      slot.reject(new DOMException("Abgebrochen", "AbortError"));
    },
  };
}
