import importlib
import os
import time
import uuid
from datetime import datetime
from io import BytesIO

import cv2
import numpy as np
import requests
from PIL import Image, ImageDraw, ImageFont
from selenium.webdriver.common.by import By

from assets import tracking_list
from bot import capture_manifest
from bot.telegram import send_chat_telegram
from bot.threads import (
    clear_inflight_snapshot,
    is_current_thread,
    remove_thread_id,
    save_inflight_snapshot,
    save_task_to_disk,
)

# [촬영 진행 중 카운트다운] 캡처가 실제로 끝난 시점을 Worker에 알려, "최근
# 진행된 제보" 화면이 20분 재제보 쿨다운 대신 촬영 예상 소요시간으로
# 카운트다운을 보여주다가 이 신호를 받으면 20분 카운트다운으로 전환하게
# 한다(roster_sync.py와 동일한 봇→Worker POST + X-Bot-Secret 패턴).
WORKER_BASE = "https://frame-checker-worker.comstralo.workers.dev"
BOT_SECRET = os.getenv("BOT_SECRET")


def _notify_capture_done(ctx, report_id):
    if not report_id or not BOT_SECRET:
        return
    # 🔧 [버그 수정] 재시도가 전혀 없어 순간적인 네트워크 문제로 이 요청 한
    # 번만 실패해도 20분 재제보 쿨다운이 캡처 완료 시점으로 재시작되지
    # 못하고 원래 접수 시각 기준으로 짧게 끝나버렸다(촬영 시간만큼 재제보를
    # 더 빨리 허용하게 되는 부작용). 짧은 간격으로 최대 3번 재시도한다 —
    # 캡처 스레드 안에서 동기 호출되므로 지연을 과하게 주지 않는다.
    last_err = None
    for attempt in range(3):
        try:
            requests.post(
                f"{WORKER_BASE}/reports/capture-done",
                json={"id": report_id},
                headers={"X-Bot-Secret": BOT_SECRET},
                timeout=10,
            )
            return
        except Exception as e:
            last_err = e
            if attempt < 2:
                time.sleep(2)
    ctx.logger.warning(f"⚠️ [웹 제보 수신] 캡처 완료 알림 실패(3회 재시도 후 포기): {last_err}")


def _find_target_area(ctx, target_name):
    """현재 화면의 참여자 비디오 영역들 중 닉네임이 target_name과 일치하는
    요소를 찾는다. free/premium 모두 실제로는 같은 클래스(span.room-user-nickname)로
    닉네임을 담고 있음을 실측으로 확인했다. .text 대신 textContent를 쓰는 이유는
    bot/roster_sync.py에서 겪은 것과 동일 — 사이드 패널을 닫아두면 요소가
    화면에 안 보여 .text가 항상 빈 문자열을 반환하기 때문이다. 호출부에서
    ctx.lock_element로 감싸야 한다."""
    video_areas = ctx.driver.find_elements(By.CSS_SELECTOR, ".video-layer.mixing-user")
    if not video_areas:
        video_areas = ctx.driver.find_elements(By.CSS_SELECTOR, ".video-grid-area")

    for area in video_areas:
        try:
            nickname_el = area.find_element(By.CSS_SELECTOR, "span.room-user-nickname")
            area_name = (nickname_el.get_attribute("textContent") or "").strip()
        except Exception:
            continue
        if target_name == area_name:
            return area
    return None


GRID_ROWS = 3
GRID_COLS = 4
GRID_COLOR = (255, 255, 255, 50)


def _draw_grid_overlay(img):
    """스크린샷 모드(tracking_capture)와 동일한 3x4 격자선을 이미지 위에
    알파 합성해서 그린 새 이미지를 반환한다. 영상 모드가 프레임마다 재사용한다."""
    base_img = img.convert("RGBA")
    overlay = Image.new("RGBA", base_img.size, (255, 255, 255, 0))
    draw = ImageDraw.Draw(overlay)
    for i in range(1, GRID_ROWS):
        y = (base_img.height / GRID_ROWS) * i
        draw.line([(0, y), (base_img.width, y)], fill=GRID_COLOR, width=1)
    for i in range(1, GRID_COLS):
        x = (base_img.width / GRID_COLS) * i
        draw.line([(x, 0), (x, base_img.height)], fill=GRID_COLOR, width=1)
    return Image.alpha_composite(base_img, overlay)


