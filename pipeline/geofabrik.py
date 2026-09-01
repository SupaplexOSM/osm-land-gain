"""Download Geofabrik Internal extracts with an OSM OAuth cookie."""

from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlencode, urlparse

import requests

from .config import GEOFABRIK_COOKIE_URL

USER_AGENT = "osm-land-gain/1.0 (+https://github.com/supaplexosm/osm-land-gain)"
HEADERS = {"User-Agent": USER_AGENT}
COOKIE_MAX_AGE_S = 20 * 3600
ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "pipeline" / "_cache"
CREDENTIALS_FILE = CACHE / "geofabrik-credentials.json"
COOKIE_FILE = CACHE / "geofabrik.cookie"


class GeofabrikAuthError(RuntimeError):
    pass


def _find_csrf(html: str) -> str:
    match = re.search(r'name="csrf-token" content="([^"]+)"', html)
    if not match:
        raise GeofabrikAuthError("CSRF-Token auf openstreetmap.org nicht gefunden.")
    return match.group(1)


def write_credentials_file(user: str, password: str) -> Path:
    """Store OSM login locally with mode 600. Never log the password."""
    if not user or not password:
        raise GeofabrikAuthError("User und Passwort dürfen nicht leer sein.")
    CACHE.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(CACHE, 0o700)
    except OSError:
        pass
    payload = {"user": user, "password": password}
    CREDENTIALS_FILE.write_text(json.dumps(payload) + "\n", encoding="utf-8")
    os.chmod(CREDENTIALS_FILE, 0o600)
    return CREDENTIALS_FILE


def prompt_write_credentials() -> Path:
    """Interactive write via getpass so the password never appears in the shell history."""
    from getpass import getpass

    user = os.environ.get("OSM_USER", "").strip() or input("OSM-Benutzername: ").strip()
    password = os.environ.get("OSM_PASSWORD", "") or getpass("OSM-Passwort: ")
    path = write_credentials_file(user, password)
    print(f"Geschrieben: {path}")
    print(f"Rechte: {oct(path.stat().st_mode & 0o777)} (nur du kannst lesen)")
    print("Git ignoriert die Datei (.gitignore und .git/info/exclude).")
    return path


def load_credentials() -> tuple[str, str]:
    user = os.environ.get("OSM_USER", "").strip()
    password = os.environ.get("OSM_PASSWORD", "")
    if CREDENTIALS_FILE.exists():
        data = json.loads(CREDENTIALS_FILE.read_text(encoding="utf-8"))
        user = user or str(data.get("user") or "").strip()
        password = password or str(data.get("password") or "")
    if not user or not password:
        raise GeofabrikAuthError(
            "OSM-Zugang fehlt. Setze OSM_USER und OSM_PASSWORD oder lege "
            f"{CREDENTIALS_FILE} an mit: python -m pipeline.geofabrik --write-credentials"
        )
    return user, password


def _fetch_cookie(user: str, password: str) -> str:
    """OAuth2 cookie flow used by osm-internal.download.geofabrik.de."""
    osm_host = "https://www.openstreetmap.org"
    consumer = GEOFABRIK_COOKIE_URL
    token_res = requests.post(
        f"{consumer}?action=get_authorization_url",
        data={},
        headers=HEADERS,
        timeout=60,
    )
    if token_res.status_code != 200:
        raise GeofabrikAuthError(
            f"Geofabrik request-token fehlgeschlagen ({token_res.status_code})."
        )
    payload = token_res.json()
    try:
        authorization_url = payload["authorization_url"]
        state = payload["state"]
        redirect_uri = payload["redirect_uri"]
        client_id = payload["client_id"]
    except KeyError as err:
        raise GeofabrikAuthError("Unerwartete Geofabrik-OAuth-Antwort.") from err

    session = requests.Session()
    session.headers.update(HEADERS)
    login_page = session.get(f"{osm_host}/login?cookie_test=true", timeout=60)
    if login_page.status_code != 200:
        raise GeofabrikAuthError(f"OSM-Login-Seite fehlgeschlagen ({login_page.status_code}).")
    csrf = _find_csrf(login_page.text)
    login = session.post(
        f"{osm_host}/login",
        data={
            "username": user,
            "password": password,
            "referer": "/",
            "commit": "Login",
            "authenticity_token": csrf,
        },
        allow_redirects=False,
        timeout=60,
    )
    if login.status_code != 302:
        raise GeofabrikAuthError(
            "OSM-Login fehlgeschlagen. User/Passwort prüfen "
            f"(HTTP {login.status_code})."
        )

    auth = session.get(authorization_url, allow_redirects=False, timeout=60)
    if auth.status_code == 200:
        csrf = _find_csrf(auth.text)
        auth = session.post(
            authorization_url,
            data={
                "client_id": client_id,
                "redirect_uri": redirect_uri,
                "authenticity_token": csrf,
                "state": state,
                "response_type": "code",
                "scope": "read_prefs",
                "nonce": "",
                "code_challenge": "",
                "code_challenge_method": "",
                "commit": "Authorize",
            },
            allow_redirects=False,
            timeout=60,
        )
    if auth.status_code != 302 or "location" not in auth.headers:
        raise GeofabrikAuthError(
            f"OAuth-Freigabe fehlgeschlagen (HTTP {auth.status_code})."
        )
    location = auth.headers["location"]
    if "?" not in location:
        raise GeofabrikAuthError("OAuth-Redirect ohne Query-String.")
    session.get(f"{osm_host}/logout", timeout=30)
    cookie_res = requests.get(
        f"{location}&{urlencode({'format': 'http'})}",
        headers=HEADERS,
        timeout=60,
    )
    cookie_res.raise_for_status()
    cookie = cookie_res.text.strip()
    if not cookie:
        raise GeofabrikAuthError("Leeres Geofabrik-Cookie.")
    return cookie


