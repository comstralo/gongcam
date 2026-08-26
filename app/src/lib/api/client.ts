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

  const res = await fetch(WORKER_BASE + path, {
    method,
    headers,
    body: finalBody ? JSON.stringify(finalBody) : undefined,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.();
    throw new ApiError(res.status, (data as { error?: string }).error || `요청 실패 (${res.status})`);
  }

  return data as T;
}
