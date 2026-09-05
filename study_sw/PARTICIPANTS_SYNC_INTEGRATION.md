# 실시간 참여자 명단 → 프레임 체커 연동 가이드

이 파일은 study_manager_260418.py를 직접 수정하는 대신, 어떻게 통합할지 정리한 안내서입니다.
**현재 봇이 다른 환경에서 운영 중이므로, 안전한 시점(재시작 타이밍)에 직접 적용해주세요.**

## 1. .env에 추가할 값

```
FRAME_CHECKER_WORKER_URL=https://frame-checker-worker.comstralo.workers.dev
FRAME_CHECKER_BOT_SECRET=<Cloudflare Worker에 등록한 BOT_SECRET 값과 동일하게>
```

`BOT_SECRET` 값은 Cloudflare 대시보드 (frame-checker-worker → Settings → Variables and Secrets)에서
다시 확인하거나, 필요하면 `npx wrangler secret put BOT_SECRET`로 재발급할 수 있습니다.

## 2. 상단 import 구역에 추가

```python
import requests  # 이미 임포트되어 있음 (24행) — 추가 불필요
```

`requests`는 이미 study_manager_260418.py 24행에서 임포트되어 있으므로 추가 설치/임포트가 필요 없습니다.

## 3. 헬퍼 함수 추가 (예: 2103행, receive_chat 함수 근처 또는 파일 상단 유틸 구역)

기존 코드(2097~2102행, 2168~2172행)에 중복돼 있는 명단 조회 로직을 헬퍼로 분리해 재사용합니다.

```python
FRAME_CHECKER_WORKER_URL = os.getenv("FRAME_CHECKER_WORKER_URL")
FRAME_CHECKER_BOT_SECRET = os.getenv("FRAME_CHECKER_BOT_SECRET")


def get_current_member_list():
    """현재 구루미 스터디룸에 접속 중인 참여자 닉네임 목록을 반환한다."""
    nickname_elements = driver.find_elements(
        By.CSS_SELECTOR,
        "div.room-user-list-body span.room-user-nickname",
    )
    return [element.text for element in nickname_elements]


def push_participants_to_frame_checker():
    """현재 접속 명단을 프레임 체커 Worker(Durable Object)로 전송한다.
    실패해도 캠스터디 운영에는 영향이 없도록 예외를 삼킨다."""
    if not FRAME_CHECKER_WORKER_URL or not FRAME_CHECKER_BOT_SECRET:
        return
    try:
        with lock_element:
            members = get_current_member_list()
        requests.put(
            f"{FRAME_CHECKER_WORKER_URL}/participants",
            json={"members": members},
            headers={"X-Bot-Secret": FRAME_CHECKER_BOT_SECRET},
            timeout=5,
        )
    except Exception as e:
        logging.warning(f"push_participants_to_frame_checker() 실패: {e}")
```

**중요**: 기존 receive_chat() 안의 인라인 명단 조회 코드(2097~2102행, 2168~2172행)는
`lock_element` 락 없이 실행되고 있습니다. 위 헬퍼 함수는 새로 추가되는 폴링 스레드가
다른 스레드(캡처 등)와 동시에 driver를 건드리지 않도록 락으로 감쌌습니다.
기존 두 곳도 이 헬퍼로 교체하며 락을 씌우는 것을 권장합니다 (선택 사항, 필수는 아님).

## 4. 주기적 전송 스레드 추가 (파일 하단, `if __name__ == "__main__":` 진입 전)

기존 코드가 `threading.Thread(..., daemon=True).start()` 패턴(325행 등)을 이미 쓰고 있으므로
동일한 방식으로 데몬 스레드를 하나 추가합니다.

```python
def participants_sync_loop():
    """참여자 명단을 주기적으로 Cloudflare Worker에 동기화한다."""
    while True:
        push_participants_to_frame_checker()
        time.sleep(10)  # 10초 간격 — Durable Object는 쓰기 횟수 제한이 없어 자유롭게 조절 가능


threading.Thread(target=participants_sync_loop, daemon=True).start()
```

이 스레드는 `driver`가 아직 생성되지 않은 시점(로그인 전)에 시작되면 `find_elements` 호출 시
예외가 날 수 있으므로, `driver`가 정상적으로 초기화되고 스터디룸에 입장한 이후 시점
(`_setup_and_enter_room()` 호출 이후)에 스레드를 시작하는 것이 더 안전합니다.
정확한 삽입 위치는 실제 진입 플로우를 보고 조정해주세요.

## 5. 동작 확인 방법 (배포 후)

```bash
curl -H "X-Bot-Secret: <BOT_SECRET>" https://frame-checker-worker.comstralo.workers.dev/participants
```

이 요청은 GET이 아니라 PUT 전용이라 인증 방식이 다릅니다 — 실제 확인은
Worker 로그(`npx wrangler tail`)로 PUT 요청이 들어오는지 보거나,
제보 페이지(report.html)에 로그인해서 드롭다운에 실시간 명단이 뜨는지로 확인하는 것이 정확합니다.

## 반영 시 주의사항

- 이 변경은 **기존 봇 로직을 전혀 건드리지 않고, 완전히 애드온으로 추가**되는 구조입니다.
  Worker 요청이 실패해도 `try/except`로 삼켜지므로 캠스터디 운영 자체에는 영향이 없습니다.
- 반드시 **봇을 재시작해야 하는 다음 타이밍**(쉬는 시간, 하루 운영 종료 후 등)에 적용해주세요.
  지금 실행 중인 프로세스에는 영향 없습니다.
