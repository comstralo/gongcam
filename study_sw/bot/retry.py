import functools
import time


def retry_action(
    max_retries=4, delay=5, task_name="작업", send_emergency=True, fallback_func=None
):
    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            # 🔧 [ctx 리팩터] 데코레이터가 적용되는 함수들은 모두 ctx를 첫 번째
            # 위치 인자로 받도록 통일되어 있으므로, 여기서 ctx를 꺼내 로거/텔레그램
            # 접근에 사용한다.
            ctx = args[0]
            for i in range(max_retries):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    if i == max_retries - 1:
                        log_text = f"🚨 [{task_name}] 최종 실패. 🚨\n{e}"
                        ctx.logger.error(log_text)
                        if send_emergency:
                            # 🔧 순환 임포트 방지: retry.py는 의존성 없는 최하위 모듈로 두고,
                            # send_chat_telegram은 호출 시점에만 지역 임포트한다
                            # (bot.telegram이 bot.retry를 임포트하므로 최상단 임포트 시 순환 발생).
                            from bot.telegram import send_chat_telegram

                            send_chat_telegram(ctx, ["emergency", [log_text]])
                        return False
                    else:
                        print(
                            f"⚠️ [{task_name}] 에러. {i+1}/{max_retries} 재시도 중... ⚠️\n{e}"
                        )
                        time.sleep(delay)

                        # 🔥 꿀팁: 에러 발생 시 복구 함수(fallback)가 지정되어 있으면 실행!
                        # 🔧 [ctx 리팩터] fallback_func는 현재 호출의 ctx를 받도록 ctx를 인자로 넘겨준다.
                        if fallback_func:
                            fallback_func(ctx)

        return wrapper

    return decorator