def _capture_area_bytes(ctx, area):
    """area.screenshot_as_png는 요소가 뷰포트 밖에 있으면 Selenium이 내부적으로
    scrollIntoView를 실행해 실제 브라우저 창이 순간적으로 스크롤/점프한다.
    영상 모드는 0.5초 간격으로 이걸 반복 호출해 화면이 심하게 깜빡이는 원인이
    됐다(사용자 보고로 확인). 스터디룸 비디오 그리드는 스크롤이 없는 고정
    레이아웃이므로, 전체 창을 한 번 캡처한 뒤 요소 위치만큼 잘라내는 방식으로
    스크롤 자체를 없앤다. 호출부에서 ctx.lock_element로 감싸야 한다.

    화면 캡처와 좌표 조회는 별개의 명령이라 완전히 동시에 일어나지 않는다.
    구루미가 레이아웃을 CSS 트랜지션으로 애니메이션하는 도중이면 그 사이에
    좌표가 바뀌어 잘라내는 위치가 실제 픽셀과 어긋날 수 있다. 캡처 전후로
    좌표를 각각 읽어 비교해서, 바뀌었으면(=전환 중) 신뢰할 수 없는 컷으로
    보고 None을 반환한다 — 호출부는 이를 "이번 틱은 탐지 실패"와 동일하게
    처리한다."""
    try:
        loc_before = area.location
        size_before = area.size
    except Exception:
        return None

    png_bytes = ctx.driver.get_screenshot_as_png()

    try:
        loc_after = area.location
        size_after = area.size
    except Exception:
        return None

    if loc_before != loc_after or size_before != size_after:
        return None

    full_img = Image.open(BytesIO(png_bytes))

    inner_width = ctx.driver.execute_script("return window.innerWidth")
    inner_height = ctx.driver.execute_script("return window.innerHeight")
    scale_x = full_img.width / inner_width if inner_width else 1
    scale_y = full_img.height / inner_height if inner_height else 1

    left = int(loc_after["x"] * scale_x)
    top = int(loc_after["y"] * scale_y)
    right = int((loc_after["x"] + size_after["width"]) * scale_x)
    bottom = int((loc_after["y"] + size_after["height"]) * scale_y)

    cropped = full_img.crop((left, top, right, bottom))
    buf = BytesIO()
    cropped.save(buf, format="PNG")
    return buf.getvalue()


