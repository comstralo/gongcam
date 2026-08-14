import type { ReactNode } from "react";
import { TabBar } from "./TabBar";
import { useAuth } from "@/lib/auth/useAuth";

type AppShellProps = {
  children: ReactNode;
  /** 지정하면 표준 헤더(Framing Check 라벨 + 제목)를 렌더링한다. 페이지가 자체 헤더를 그릴 경우 생략. */
  title?: string;
};

export function AppShell({ children, title }: AppShellProps) {
  const { session } = useAuth();

  return (
    <div
      className="flex min-h-dvh w-full flex-col items-center gap-4.5 p-4"
      style={{ paddingBottom: session ? "calc(32px + 64px + env(safe-area-inset-bottom, 0px))" : undefined }}
    >
      {title && (
        <header className="flex w-full max-w-md flex-col gap-0.5">
          <span className="font-mono text-xs uppercase tracking-widest text-primary">Framing Check</span>
          <h1 className="text-xl font-bold">{title}</h1>
        </header>
      )}
      {children}
      <TabBar />
    </div>
  );
}