def geofabrik_cookie(*, force: bool = False) -> str:
    CACHE.mkdir(parents=True, exist_ok=True)
    if (
        not force
        and COOKIE_FILE.exists()
        and time.time() - COOKIE_FILE.stat().st_mtime < COOKIE_MAX_AGE_S
    ):
        text = COOKIE_FILE.read_text(encoding="utf-8").strip()
        if text:
            print("Geofabrik-Cookie aus Cache.")
            return text
    user, password = load_credentials()
    print("Hole Geofabrik-Internal-Cookie (OSM-OAuth)…")
    cookie = _fetch_cookie(user, password)
    COOKIE_FILE.write_text(cookie + "\n", encoding="utf-8")
    COOKIE_FILE.chmod(0o600)
    return cookie


def download_internal(url: str, dest: Path, *, cookie: str | None = None) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 1_000_000:
        print(f"PBF vorhanden: {dest}")
        return dest
    cookie = cookie or geofabrik_cookie()
    print(f"Lade {url} → {dest}")
    headers = {**HEADERS, "Cookie": cookie}

    def _get() -> requests.Response:
        return requests.get(url, headers=headers, stream=True, timeout=120)

    res = _get()
    if res.status_code in {401, 403}:
        res.close()
        cookie = geofabrik_cookie(force=True)
        headers["Cookie"] = cookie
        res = _get()
    try:
        if res.status_code != 200:
            raise GeofabrikAuthError(
                f"Download fehlgeschlagen: {url} (HTTP {res.status_code})."
            )
        total = int(res.headers.get("content-length") or 0)
        tmp = dest.with_suffix(dest.suffix + ".part")
        written = 0
        last_pct = -1
        with tmp.open("wb") as out:
            for chunk in res.iter_content(chunk_size=1024 * 1024):
                if not chunk:
                    continue
                out.write(chunk)
                written += len(chunk)
                if total > 0:
                    pct = min(100, int(written * 100 / total))
                    if pct >= last_pct + 10:
                        last_pct = pct
                        print(f"  Download {pct}%", flush=True)
        tmp.replace(dest)
    finally:
        res.close()
    print(f"  fertig ({dest.stat().st_size / 1e6:.1f} MB)")
    return dest


def cache_name_for_url(url: str) -> str:
    return Path(urlparse(url).path).name


def die_auth(err: GeofabrikAuthError) -> int:
    print(str(err), file=sys.stderr)
    return 1


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Geofabrik-Internal-Zugang")
    parser.add_argument(
        "--write-credentials",
        action="store_true",
        help="OSM-Login lokal nach pipeline/_cache/geofabrik-credentials.json schreiben (getpass, mode 600)",
    )
    args = parser.parse_args(argv)
    if args.write_credentials:
        try:
            prompt_write_credentials()
        except (GeofabrikAuthError, OSError, KeyboardInterrupt) as err:
            print(str(err) or "Abgebrochen.", file=sys.stderr)
            return 1
        return 0
    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
