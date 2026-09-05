import html
import os

import requests

from bot.retry import retry_action


# [MAIN] 텔레그램에 채팅 전송
# [서브 함수 1] 제보 파일 전송 전담 (데코레이터 장착)
# 🔧 [ctx 리팩터] 이 함수 자체는 ctx 상태를 쓰지 않지만, retry_action의 wrapper가
# 실패 시 ctx.logger에 접근하기 위해 첫 인자로 ctx를 요구하므로 그대로 받는다.
@retry_action(task_name="텔레그램 제보 파일 전송", send_emergency=False)
def _send_telegram_report(ctx, token, chat_id, screenshot_path, message):
    url = f"https://api.telegram.org/bot{token}/sendDocument"
    with open(screenshot_path, "rb") as photo:
        data = {"chat_id": chat_id, "caption": message, "parse_mode": "Markdown"}
        files = {"document": photo}
        response = requests.post(url, data=data, files=files, timeout=15)
    response.raise_for_status()
    return response.json()


# [서브 함수 1-1] 제보 영상 전송 전담 (데코레이터 장착)
@retry_action(task_name="텔레그램 제보 영상 전송", send_emergency=False)
def _send_telegram_video(ctx, token, chat_id, video_path, message):
    url = f"https://api.telegram.org/bot{token}/sendVideo"
    with open(video_path, "rb") as video:
        data = {"chat_id": chat_id, "caption": message, "parse_mode": "Markdown"}
        files = {"video": video}
        response = requests.post(url, data=data, files=files, timeout=60)
    response.raise_for_status()
    return response.json()


# [서브 함수 2] 긴급 메시지 전송 전담 (데코레이터 장착)
@retry_action(task_name="텔레그램 긴급 메시지 전송", send_emergency=False)
def _send_telegram_emergency(ctx, token, chat_id, message):
    escaped_message = html.escape(message)
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = {
        "chat_id": chat_id,
        "text": f"<pre>{escaped_message}</pre>",
        "parse_mode": "HTML",
    }
    response = requests.post(url, data=data, timeout=15)
    response.raise_for_status()
    return response.json()


# [메인 함수] 이제 반복문 없이 라우팅(연결) 역할만 수행!
def send_chat_telegram(ctx, send_list):
    token = os.getenv("TELEGRAM_TOKEN")
    chat_id = os.getenv("TELEGRAM_CHAT_ID")

    chat_kind = send_list[0]
    chat_data = send_list[1]

    if chat_kind == "report":
        return _send_telegram_report(ctx, token, chat_id, chat_data[0], chat_data[1])
    elif chat_kind == "report_video":
        return _send_telegram_video(ctx, token, chat_id, chat_data[0], chat_data[1])
    elif chat_kind == "emergency":
        return _send_telegram_emergency(ctx, token, chat_id, chat_data[0])
