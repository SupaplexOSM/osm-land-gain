/**
 * Decoder for `cells.bin.gz`: the per-cell top-user lists.
 *
 * These drive the viewport ranking, the cell panel and the activity dots, but
 * nothing the map draws, so the app stays usable while they are still loading.
 * The file is struct-of-arrays, so decoding is just wrapping typed arrays around
 * the buffer — no parsing, no per-row objects.
 *
 * Layout (little-endian), written by pipeline/binpack.py:
 *
 *   magic "OLGT" | version | cellCount | filterCount | userCount | rowCount |
 *   keysLen | reserved                                        (32 bytes)
 *   keys      keysLen bytes, newline-joined h3 ids, padded to 4
 *   uids      userCount   x u32   user index -> OSM uid
 *   rowStart  slots+1     x u32   prefix sums over (cell, filter) slots
 *   userIdx   rowCount    x u32
 *   score     rowCount    x f32
 *   day       rowCount    x u16   days since the epoch
 */

import { FILTERS, type FilterId } from "./types";

const MAGIC = 0x4f4c4754; // "OLGT"
const VERSION = 1;
const HEADER_SIZE = 32;
const DAY_MS = 86400000;

export type TopUserRow = { uid: number; score: number; lastTs: number };

function align4(offset: number): number {
  return offset + ((-offset % 4) + 4) % 4;
}

export class TopUsers {
  private readonly cellIndex: Map<string, number>;
  private readonly uids: Uint32Array;
  private readonly rowStart: Uint32Array;
  private readonly userIdx: Uint32Array;
  private readonly score: Float32Array;
  private readonly day: Uint16Array;
  private readonly filterCount: number;
  /** uid -> cells holding a score for them, built lazily per filter. */
  private readonly cellsByUid = new Map<FilterId, Map<number, string[]>>();
  private readonly cellNames: string[];

  private constructor(buf: ArrayBuffer) {
    const view = new DataView(buf);
    if (buf.byteLength < HEADER_SIZE || view.getUint32(0, false) !== MAGIC) {
      throw new Error("cells.bin: unerwartete Signatur");
    }
    const version = view.getUint32(4, true);
    if (version !== VERSION) throw new Error(`cells.bin: Version ${version} wird nicht unterstützt`);
    const cellCount = view.getUint32(8, true);
    this.filterCount = view.getUint32(12, true);
    const userCount = view.getUint32(16, true);
    const rowCount = view.getUint32(20, true);
    const keysLen = view.getUint32(24, true);

    let at = HEADER_SIZE;
    const keys = new TextDecoder().decode(new Uint8Array(buf, at, keysLen));
    this.cellNames = keys ? keys.split("\n") : [];
    if (this.cellNames.length !== cellCount) {
      throw new Error(`cells.bin: ${this.cellNames.length} Schlüssel, erwartet ${cellCount}`);
    }
    at = align4(at + keysLen);
    this.uids = new Uint32Array(buf, at, userCount);
    at += userCount * 4;
    this.rowStart = new Uint32Array(buf, at, cellCount * this.filterCount + 1);
    at += (cellCount * this.filterCount + 1) * 4;
    this.userIdx = new Uint32Array(buf, at, rowCount);
    at += rowCount * 4;
    this.score = new Float32Array(buf, at, rowCount);
    at += rowCount * 4;
    this.day = new Uint16Array(buf, at, rowCount);

    this.cellIndex = new Map();
    for (let i = 0; i < this.cellNames.length; i++) this.cellIndex.set(this.cellNames[i]!, i);
  }

  static decode(buf: ArrayBuffer): TopUsers {
    return new TopUsers(buf);
  }

  private slot(h3: string, filter: FilterId): number {
    const cell = this.cellIndex.get(h3);
    if (cell === undefined) return -1;
    const fi = FILTERS.indexOf(filter);
    if (fi < 0 || fi >= this.filterCount) return -1;
    return cell * this.filterCount + fi;
  }

  /** Rows for one cell, newest-scoring first (pipeline order). */
  rows(h3: string, filter: FilterId): TopUserRow[] {
    const slot = this.slot(h3, filter);
    if (slot < 0) return [];
    const out: TopUserRow[] = [];
    for (let i = this.rowStart[slot]!; i < this.rowStart[slot + 1]!; i++) {
      out.push({
        uid: this.uids[this.userIdx[i]!]!,
        score: this.score[i]!,
        lastTs: this.day[i]! * DAY_MS,
      });
    }
    return out;
  }

  /**
   * Sum scores per user over the given cells and report the newest touch.
   * Reads the typed arrays directly, so no intermediate objects are allocated.
   */
  aggregate(h3Ids: Iterable<string>, filter: FilterId): Map<number, { score: number; lastTs: number }> {
    const acc = new Map<number, { score: number; lastTs: number }>();
    for (const h3 of h3Ids) {
      const slot = this.slot(h3, filter);
      if (slot < 0) continue;
      for (let i = this.rowStart[slot]!; i < this.rowStart[slot + 1]!; i++) {
        const uid = this.uids[this.userIdx[i]!]!;
        const lastTs = this.day[i]! * DAY_MS;
        const prev = acc.get(uid);
        if (!prev) acc.set(uid, { score: this.score[i]!, lastTs });
        else {
          prev.score += this.score[i]!;
          if (lastTs > prev.lastTs) prev.lastTs = lastTs;
        }
      }
    }
    return acc;
  }

  /** Distinct users with a positive score across the given cells. */
  mapperCount(h3Ids: Iterable<string>, filter: FilterId): number {
    const seen = new Set<number>();
    for (const h3 of h3Ids) {
      const slot = this.slot(h3, filter);
      if (slot < 0) continue;
      for (let i = this.rowStart[slot]!; i < this.rowStart[slot + 1]!; i++) {
        if (this.score[i]! > 0) seen.add(this.uids[this.userIdx[i]!]!);
      }
    }
    return seen.size;
  }

  /** Every cell where a user scored, across the whole snapshot. */
  cellsForUid(filter: FilterId, uid: number): string[] {
    let index = this.cellsByUid.get(filter);
    if (!index) {
      index = new Map();
      const fi = FILTERS.indexOf(filter);
      if (fi >= 0 && fi < this.filterCount) {
        for (let cell = 0; cell < this.cellNames.length; cell++) {
          const slot = cell * this.filterCount + fi;
          for (let i = this.rowStart[slot]!; i < this.rowStart[slot + 1]!; i++) {
            if (this.score[i]! <= 0) continue;
            const owner = this.uids[this.userIdx[i]!]!;
            const list = index.get(owner);
            if (list) list.push(this.cellNames[cell]!);
            else index.set(owner, [this.cellNames[cell]!]);
          }
        }
      }
      this.cellsByUid.set(filter, index);
    }
    return index.get(uid) ?? [];
  }

  /** Score of one user in one cell, or 0. */
  scoreFor(h3: string, filter: FilterId, uid: number): number {
    const slot = this.slot(h3, filter);
    if (slot < 0) return 0;
    for (let i = this.rowStart[slot]!; i < this.rowStart[slot + 1]!; i++) {
      if (this.uids[this.userIdx[i]!]! === uid) return this.score[i]!;
    }
    return 0;
  }
}
