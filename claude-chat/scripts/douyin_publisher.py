#!/usr/bin/env python3
"""
Douyin Creator Web Publisher (https://creator.douyin.com)
Uses local Chrome + Playwright with a persistent user profile so the user logs in once.

Safe-by-default workflow:
- check-login / login: verifies login state; captures QR screenshot if not logged in.
- publish-video / publish-images: uploads media, fills title/description/tags, captures a preview
  screenshot, and STOPS before clicking final Publish unless --publish is explicitly passed.
- Never attempts to bypass CAPTCHAs or human verification: pauses and returns a screenshot instead.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright

DOUYIN_HOME_URL = "https://creator.douyin.com/creator-micro/home"
DOUYIN_VIDEO_UPLOAD_URL = "https://creator.douyin.com/creator-micro/content/upload"
DOUYIN_IMAGE_UPLOAD_URL = "https://creator.douyin.com/creator-micro/content/upload?default-tab=3"


def default_profile_dir() -> str:
    appdata = os.environ.get("APPDATA") or str(Path.home())
    return str(Path(appdata) / "com.inkfellow.app" / "claude-chat" / "creator-profiles" / "douyin")


def emit(payload: dict[str, Any], exit_code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(exit_code)


def launch_context(pw, profile_dir: str, headless: bool):
    Path(profile_dir).mkdir(parents=True, exist_ok=True)
    kwargs: dict[str, Any] = {
        "user_data_dir": profile_dir,
        "headless": headless,
        "viewport": {"width": 1366, "height": 900},
        "args": ["--disable-blink-features=AutomationControlled"],
    }
    try:
        return pw.chromium.launch_persistent_context(channel="chrome", **kwargs)
    except Exception:
        try:
            return pw.chromium.launch_persistent_context(channel="msedge", **kwargs)
        except Exception:
            return pw.chromium.launch_persistent_context(**kwargs)


def save_shot(page, path: str | None) -> str | None:
    if not path:
        return None
    out = Path(path).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(out), full_page=False)
    return str(out)


def is_login_page(page) -> bool:
    url = (page.url or "").lower()
    if any(k in url for k in ("login", "passport", "sso")):
        return True
    try:
        body = page.locator("body").inner_text(timeout=3000)
        if any(k in body for k in ("扫码登录", "打开「抖音APP」", "验证码登录", "获取验证码", "我是MCN机构")):
            return True
    except Exception:
        pass
    return False


def has_verification_gate(page) -> bool:
    try:
        body = page.locator("body").inner_text(timeout=2000)
        return any(k in body for k in ("安全验证", "请完成下列验证", "滑动拼图", "拖动下方滑块", "验证以继续"))
    except Exception:
        return False


def fill_title_and_desc(page, title: str, desc: str, tags: list[str]) -> None:
    # Title input
    if title:
        for selector in (
            'input[placeholder*="填写作品标题"]',
            'input[placeholder*="标题"]',
            'input[maxlength="30"]',
        ):
            loc = page.locator(selector).first
            try:
                if loc.is_visible(timeout=2000):
                    loc.click()
                    loc.fill(title[:30])
                    break
            except Exception:
                continue

    # Description / caption editor
    full_desc = (desc or "").strip()
    clean_tags = [f"#{t.lstrip('#').strip()}" for t in tags if t and t.strip()]
    if clean_tags:
        tag_str = " ".join(clean_tags)
        full_desc = f"{full_desc}\n{tag_str}".strip() if full_desc else tag_str

    if full_desc:
        for selector in (
            'div[contenteditable="true"][data-placeholder*="作品简介"]',
            'div[contenteditable="true"][data-placeholder*="描述"]',
            'div.zone-container[contenteditable="true"]',
            'div[contenteditable="true"]',
        ):
            loc = page.locator(selector).first
            try:
                if loc.is_visible(timeout=2500):
                    loc.click()
                    page.keyboard.press("Control+A")
                    page.keyboard.press("Backspace")
                    page.keyboard.insert_text(full_desc)
                    break
            except Exception:
                continue


def click_first_visible(page, labels: list[str], timeout_ms: int = 4000) -> bool:
    for label in labels:
        for loc in (
            page.get_by_role("button", name=label, exact=True).first,
            page.locator(f'button:has-text("{label}")').first,
        ):
            try:
                if loc.is_visible(timeout=timeout_ms):
                    loc.click()
                    return True
            except Exception:
                continue
    return False


def cmd_check_login(args) -> None:
    with sync_playwright() as pw:
        ctx = launch_context(pw, args.profile_dir, headless=args.headless)
        try:
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.goto(DOUYIN_HOME_URL, wait_until="domcontentloaded", timeout=45000)
            page.wait_for_timeout(3500)
            shot = save_shot(page, args.screenshot)
            if has_verification_gate(page):
                emit({
                    "ok": False,
                    "loggedIn": False,
                    "status": "need_verification",
                    "url": page.url,
                    "screenshot": shot,
                    "message": "抖音创作者中心触发了安全验证，请人工完成验证后再继续。",
                }, 2)
            logged_in = not is_login_page(page)
            emit({
                "ok": logged_in,
                "loggedIn": logged_in,
                "status": "logged_in" if logged_in else "need_login",
                "url": page.url,
                "screenshot": shot,
                "message": "抖音创作者中心已登录。" if logged_in else "抖音创作者中心尚未登录，请用抖音扫码登录。",
            }, 0 if logged_in else 1)
        finally:
            ctx.close()


def cmd_login(args) -> None:
    with sync_playwright() as pw:
        ctx = launch_context(pw, args.profile_dir, headless=False)
        try:
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.goto(DOUYIN_HOME_URL, wait_until="domcontentloaded", timeout=45000)
            page.wait_for_timeout(2500)
            shot = save_shot(page, args.screenshot)
            deadline = time.time() + max(15, args.timeout)
            while time.time() < deadline:
                if not is_login_page(page) and not has_verification_gate(page):
                    final_shot = save_shot(page, args.screenshot)
                    emit({
                        "ok": True,
                        "loggedIn": True,
                        "status": "logged_in",
                        "url": page.url,
                        "screenshot": final_shot or shot,
                        "message": "抖音创作者中心登录成功，登录态已保存。",
                    })
                page.wait_for_timeout(2000)
            emit({
                "ok": False,
                "loggedIn": False,
                "status": "login_timeout",
                "url": page.url,
                "screenshot": shot,
                "message": "等待抖音扫码登录超时，请重新运行 login。",
            }, 1)
        finally:
            ctx.close()


def run_publish(args, is_video: bool) -> None:
    media_paths: list[str] = []
    if is_video:
        p = Path(args.video).expanduser().resolve()
        if not p.is_file():
            emit({"ok": False, "error": f"视频文件不存在: {p}"}, 1)
        media_paths = [str(p)]
    else:
        for raw in args.images:
            p = Path(raw).expanduser().resolve()
            if not p.is_file():
                emit({"ok": False, "error": f"图片文件不存在: {p}"}, 1)
            media_paths.append(str(p))
        if not media_paths:
            emit({"ok": False, "error": "图文发布至少需要 1 张图片"}, 1)

    title = args.title or ""
    if args.title_file:
        title = Path(args.title_file).read_text(encoding="utf-8").strip()
    desc = args.desc or ""
    if args.desc_file:
        desc = Path(args.desc_file).read_text(encoding="utf-8").strip()

    with sync_playwright() as pw:
        ctx = launch_context(pw, args.profile_dir, headless=args.headless)
        try:
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            target_url = DOUYIN_VIDEO_UPLOAD_URL if is_video else DOUYIN_IMAGE_UPLOAD_URL
            page.goto(target_url, wait_until="domcontentloaded", timeout=45000)
            page.wait_for_timeout(3500)

            if is_login_page(page):
                shot = save_shot(page, args.screenshot)
                emit({
                    "ok": False,
                    "status": "need_login",
                    "url": page.url,
                    "screenshot": shot,
                    "message": "抖音创作者中心未登录，请先扫码登录（可把登录页截图发给用户或在电脑端完成扫码）。",
                }, 1)

            if has_verification_gate(page):
                shot = save_shot(page, args.screenshot)
                emit({
                    "ok": False,
                    "status": "need_verification",
                    "url": page.url,
                    "screenshot": shot,
                    "message": "抖音页面触发了安全验证，请用户人工验证后再继续。",
                }, 2)

            file_input = page.locator('input[type="file"]').first
            file_input.wait_for(state="attached", timeout=20000)
            file_input.set_input_files(media_paths if len(media_paths) > 1 else media_paths[0])

            # Wait for editor/form to appear after upload starts
            wait_seconds = 12 if is_video else 6
            page.wait_for_timeout(wait_seconds * 1000)
            fill_title_and_desc(page, title, desc, args.tags or [])
            page.wait_for_timeout(2000)

            if has_verification_gate(page):
                shot = save_shot(page, args.screenshot)
                emit({
                    "ok": False,
                    "status": "need_verification",
                    "url": page.url,
                    "screenshot": shot,
                    "message": "填写作品信息时触发了安全验证，请用户人工完成。",
                }, 2)

            if args.save_draft:
                clicked = click_first_visible(page, ["暂存离开", "存草稿", "保存草稿"])
                page.wait_for_timeout(2500)
                shot = save_shot(page, args.screenshot)
                emit({
                    "ok": clicked,
                    "mode": "draft",
                    "url": page.url,
                    "screenshot": shot,
                    "message": "已保存为抖音草稿，请确认后再正式发布。" if clicked else "已填写表单但未找到草稿按钮，请查看截图。",
                }, 0 if clicked else 1)

            if not args.publish:
                shot = save_shot(page, args.screenshot)
                emit({
                    "ok": True,
                    "mode": "preview",
                    "url": page.url,
                    "screenshot": shot,
                    "message": "已在抖音创作者页填好素材与文案（预览态，未点击发布）。请先发截图给用户确认，确认后再带 --publish 执行正式发布。",
                })

            # Final publish (only when explicitly requested with --publish)
            if is_video:
                # Wait up to 90s for publish button to become enabled after video transcoding
                deadline = time.time() + 90
                while time.time() < deadline:
                    btn = page.get_by_role("button", name="发布", exact=True).first
                    try:
                        if btn.is_visible(timeout=1000) and btn.is_enabled():
                            break
                    except Exception:
                        pass
                    page.wait_for_timeout(2000)

            clicked = click_first_visible(page, ["发布", "立即发布"])
            page.wait_for_timeout(4000)
            if has_verification_gate(page):
                shot = save_shot(page, args.screenshot)
                emit({
                    "ok": False,
                    "status": "need_verification",
                    "url": page.url,
                    "screenshot": shot,
                    "message": "点击发布后触发了抖音安全验证，请人工完成验证。",
                }, 2)
            shot = save_shot(page, args.screenshot)
            emit({
                "ok": clicked,
                "mode": "published",
                "url": page.url,
                "screenshot": shot,
                "message": "已点击抖音发布按钮，请核对截图确认发布状态。" if clicked else "未找到可点击的发布按钮，请检查视频是否仍在转码或页面已变更。",
            }, 0 if clicked else 1)
        finally:
            ctx.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Douyin Creator Web Publisher")
    parser.add_argument("--profile-dir", default=default_profile_dir(), help="Persistent Chrome profile directory")
    parser.add_argument("--headless", action="store_true", help="Run Chrome in headless mode")
    parser.add_argument("--screenshot", default=None, help="Optional PNG path to save page screenshot")

    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check-login", help="Check whether Douyin Creator Center is logged in")

    p_login = sub.add_parser("login", help="Open visible browser to scan Douyin QR code")
    p_login.add_argument("--timeout", type=int, default=180)

    def add_publish_common(p):
        p.add_argument("--title", default="")
        p.add_argument("--title-file", default=None)
        p.add_argument("--desc", default="")
        p.add_argument("--desc-file", default=None)
        p.add_argument("--tags", nargs="*", default=[])
        p.add_argument("--preview", action="store_true", help="Fill form & screenshot only (default)")
        p.add_argument("--save-draft", action="store_true", help="Save to Douyin drafts")
        p.add_argument("--publish", action="store_true", help="Actually click Publish (only after user confirmation)")

    p_vid = sub.add_parser("publish-video", help="Upload and publish (or preview) a Douyin video")
    p_vid.add_argument("--video", required=True, help="Absolute path to local .mp4 video")
    add_publish_common(p_vid)

    p_img = sub.add_parser("publish-images", help="Upload and publish (or preview) Douyin image-text post")
    p_img.add_argument("--images", nargs="+", required=True, help="Absolute paths to local images")
    add_publish_common(p_img)

    args = parser.parse_args()
    try:
        if args.command == "check-login":
            cmd_check_login(args)
        elif args.command == "login":
            cmd_login(args)
        elif args.command == "publish-video":
            run_publish(args, is_video=True)
        elif args.command == "publish-images":
            run_publish(args, is_video=False)
    except Exception as exc:
        emit({"ok": False, "error": str(exc)}, 1)


if __name__ == "__main__":
    main()
