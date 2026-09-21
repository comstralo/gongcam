import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ScanLine } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { apiFetch } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/useAuth";
import type { VerifyResponse } from "@/lib/api/types";
import type { SessionMode } from "@/lib/auth/session";

const GOOGLE_CLIENT_ID = "280658144716-4vvnjn23skcshm9t65fibnt0dcuvs3va.apps.googleusercontent.com";

export function LoginPage() {
  const { session, login } = useAuth();
  const navigate = useNavigate();
  const googleBtnRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<SessionMode>("persist");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // 이미 세션이 있으면(로그인 상태 유지) 대시보드로 즉시 이동
  useEffect(() => {
    if (session) navigate("/", { replace: true });
  }, [session, navigate]);

  useEffect(() => {
    if (session) return;

    async function handleCredentialResponse(response: { credential: string }) {
      setChecking(true);
      setError(null);
      try {
        const data = await apiFetch<VerifyResponse>("/verify", {
          method: "POST",
          body: { credential: response.credential },
        });
        login(data, modeRef.current);
        navigate("/", { replace: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : "로그인에 실패했습니다.");
      } finally {
        setChecking(false);
      }
    }

    function renderButton() {
      if (!window.google?.accounts?.id || !googleBtnRef.current) {
        setError("Google 로그인 스크립트를 불러오지 못했습니다. 새로고침해보세요.");
        return;
      }
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleCredentialResponse,
      });
      const isDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
      window.google.accounts.id.renderButton(googleBtnRef.current, {
        type: "standard",
        theme: isDark ? "filled_black" : "outline",
        size: "large",
        text: "signin_with",
        shape: "pill",
      });
    }

    if (window.google?.accounts?.id) {
      renderButton();
      return;
    }

    // CDN 스크립트가 아직 로드 중일 수 있으므로 로드 완료를 기다린다.
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="https://accounts.google.com/gsi/client"]'
    );
    const script = existing ?? document.createElement("script");
    if (!existing) {
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
    script.addEventListener("load", renderButton);
    return () => script.removeEventListener("load", renderButton);
  }, [session, login, navigate]);

  return (
    // 🔧 [버그 수정, 2026-09-22 사용자 지시: "여러 환경에서의 문제점을
    // 테스트 단계에서 파악하고 싶다" — E2E 가로모드 프리셋 추가로 발견]
    // 이 페이지는 AppShell을 쓰지 않는 독립 레이아웃(min-h-dvh +
    // justify-center)이라, 세로 공간이 극히 좁은 가로모드(iPhone을 눕힌
    // 상태, 390px 안팎)에서는 타이틀+로그인 카드+체커 카드 3덩어리의
    // 자연 높이가 뷰포트를 넘어 로그인 버튼이 첫 화면 밖으로 밀려났다
    // (실측: scrollHeight 562px vs innerHeight 390px). 로그인은 이 화면의
    // 핵심 행동이므로, 가로모드에서는 (1) 상하 여백/간격을 줄이고
    // (2) 우선순위가 낮은 체커 카드를 숨겨(그 경로는 /checker로 항상
    // 별도 접근 가능) 로그인 버튼까지 스크롤 없이 보이게 한다.
    <div className="flex min-h-dvh w-full flex-col items-center justify-center gap-6 p-4 mobile-landscape:gap-2 mobile-landscape:p-2">
      <div className="flex w-full page-content flex-col items-center gap-1 text-center mobile-landscape:hidden">
        <span className="text-xs font-semibold tracking-tight text-primary sm:text-sm">
          공부합시당 캠스터디
        </span>
        <h1 className="text-xl font-semibold sm:text-2xl">스터디 대시보드</h1>
      </div>

      <Card className="w-full page-content">
        <CardContent className="flex flex-col gap-4 mobile-landscape:gap-2 mobile-landscape:p-3">
          <p className="text-sm leading-relaxed text-muted-foreground sm:text-base mobile-landscape:hidden">
            아래 기능은 <strong className="text-foreground">참여자 명단(스프레드시트 열람 권한)</strong>에
            등록된 계정만 이용할 수 있습니다.
            <br />
            Google 계정으로 로그인하면 자동으로 확인됩니다.
          </p>

          <RadioGroup
            value={mode}
            onValueChange={(v) => setMode(v as SessionMode)}
            className="gap-2 mobile-landscape:gap-1"
          >
            <Label
              htmlFor="mode-persist"
              className="flex items-start gap-2 rounded-lg border p-3 has-[[data-state=checked]]:border-primary sm:p-4 mobile-landscape:p-2"
            >
              <RadioGroupItem value="persist" id="mode-persist" className="mt-0.5" />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold sm:text-base">로그인 상태 유지</span>
                <span className="text-xs text-muted-foreground sm:text-sm mobile-landscape:hidden">
                  이 브라우저에서 30일 동안 자동 로그인
                </span>
              </span>
            </Label>
            <Label
              htmlFor="mode-once"
              className="flex items-start gap-2 rounded-lg border p-3 has-[[data-state=checked]]:border-primary sm:p-4 mobile-landscape:p-2"
            >
              <RadioGroupItem value="once" id="mode-once" className="mt-0.5" />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold sm:text-base">1회성 로그인 (공공 PC)</span>
                <span className="text-xs text-muted-foreground sm:text-sm mobile-landscape:hidden">
                  탭을 닫으면 즉시 로그아웃
                </span>
              </span>
            </Label>
          </RadioGroup>

          <div className="flex min-h-11 items-center justify-center rounded-full bg-white p-2.5 dark:bg-transparent">
            <div ref={googleBtnRef} />
          </div>

          {checking && <p className="text-center font-mono text-xs text-muted-foreground sm:text-sm">확인 중...</p>}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card className="w-full page-content border-primary mobile-landscape:hidden">
        <CardContent>
          <Link to="/checker" className="flex items-center gap-3.5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full border bg-card sm:size-12">
              <ScanLine className="size-5 text-primary sm:size-6" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[15px] font-semibold sm:text-lg">화각 체커</span>
              <span className="text-xs text-muted-foreground sm:text-sm">4×4 격자로 화각을 점검하고 사진/영상을 촬영합니다</span>
            </span>
            <span className="shrink-0 font-mono text-micro uppercase tracking-wide text-primary sm:text-xs">누구나</span>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
