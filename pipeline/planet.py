"""HTTP downloads and bz2 streaming for planet.openstreetmap.org dumps."""

from __future__ import annotations

import bz2
from pathlib import Path

import requests

from .config import USER_AGENT

HEADERS = {
    "User-Agent": USER_AGENT,
    # Avoid a second gzip layer on the already-bzipped dump; HTTP/2 + raw.read
    # also tends to stop after the first frame.
    "Accept-Encoding": "identity",
}
CONNECT_TIMEOUT = 30
READ_TIMEOUT = 180
CHUNK = 256 * 1024
PROGRESS_EVERY = 64 * 1024 * 1024


class HttpBz2Reader:
    """File-like decompressor over an HTTP response. Does not spool to disk.

    Planet dumps are often parallel-bzip2: several bz2 members concatenated.
    A single BZ2Decompressor stops at the first member, so we restart on EOF.
    """

    def __init__(self, response: requests.Response, chunk: int = CHUNK) -> None:
        self._chunks = response.iter_content(chunk_size=chunk)
        self._decomp = bz2.BZ2Decompressor()
        self._buf = bytearray()
        self._done = False
        self.bytes_in = 0

    def _decompress(self, raw: bytes) -> bytes:
        out = bytearray()
        while raw:
            if self._decomp.eof:
                self._decomp = bz2.BZ2Decompressor()
            piece = self._decomp.decompress(raw)
            if piece:
                out.extend(piece)
            raw = self._decomp.unused_data
            if not self._decomp.eof:
                break
            self._decomp = bz2.BZ2Decompressor()
        return bytes(out)

    def read(self, size: int = -1) -> bytes:
        if size == 0:
            return b""
        while not self._done and (size < 0 or len(self._buf) < size):
            try:
                raw = next(self._chunks)
            except StopIteration:
                self._done = True
                break
            if not raw:
                continue
            self.bytes_in += len(raw)
            piece = self._decompress(raw)
            if piece:
                self._buf.extend(piece)
        if size < 0:
            out = bytes(self._buf)
            self._buf.clear()
            return out
        out = bytes(self._buf[:size])
        del self._buf[:size]
        return out

    def read1(self, size: int = -1) -> bytes:
        return self.read(size)


def xml_local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def drain_root(root: object | None) -> None:
    """Drop processed children so iterparse does not keep the whole dump in RAM."""
    if root is None:
        return
    try:
        del root[:]  # type: ignore[index]
    except TypeError:
        pass


def download_file(url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    print(f"Lade {url} → {dest}", flush=True)
    with requests.get(url, stream=True, headers=HEADERS, timeout=(CONNECT_TIMEOUT, READ_TIMEOUT)) as resp:
        resp.raise_for_status()
        total = int(resp.headers.get("content-length") or 0)
        done = 0
        last = 0
        with tmp.open("wb") as out:
            for chunk in resp.iter_content(CHUNK):
                if not chunk:
                    continue
                out.write(chunk)
                done += len(chunk)
                if done - last >= PROGRESS_EVERY:
                    last = done
                    if total:
                        print(f"  {done / 1e6:.0f} / {total / 1e6:.0f} MB", flush=True)
                    else:
                        print(f"  {done / 1e6:.0f} MB", flush=True)
    tmp.replace(dest)
    return dest
