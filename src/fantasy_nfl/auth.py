from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import httpx
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright

from .settings import AppSettings

LOGIN_URL = "https://registerdisney.go.com/jgc/v6/client/ESPN-ESPNCOMBO/login"
ESPN_HOME_URL = "https://www.espn.com/"
FANTASY_HOME_URL = "https://fantasy.espn.com/football/"
DEFAULT_TIMEOUT = httpx.Timeout(15.0)


@dataclass
class EspnCookies:
    espn_s2: str
    swid: str
    captured_at: float

    def masked(self) -> dict[str, str]:
        def _mask(value: str) -> str:
            return f"{value[:6]}***{value[-6:]}" if len(value) > 12 else "***"

        return {
            "espn_s2": _mask(self.espn_s2),
            "swid": _mask(self.swid),
        }

    def to_dict(self) -> dict[str, object]:
        return {
            "espn_s2": self.espn_s2,
            "swid": self.swid,
            "captured_at": self.captured_at,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> "EspnCookies":
        return cls(
            espn_s2=str(payload["espn_s2"]),
            swid=str(payload["swid"]),
            captured_at=float(payload.get("captured_at", time.time())),
        )


class EspnAuthenticator:
    """Obtain ESPN cookies needed for private league API access."""

    def __init__(self, settings: AppSettings) -> None:
        self.settings = settings
        self._data_dir = settings.data_root / "raw" / "auth"
        self._data_dir.mkdir(parents=True, exist_ok=True)
        self._cookies_file = self._data_dir / "espn_cookies.json"

    def _build_client(self) -> httpx.Client:
        headers = {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Origin": "https://www.espn.com",
            "Referer": "https://www.espn.com/",
            "Content-Type": "application/json",
        }
        return httpx.Client(headers=headers, timeout=DEFAULT_TIMEOUT, follow_redirects=True)

    def login(
        self,
        league_url: Optional[str] = None,
        mode: str = "auto",
        headless: bool = True,
    ) -> EspnCookies:
        if not self.settings.espn_email or not self.settings.espn_password:
            raise ValueError("ESPN_EMAIL and ESPN_PASSWORD must be configured to login.")

        last_error: Optional[Exception] = None

        if mode in {"auto", "api"}:
            try:
                return self._login_via_api(league_url)
            except Exception as exc:  # pragma: no cover - API fallback path
                last_error = exc
                if mode == "api":
                    raise

        if mode in {"auto", "browser"}:
            try:
                return self._login_via_browser(league_url, headless=headless)
            except Exception as exc:  # pragma: no cover - surface browser failure
                last_error = exc
                if mode == "browser":
                    raise

        raise RuntimeError(
            "Failed to obtain ESPN cookies via API or browser automation. "
            + (f"Last error: {last_error}" if last_error else "")
        )

    def _login_via_api(self, league_url: Optional[str]) -> EspnCookies:
        params = {"lang": "en-US", "region": "us"}
        payload = {"loginValue": self.settings.espn_email, "password": self.settings.espn_password}

        with self._build_client() as client:
            client.get(ESPN_HOME_URL)
            response = client.post(LOGIN_URL, params=params, json=payload)
            response.raise_for_status()

            target_url = league_url or FANTASY_HOME_URL
            fantasy_resp = client.get(target_url)
            fantasy_resp.raise_for_status()

            swid = client.cookies.get("SWID")
            espn_s2 = client.cookies.get("espn_s2")

            if not swid or not espn_s2:
                raise RuntimeError("Login succeeded but cookies missing (espn_s2 / SWID).")

            cookies = EspnCookies(espn_s2=espn_s2, swid=swid, captured_at=time.time())
            self._save(cookies)
            return cookies

    def _login_via_browser(self, league_url: Optional[str], headless: bool) -> EspnCookies:
        target_url = league_url or FANTASY_HOME_URL

        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=headless)
                context = browser.new_context()
                page = context.new_page()
                page.goto("https://www.espn.com/login/")
                page.wait_for_load_state("networkidle")

                login_frame = next(
                    frame for frame in page.frames if "cdn.registerdisney.go.com" in frame.url
                )

                email_input = login_frame.wait_for_selector("input[type='email']", timeout=15000)
                password_input = login_frame.wait_for_selector("input[type='password']", timeout=15000)

                email_input.fill(self.settings.espn_email)
                password_input.fill(self.settings.espn_password)

                submit_btn = login_frame.wait_for_selector("button[type='submit']", timeout=15000)
                submit_btn.click()

                page.wait_for_timeout(3000)
                page.goto(target_url)
                page.wait_for_load_state("networkidle")

                cookie_list = context.cookies()
                cookies = {cookie["name"]: cookie["value"] for cookie in cookie_list}
                browser.close()
        except PlaywrightError as exc:  # pragma: no cover - automation failure
            raise RuntimeError(
                "Playwright automation failed. Ensure browsers are installed via "
                "`poetry run playwright install chromium` and credentials are valid."
            ) from exc

        swid = cookies.get("SWID")
        espn_s2 = cookies.get("espn_s2")

        if not swid or not espn_s2:
            raise RuntimeError("Browser login succeeded but cookies missing (espn_s2 / SWID).")

        cookie_obj = EspnCookies(espn_s2=espn_s2, swid=swid, captured_at=time.time())
        self._save(cookie_obj)
        return cookie_obj

    def manual_login(self, league_url: Optional[str] = None, headless: bool = False) -> EspnCookies:
        """Launch a browser session for the user to log in manually, and capture cookies."""

        target_url = league_url or FANTASY_HOME_URL

        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=headless)
                context = browser.new_context()
                page = context.new_page()
                page.goto("https://www.espn.com/login/")

                # Attempt to pre-fill email if possible, but ignore failures (UI may change).
                try:  # pragma: no cover - best effort helper
                    page.wait_for_timeout(2000)
                    login_frame = next(
                        frame for frame in page.frames if "registerdisney" in frame.url
                    )
                    if self.settings.espn_email:
                        login_frame.wait_for_selector("input[type='email']", timeout=5000).fill(
                            self.settings.espn_email
                        )
                except Exception:
                    pass

                print(
                    "A Chromium window has opened. Complete the ESPN login (solve any prompts),\n"
                    "then return to this terminal and press Enter."
                )
                input("Press Enter once you are fully logged in...")

                page.goto(target_url)
                page.wait_for_timeout(3000)

                cookies = {cookie["name"]: cookie["value"] for cookie in context.cookies()}
                browser.close()
        except PlaywrightError as exc:  # pragma: no cover - automation failure
            raise RuntimeError(
                "Playwright manual session failed. Ensure browsers are installed via `poetry run ``"
                "playwright install chromium`."
            ) from exc

        swid = cookies.get("SWID")
        espn_s2 = cookies.get("espn_s2")

        if not swid or not espn_s2:
            raise RuntimeError(
                "Manual login session completed but required cookies (espn_s2 / SWID) were not found."
            )

        cookie_obj = EspnCookies(espn_s2=espn_s2, swid=swid, captured_at=time.time())
        self._save(cookie_obj)
        return cookie_obj

    def _save(self, cookies: EspnCookies) -> None:
        self._cookies_file.write_text(json.dumps(cookies.to_dict(), indent=2))

    def load_saved(self) -> Optional[EspnCookies]:
        if not self._cookies_file.exists():
            return None
        return EspnCookies.from_dict(json.loads(self._cookies_file.read_text()))


__all__ = ["EspnAuthenticator", "EspnCookies"]