# [MAIN] 감독 및 캡처
def tracking_capture(
    ctx,
    target_name,
    reason_txt,
    sender_name,
    thread_id,
    manual_count=None,
    manual_interval=None,
    previous_temp_files=None,
    report_id=None,
    self_check=False,
    reporter_name=None,
):

    grid_rows = GRID_ROWS
    grid_cols = GRID_COLS
    grid_color = GRID_COLOR
    circled_nums = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮"

    screenshots = []  # 현재 세트(6장)를 담을 버퍼
    # 즉사 방어용 스냅샷이 매 캡처마다 만드는 임시 파일들 — 다음 스냅샷을
    # 찍기 전에 이전 파일들을 지워야 temp 폴더에 중복이 쌓이지 않는다.
    # 🔧 [버그 수정] 원래는 항상 빈 리스트로 시작했다 — previous_temp_files로
    # 복구된 세션은 그 이미지들이 screenshots에 이미 채워져 있는데도
    # inflight_temp_paths는 모른 채로 시작해, 다음 스냅샷 갱신/재중단 시점에
    # screenshots 전체(복구분+신규분)를 새 파일명으로 다시 저장하면서
    # inflight_temp_paths에 없던 원본 previous_temp_files는 지우지 않아
    # 디스크에 참조되지 않는 고아 파일로 영구히 남았다(재개가 반복되거나
    # 재개 후 다시 중단될 때마다 누적). previous_temp_files 중 실제로
    # 불러오기에 성공한 파일만 초기값으로 채워, 이후 정리 로직이 이들도
    # 함께 추적하게 한다.
    inflight_temp_paths = []

    # 🔄 [1] 복구 로직: 이전에 찍어둔 파일이 있으면 불러오기
    if previous_temp_files:
        ctx.logger.info(
            f"tracking_capture() : 📂 [{thread_id}] 이전 사진 {len(previous_temp_files)}장을 불러옵니다."
        )
        for p_path in previous_temp_files:
            try:
                if os.path.exists(p_path):
                    screenshots.append(Image.open(p_path))
                    inflight_temp_paths.append(p_path)
            except Exception as e:
                ctx.logger.warning(f"이미지 복구 실패: {p_path} - {e}")

    # 현재 세션(루프)에서 찍은 횟수
    current_session_capture_count = 0

    # 목표 횟수 설정 (제보의 경우 기본 6회)
    track_total = 6
    if manual_count is not None:
        track_total = manual_count

    target_interval = manual_interval if manual_interval else 30
    # 🔧 [절대 시간 스케줄링] 이전에는 매 반복마다 "이번 루프가 몇 초 걸렸는지"를
    # 재보고 그만큼만 보정해서 잤다 — 이 방식은 한 번이라도 오래 걸리는 루프가
    # 생기면(락 경합, 네트워크 지연 등) 그 지연이 이후 모든 캡처 시점에 영구히
    # 누적되어 밀린다(따라잡지 못함). 대신 이 세션이 시작된 절대 시각을 기준으로
    # "N번째 캡처는 session_start + N*interval 시점에 일어나야 한다"는 고정된
    # 시간표를 미리 정해두고, 매번 그 절대 시각까지 남은 시간만 계산해서 잔다.
    # 이러면 어느 한 번이 늦어져도 다음 캡처가 원래 시간표로 스스로 따라잡는다.
    session_start_time = time.monotonic()

    # ---------------- 내부 함수 ----------------
    def draw_grid(draw_obj, width, height):
        for i in range(1, grid_rows):
            y = (height / grid_rows) * i
            draw_obj.line([(0, y), (width, y)], fill=grid_color, width=1)
        for i in range(1, grid_cols):
            x = (width / grid_cols) * i
            draw_obj.line([(x, 0), (x, height)], fill=grid_color, width=1)

    # 🚀 [수정] 자물쇠 안에서 실행될 가벼운 캡처 함수 (이미지 바이트만 추출)
    def get_screenshot_bytes(area):
        try:
            buttons_to_hide = area.find_element(
                By.CSS_SELECTOR, ".user-video-cover-btns"
            )
            ctx.driver.execute_script(
                "arguments[0].style.visibility = 'hidden';", buttons_to_hide
            )
        except:
            pass
        return _capture_area_bytes(ctx, area)

    # 🚀 [수정] 자물쇠 밖에서 실행될 무거운 이미지 가공 함수 (기존 capture 함수의 절반)
    def process_image(img_bytes):
        base_img = Image.open(BytesIO(img_bytes)).convert("RGBA")
        overlay = Image.new("RGBA", base_img.size, (255, 255, 255, 0))
        draw = ImageDraw.Draw(overlay)
        draw_grid(draw, base_img.width, base_img.height)

        # 번호 매기기 (현재 세트 내 번호 0~5)
        total_idx = len(screenshots)
        num_mark = (
            circled_nums[total_idx]
            if total_idx < len(circled_nums)
            else f"({total_idx+1})"
        )

        font = ImageFont.truetype("./assets/NanumGothicBold.ttf", size=15)
        text = f"{num_mark} {datetime.now().strftime('%y%m%d-%H:%M:%S')}"

        bbox = draw.textbbox((0, 0), text, font=font)
        text_width, text_height = (bbox[2] - bbox[0], bbox[3] - bbox[1])
        padding = 10
        bg_w, bg_h = text_width + (2 * padding), text_height + (2 * padding)
        bg_x, bg_y = (base_img.width - bg_w) / 2, 10
        draw.rectangle([(bg_x, bg_y), (bg_x + bg_w, bg_y + bg_h)], fill=(0, 0, 0, 50))
        draw.text(
            (bg_x + bg_w / 2, bg_y + bg_h / 2),
            text,
            fill="yellow",
            font=font,
            anchor="mm",
        )

        final_img = Image.alpha_composite(base_img, overlay)
        screenshots.append(final_img)

    def create_placeholder():
        base_img = Image.new("RGBA", (480, 270), "black")
        overlay = Image.new("RGBA", base_img.size, (255, 255, 255, 0))
        draw = ImageDraw.Draw(overlay)
        draw_grid(draw, base_img.width, base_img.height)

        total_idx = len(screenshots)
        num_mark = (
            circled_nums[total_idx]
            if total_idx < len(circled_nums)
            else f"({total_idx+1})"
        )

        font = ImageFont.truetype("./assets/NanumGothicBold.ttf", size=15)
        text = f"{num_mark} [{target_name}] 탐지되지 않음\n{datetime.now().strftime('%H:%M:%S')}"

        bbox = draw.textbbox((0, 0), text, font=font, align="center")
        text_width, text_height = bbox[2] - bbox[0], bbox[3] - bbox[1]
        text_x, text_y = (base_img.width - text_width) / 2, (
            base_img.height - text_height
        ) / 2
        draw.text((text_x, text_y), text, fill="white", font=font, align="center")

        return Image.alpha_composite(base_img, overlay)

    def save_capture():
        # screenshots가 비어있지 않을 때만 실행
        if screenshots:
            try:
                max_width = max(img.width for img in screenshots)
                max_height = max(img.height for img in screenshots)
                resized_screenshots = [
                    img.resize((max_width, max_height), Image.LANCZOS)
                    for img in screenshots
                ]

                count = len(resized_screenshots)
                # 레이아웃 로직
                if count <= 2:
                    cols, rows = (1, 2) if count == 1 else (2, 1)
                elif count <= 4:
                    cols, rows = 2, 2
                elif count <= 6:
                    cols, rows = 3, 2  # 6장이면 3열 2행
                elif count <= 9:
                    cols, rows = 3, 3
                else:
                    cols, rows = 4, (count + 3) // 4

                combined = Image.new("RGB", (max_width * cols, max_height * rows))
                for i, img in enumerate(resized_screenshots):
                    combined.paste(
                        img,
                        ((i % cols) * max_width, (i // cols) * max_height),
                        mask=img,
                    )

                timestamp_chat = datetime.now().strftime("%y%m%d-%H:%M")
                # 🔧 [버그 수정] 원래는 "초 단위 시각 + 대상 닉네임"만으로 파일명을
                # 만들었다 — 같은 대상을 거의 동시에 두 번 제보하면(관리자는 이미
                # 동시 진행이 허용됨, report_intake.py 참고) 두 tracking_capture
                # 스레드가 같은 초에 save_capture()를 호출할 수 있어 두 번째
                # 저장이 첫 번째 파일을 덮어썼다. 서로 다른 제보는 report_id도
                # 서로 다르므로(짧은 조각만 붙여도 충돌 확률이 사실상 0) 이를
                # 덧붙여 항상 고유한 파일명이 되게 한다.
                unique_suffix = (report_id or uuid.uuid4().hex)[:8]
                filename = f"./runtime/captures/report/{datetime.now().strftime('%y%m%d_%H_%M_%S')}_{target_name}_{unique_suffix}.png"
                os.makedirs(os.path.dirname(filename), exist_ok=True)
                combined.save(filename)
                ctx.logger.info(f"tracking_capture() : 📂 부분 파일 저장 완료: {filename}")

                # 🔧 [버그 수정] 원래는 텔레그램 전송(send_chat_telegram)까지 같은
                # try 블록 안에서 record_capture보다 먼저 실행됐다 — 전송이
                # 예외를 던지면(네트워크 문제 등) record_capture 자체가 호출되지
                # 않아 capture_manifest에 이 제보 건이 통째로 기록되지 않았다.
                # 접수는 정상 완료(_notify_capture_done도 호출됨)되는데 관리자/
                # 본인 화면 어디에도 영원히 나타나지 않는 유실이 발생했다.
                # manifest 기록은 텔레그램 전송 성패와 무관하게 항상 남겨야 하므로
                # 먼저 실행하고, 텔레그램 전송 실패는 별도로 로그만 남긴다.
                capture_manifest.record_capture(
                    report_id, target_name, reason_txt, "screenshot", filename, sender_name, self_check=self_check
                )

                caption_msg = f"🧒 제보자 : {reporter_name or sender_name}\n🧒 대상자 : {target_name}\n🔎 내용 : {reason_txt}\n⏰ 시점 : {timestamp_chat}"
                caption_msg += "\n📷 유형 : 스크린샷"
                try:
                    send_chat_telegram(ctx, ["report", [f"./{filename}", caption_msg]])
                except Exception as telegram_err:
                    ctx.logger.error(f"save_capture() : 텔레그램 전송 실패(기록은 유지됨): {telegram_err}")

                return True  # 성공 리턴
            except Exception as e:
                ctx.logger.error(f"save_capture() 실패: {e}")
                return False

    # ---------------- 메인 루프 ----------------
    while (
        current_session_capture_count < track_total
        and not ctx.stop_event.is_set()
        and is_current_thread(ctx, thread_id)
    ):
        importlib.reload(tracking_list)

        target_found_this_loop = False
        img_bytes_to_process = (
            None  # 🚀 [수정] 자물쇠 구역에서 추출한 데이터를 담을 임시 변수
        )

        # 캡처 시도
        try:
            # 🚀 [수정] 자물쇠 구역 시작 (UI 접근 및 바이트 추출만 빠르게 진행)
            with ctx.lock_element:
                area = _find_target_area(ctx, target_name)
                if area is not None:
                    img_bytes_to_process = get_screenshot_bytes(
                        area
                    )  # 🚀 요소를 찾자마자 바이트만 복사
                    # 레이아웃 전환 중이라 _capture_area_bytes가 None을 반환하면
                    # (좌표가 캡처 전후로 어긋남) 탐지 실패와 동일하게 취급한다.
                    target_found_this_loop = img_bytes_to_process is not None
            # 🚀 자물쇠 구역 끝! 이제 다른 스레드(채팅 발송 등)가 자유롭게 UI에 접근할 수 있습니다.

            # 🚀 [수정] 자물쇠가 풀린 여유로운 상태에서 무거운 이미지 합성(PIL) 작업 수행
            if not target_found_this_loop:
                screenshots.append(create_placeholder())
                print(
                    f"tracking_capture() : ⚠️ {thread_id} 탐지 불가. (세트 내 {len(screenshots)}/6)"
                )
            else:
                process_image(img_bytes_to_process)
                print(
                    f"tracking_capture() : 📸 {thread_id} 캡처 완료. (세트 내 {len(screenshots)}/6)"
                )

            # 6장이 모이면 즉시 전송 시도
            if len(screenshots) >= 6:
                save_capture()  # 성공 여부와 관계없이 시도
                screenshots = []  # 리스트 무조건 초기화 (무한루프 방지)
                # 이 세트는 이미 save_capture()로 전송·기록을 시도했으므로,
                # 즉사해도 다시 재개할 대상이 아니다 — 스냅샷과 그 임시
                # 파일들을 지운다.
                clear_inflight_snapshot(ctx, thread_id)
                for p in inflight_temp_paths:
                    try:
                        os.remove(p)
                    except OSError:
                        pass
                inflight_temp_paths = []
            else:
                # 🔧 [버그 방어] 여기까지 못 오고 프로세스 자체가 즉사하면
                # (OOM killer, kill -9, 정전 등) 아래 "정상 중단 처리"
                # 블록이 실행될 기회가 없어 지금까지 찍은 screenshots가
                # 메모리에서만 사라진다(사용자 확인: 발견한 이상 대비할 것).
                # 한 장 찍을 때마다 지금까지의 진행 상황을 임시 파일 +
                # 스냅샷으로 즉시 디스크에 남겨, 다음 프로그램 시작 시
                # recover_inflight_snapshots가 이를 주워 기존 재개 큐로
                # 합류시킬 수 있게 한다. 이전 스냅샷이 만든 임시 파일들은
                # 먼저 지워야 temp 폴더에 중복이 쌓이지 않는다.
                for p in inflight_temp_paths:
                    try:
                        os.remove(p)
                    except OSError:
                        pass
                temp_dir = "runtime/captures/temp"
                os.makedirs(temp_dir, exist_ok=True)
                inflight_temp_paths = []
                for idx, img in enumerate(screenshots):
                    t_path = f"{temp_dir}/{target_name}_{datetime.now().strftime('%Y%m%d%H%M%S')}_{idx}.png"
                    img.save(t_path)
                    inflight_temp_paths.append(t_path)
                save_inflight_snapshot(
                    ctx,
                    thread_id,
                    {
                        "target_name": target_name,
                        "reason_txt": reason_txt,
                        "sender_name": sender_name,
                        "remaining_count": track_total - (current_session_capture_count + 1),
                        "interval": manual_interval if manual_interval else 30,
                        "previous_temp_files": inflight_temp_paths,
                        "report_id": report_id,
                        "reporter_name": reporter_name,
                    },
                )

            # 전체 횟수 증가 (캡처 성공 여부와 관계없이 시간 흐름에 따라 증가)
            current_session_capture_count += 1

            # 다음 캡처가 일어나야 할 절대 시각까지 남은 시간만큼만 잔다.
            # (session_start_time + N*interval 이라는 고정 시간표를 기준으로 하므로
            # 이번 루프가 얼마나 걸렸든 상관없이 항상 원래 시간표로 수렴한다.)
            next_scheduled_time = session_start_time + (
                current_session_capture_count * target_interval
            )
            sleep_time = next_scheduled_time - time.monotonic()

            if (
                current_session_capture_count < track_total
                and not ctx.stop_event.is_set()
                and is_current_thread(ctx, thread_id)
            ):
                remaining = sleep_time
                while remaining > 0:
                    if ctx.stop_event.is_set() or not is_current_thread(ctx, thread_id):
                        break
                    step = min(1.0, remaining)
                    time.sleep(step)
                    remaining -= step

        # 🏁 에러 발생 시 처리
        except Exception as e:
            ctx.logger.error(f"tracking_capture() : 오류 - {e}")
            # 에러가 나도 진행을 막지 않도록 잠시 대기 후 계속 진행
            time.sleep(5)

    # ---------------- 루프 완전 종료 후 후처리 ----------------

    # 🛑 [중단 처리] 목표 횟수를 다 채우지 못했는데 루프가 깨진 경우 (외부 요인)
    if current_session_capture_count < track_total and (
        ctx.stop_event.is_set() or not is_current_thread(ctx, thread_id)
    ):
        # 이 블록이 정상적인 재개 정보(STATE_FILE)를 새로 만들 것이므로,
        # 즉사 방어용 스냅샷은 먼저 지운다(정상 종료 경로이니 즉사 대비가
        # 더 이상 필요 없음) — clear_inflight_snapshot은 STATE_FILE에는
        # 영향이 없으므로 아래 저장과 독립적으로 안전하다.
        clear_inflight_snapshot(ctx, thread_id)
        temp_dir = "runtime/captures/temp"
        saved_temp_paths = []
        for idx, img in enumerate(screenshots):
            t_path = f"{temp_dir}/{target_name}_{datetime.now().strftime('%Y%m%d%H%M%S')}_{idx}.png"
            img.save(t_path)
            saved_temp_paths.append(t_path)
        # 스냅샷이 마지막으로 저장해 둔 임시 파일들은 위에서 새로 다시
        # 저장했으므로 더 이상 필요 없다 — 지운다(둘 다 같은 screenshots를
        # 담고 있어 내용은 같지만, 파일 경로가 다르므로 정리해야 temp
        # 폴더에 중복이 남지 않는다).
        for p in inflight_temp_paths:
            try:
                os.remove(p)
            except OSError:
                pass

        resume_info = {
            "target_name": target_name,
            "reason_txt": reason_txt,
            "sender_name": sender_name,
            "remaining_count": track_total - current_session_capture_count,
            "interval": manual_interval if manual_interval else 30,
            "previous_temp_files": saved_temp_paths,
            "report_id": report_id,
            "reporter_name": reporter_name,
        }
        save_task_to_disk(ctx, resume_info)
        ctx.logger.warning(f"tracking_capture() : 💾 [{thread_id}] 중단됨. 작업 백업 완료.")
        remove_thread_id(ctx, thread_id)
        return

    # ✅ [정상 종료 처리] 목표 횟수를 무사히 다 채운 경우
    # 마지막에 남은 사진(6장이 안 돼서 전송 안 된 짜투리)이 있으면 전송
    if screenshots:
        save_capture()

    # 복구에 사용되었던 원본 임시 파일들이 있다면 모두 청소
    if previous_temp_files:
        for p_path in previous_temp_files:
            try:
                os.remove(p_path)
            except:
                pass

    # 정상 완료됐으므로 즉사 방어용 스냅샷과 그 임시 파일들도 정리한다.
    clear_inflight_snapshot(ctx, thread_id)
    for p in inflight_temp_paths:
        try:
            os.remove(p)
        except OSError:
            pass

    _notify_capture_done(ctx, report_id)
    remove_thread_id(ctx, thread_id)
    return


# [MAIN] 90초 영상 녹화 및 전송
def tracking_capture_video(
    ctx, target_name, reason_txt, sender_name, thread_id, report_id=None, self_check=False, reporter_name=None
):
    FPS = 2
    DURATION_SEC = 90
    TOTAL_FRAMES = FPS * DURATION_SEC
    FRAME_INTERVAL = 1.0 / FPS
    MIN_FRAMES_TO_SEND = 10  # 이보다 적게 모이고 중단되면 폐기
    # 🔧 [시간 상한] 대상이 화면에서 순간적으로 안 잡히는 틱(레이아웃 전환 중
    # 리렌더링 등)은 프레임으로 카운트되지 않고 건너뛰기만 하므로, "180프레임을
    # 모을 때까지" 조건만 있으면 이런 상황이 겹칠 때 90초를 훨씬 넘겨서까지
    # 녹화가 계속될 수 있다. 실제 경과 시간이 목표의 2배를 넘으면 그때까지
    # 모은 프레임만으로 녹화를 마무리한다.
    MAX_WALL_CLOCK_SEC = DURATION_SEC * 2

    frames = []  # numpy(BGR) 프레임 버퍼
    session_start_time = time.monotonic()

    ctx.logger.info(f"tracking_capture_video() : 🎥 [{thread_id}] 영상 녹화 시작 (목표 {TOTAL_FRAMES}프레임/{DURATION_SEC}초)")

    while (
        len(frames) < TOTAL_FRAMES
        and not ctx.stop_event.is_set()
        and is_current_thread(ctx, thread_id)
    ):
        if time.monotonic() - session_start_time > MAX_WALL_CLOCK_SEC:
            ctx.logger.warning(
                f"tracking_capture_video() : ⚠️ [{thread_id}] 대상 미탐지가 길어져 "
                f"{MAX_WALL_CLOCK_SEC}초 시간 상한에 도달, 지금까지 모은 {len(frames)}프레임으로 마무리합니다."
            )
            break

        loop_start_time = time.monotonic()

        try:
            img_bytes = None
            with ctx.lock_element:
                area = _find_target_area(ctx, target_name)
                if area is not None:
                    img_bytes = _capture_area_bytes(ctx, area)

            if img_bytes is not None:
                pil_img = Image.open(BytesIO(img_bytes)).convert("RGB")
                pil_img = _draw_grid_overlay(pil_img).convert("RGB")
                frame = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
                frames.append(frame)

            loop_end_time = time.monotonic()
            sleep_time = FRAME_INTERVAL - (loop_end_time - loop_start_time)
            if sleep_time > 0:
                time.sleep(sleep_time)

        except Exception as e:
            ctx.logger.error(f"tracking_capture_video() : 오류 - {e}")
            time.sleep(1)

    # 🔧 [버그 수정] 원래는 stop_event/current_threads로 중단된 경우도
    # 그냥 "프레임 부족"과 똑같이 조용히 폐기했다(또는 10프레임을 넘겼으면
    # 마치 정상 완료된 것처럼 그 시점까지의 프레임만으로 잘린 영상을
    # 만들어 보냈다) — record_capture도, 텔레그램 알림도, 재시도도 전혀
    # 없어 봇 재시작(관리자의 수동 "재시작", 매일 07:15 정기 리셋, OOM
    # 비상 복구 세 경로 모두 stop_all_thread로 이 stop_event를 세운다)이
    # 하필 영상 녹화 중(90~180초 창) 발생하면 그 제보가 아무 흔적 없이
    # 영구 소실됐다. 스크린샷 모드(tracking_capture)는 이미 이 경우
    # save_task_to_disk로 재개 정보를 남겨 재시작 후 이어서 진행하는데,
    # 영상은 프레임 단위로 이어붙이는 재개가 비디오 인코딩 특성상 비현실적
    # 이므로(사용자 결정), 같은 report_id로 "처음부터 재녹화"하도록
    # 재개 정보를 남긴다 — remaining_count/previous_temp_files 없이
    # mode:"video"만 표시해 재개 호출부가 tracking_capture_video를 다시
    # 그대로 부르게 한다.
    was_interrupted = ctx.stop_event.is_set() or not is_current_thread(ctx, thread_id)
    if was_interrupted:
        resume_info = {
            "mode": "video",
            "target_name": target_name,
            "reason_txt": reason_txt,
            "sender_name": sender_name,
            "report_id": report_id,
            "reporter_name": reporter_name,
        }
        save_task_to_disk(ctx, resume_info)
        ctx.logger.warning(
            f"tracking_capture_video() : 💾 [{thread_id}] 중단됨({len(frames)}프레임 확보) — 재시작 후 처음부터 재녹화합니다."
        )
        remove_thread_id(ctx, thread_id)
        return

    if len(frames) < MIN_FRAMES_TO_SEND:
        ctx.logger.warning(
            f"tracking_capture_video() : ⚠️ [{thread_id}] 프레임 부족({len(frames)}장)으로 영상 전송을 포기합니다."
        )
        remove_thread_id(ctx, thread_id)
        return

    try:
        # 🔧 [화질 기준 변경] 첫 프레임 크기를 기준으로 삼으면, 녹화 중간에
        # 참여자가 줄어 타일이 커진 경우 오히려 더 큰(선명한) 프레임들이 작은
        # 첫 프레임 크기로 다운스케일된다. 스크린샷 모드(save_capture)와 동일하게
        # 실제로 관측된 프레임들 중 가장 큰 크기를 기준으로 삼아, 작은 프레임만
        # 업스케일되고 큰 프레임의 화질은 그대로 유지되게 한다.
        height = max(f.shape[0] for f in frames)
        width = max(f.shape[1] for f in frames)
        # 🔧 [버그 수정] save_capture()와 동일한 파일명 충돌 문제 — report_id
        # (또는 없으면 uuid) 조각을 덧붙여 항상 고유하게 만든다.
        unique_suffix = (report_id or uuid.uuid4().hex)[:8]
        filename = f"./runtime/captures/report/{datetime.now().strftime('%y%m%d_%H_%M_%S')}_{target_name}_{unique_suffix}.mp4"
        os.makedirs(os.path.dirname(filename), exist_ok=True)

        fourcc = cv2.VideoWriter_fourcc(*"avc1")
        writer = cv2.VideoWriter(filename, fourcc, FPS, (width, height))
        for frame in frames:
            if frame.shape[:2] != (height, width):
                frame = cv2.resize(frame, (width, height))
            writer.write(frame)
        writer.release()

        ctx.logger.info(f"tracking_capture_video() : 📂 영상 저장 완료: {filename} ({len(frames)}프레임)")

        # 🔧 [버그 수정] 스크린샷(save_capture)과 동일한 문제 — 텔레그램 전송이
        # record_capture보다 먼저 실행되어, 전송 실패 시 manifest 기록 자체가
        # 통째로 유실됐다. 영상 인코딩까지 성공했으면 그 결과는 반드시 남겨야
        # 하므로 record_capture/완료 알림을 먼저 실행하고, 텔레그램 전송
        # 실패는 별도로 로그만 남긴다.
        capture_manifest.record_capture(
            report_id, target_name, reason_txt, "video", filename, sender_name, self_check=self_check
        )
        _notify_capture_done(ctx, report_id)

        timestamp_chat = datetime.now().strftime("%y%m%d-%H:%M")
        caption_msg = f"🧒 제보자 : {reporter_name or sender_name}\n🧒 대상자 : {target_name}\n🔎 내용 : {reason_txt}\n⏰ 시점 : {timestamp_chat}"
        caption_msg += "\n📷 유형 : 영상"
        try:
            send_chat_telegram(ctx, ["report_video", [f"./{filename}", caption_msg]])
        except Exception as telegram_err:
            ctx.logger.error(f"tracking_capture_video() : 텔레그램 전송 실패(기록은 유지됨): {telegram_err}")

    except Exception as e:
        ctx.logger.error(f"tracking_capture_video() : 인코딩 실패 - {e}")

    remove_thread_id(ctx, thread_id)
    return
