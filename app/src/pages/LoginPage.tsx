import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
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
    <div className="flex min-h-dvh w-full flex-col items-center justify-center gap-6 p-4">
      <div className="flex w-full max-w-md flex-col items-center gap-1 text-center">
        <span className="font-mono text-xs uppercase tracking-widest text-primary">Framing Check</span>
        <h1 className="text-xl font-bold">공부합시당 캠스터디</h1>
      </div>

      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            아래 기능은 <strong className="text-foreground">참여자 명단(스프레드시트 열람 권한)</strong>에
            등록된 계정만 이용할 수 있습니다.
            <br />
            Google 계정으로 로그인하면 자동으로 확인됩니다.
          </p>

          <RadioGroup value={mode} onValueChange={(v) => setMode(v as SessionMode)} className="gap-2">
            <Label
              htmlFor="mode-persist"
              className="flex items-start gap-2 rounded-lg border p-3 has-[[data-state=checked]]:border-primary"
            >
              <RadioGroupItem value="persist" id="mode-persist" className="mt-0.5" />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold">로그인 상태 유지</span>
                <span className="text-xs text-muted-foreground">이 브라우저에서 30일 동안 자동 로그인</span>
              </span>
            </Label>
            <Label
              htmlFor="mode-once"
              className="flex items-start gap-2 rounded-lg border p-3 has-[[data-state=checked]]:border-primary"
            >
              <RadioGroupItem value="once" id="mode-once" className="mt-0.5" />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold">1회성 로그인 (공공 PC)</span>
                <span className="text-xs text-muted-foreground">탭을 닫으면 즉시 로그아웃</span>
              </span>
            </Label>
          </RadioGroup>

          <div className="flex min-h-11 items-center justify-center rounded-full bg-white p-2.5 dark:bg-transparent">
            <div ref={googleBtnRef} />
          </div>

          {checking && <p className="text-center font-mono text-xs text-muted-foreground">확인 중...</p>}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card className="w-full max-w-md border-primary">
        <CardContent>
          <Link to="/checker" className="flex items-center gap-3.5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full border bg-card text-lg">
              📐
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[15px] font-bold">프레임 체커</span>
              <span className="text-xs text-muted-foreground">4×4 격자로 화각을 점검하고 사진/영상을 촬영합니다</span>
            </span>
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-primary">누구나</span>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
