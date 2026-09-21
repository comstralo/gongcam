// 🔧 [로컬 워커 연동 시도 후 원복, 2026-09-17] 한때 로컬 개발(vite dev)에서
// 로컬 워커(wrangler dev, localhost:8787)를 쓰도록 분기했으나, 로컬
// wrangler dev에는 SESSION_SECRET 등 프로덕션 시크릿 14개가 전혀 없어
// 인증이 필요한 모든 요청이 500(HMAC 키 오류)으로 죽고 브라우저에는
// "Failed to fetch"/CORS 에러로 보이는 문제가 있었다(예외가 CORS 헤더를
// 붙이기 전에 터짐). 시크릿을 로컬에 복제하는 것보다 프로덕션 워커를
// 그대로 쓰는 쪽이 안전하고 간단하다는 판단(사용자 결정) — 로컬 개발도
// 항상 프로덕션 워커를 호출한다.
import * as Sentry from "@sentry/react";

export const WORKER_BASE = "https://frame-checker-worker.comstralo.workers.dev";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type ApiOptions = {
  method?: string;
  body?: Record<string, unknown>;
  token?: string;
  // /report 엔드포인트만 유독 인증 토큰을 body에 넣는다. 이 비일관성을
  // 호출부가 몰라도 되도록 여기서 흡수한다.
  tokenInBody?: boolean;
  onUnauthorized?: () => void;
};

export async function apiFetch<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const { method = "GET", body, token, tokenInBody, onUnauthorized } = opts;

  const headers: Record<string, string> = {};
  let finalBody = body;

  if (token && !tokenInBody) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (body) {
    headers["Content-Type"] = "application/json";
    finalBody = tokenInBody ? { ...body, token } : body;
  }

  let res: Response;
  try {
    res = await fetch(WORKER_BASE + path, {
      method,
      headers,
      body: finalBody ? JSON.stringify(finalBody) : undefined,
      // 백엔드가 지금은 Cache-Control을 안 주지만, 향후 실수로 추가되더라도
      // 이 API 응답들은 항상 네트워크를 타야 한다 — useVersionCheck가 이미
      // 같은 이유로 no-store를 쓰고 있는 것과 같은 방어책.
      cache: "no-store",
    });
  } catch {
    // 🔧 [버그 수정, 2026-09-21] 네트워크가 끊긴 상태에서 fetch 자체가
    // TypeError("Failed to fetch")를 던지면, 이 함수를 부르는 42곳의
    // catch(err instanceof Error ? err.message : ...) 패턴이 그 영어
    // 원문을 그대로 사용자에게 보여줬다 — 각 호출부를 전부 고치는 대신
    // 이 한 지점에서 항상 이해할 수 있는 한국어 메시지로 바꿔, 이미 있는
    // catch 처리들이 자동으로 개선되게 한다.
    throw new ApiError(0, "네트워크 연결을 확인해주세요.");
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.();
    const message = (data as { error?: string }).error || `요청 실패 (${res.status})`;
    // 🔧 [관찰가능성 개선, 2026-09-21] 지금까지 Sentry.ErrorBoundary만
    // 있어 렌더링 크래시만 잡혔고, API 에러는(42곳의 호출부가 각자
    // catch로 조용히 처리) 전혀 관찰 밖이었다. 이 한 지점에서 캡처하면
    // 42곳을 각각 고치지 않아도 전부 커버된다(네트워크 에러 한국어화와
    // 동일한 패턴). 5xx(서버 쪽 실제 버그 가능성)만 보낸다 — 401/403/404
    // /429 같은 4xx는 권한 없음·존재하지 않음·요청 제한처럼 정상 흐름
    // 안에서도 흔히 나는 예상된 응답이라 노이즈만 늘린다. fetch 자체
    // 실패(네트워크 끊김, status 0)도 사용자 환경 문제(OfflineBanner가
    // 이미 안내)라 제외한다.
    if (res.status >= 500) {
      Sentry.captureException(new ApiError(res.status, message), {
        extra: { path, method, status: res.status },
      });
    }
    throw new ApiError(res.status, message);
  }

  return data as T;
}
