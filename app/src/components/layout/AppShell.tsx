import type { ReactNode } from "react";
import { TabBar } from "./TabBar";
import { useAuth } from "@/lib/auth/useAuth";
import { cn } from "@/lib/utils";

type AppShellProps = {
  children: ReactNode;
  /** 지정하면 표준 헤더(Framing Check 라벨 + 제목)를 렌더링한다. 페이지가 자체 헤더를 그릴 경우 생략. */
  title?: string;
  /** true면 title은 유지하되 상단 "Framing Check" 라벨을 생략한다. */
  hideEyebrow?: boolean;
  /**
   * true면 가로 모드에서 하단 탭바를 숨기고 좌우 여백/패딩을 줄인다.
   * 세로 공간이 극도로 좁은 가로 모드에서(예: 체커의 카메라 뷰파인더)
   * 화면 전체를 콘텐츠에 내주기 위함. 세로 모드에서는 평소와 동일하다.
   */
  compactOnLandscape?: boolean;
};

export function AppShell({ children, title, hideEyebrow, compactOnLandscape }: AppShellProps) {
  const { session } = useAuth();

  return (
    <div
      className={cn(
        "flex min-h-dvh w-full flex-col items-center gap-4.5 p-4",
        compactOnLandscape && "landscape:gap-2 landscape:p-2",
        session && !compactOnLandscape && "pb-[calc(32px+64px+env(safe-area-inset-bottom,0px))]",
        session &&
          compactOnLandscape &&
          "portrait:pb-[calc(32px+64px+env(safe-area-inset-bottom,0px))] landscape:pb-2"
      )}
    >
      {title && (
        <header className="flex w-full page-content flex-col gap-0.5">
          {!hideEyebrow && (
            <span className="font-mono text-xs uppercase tracking-widest text-primary sm:text-sm">Framing Check</span>
          )}
          <h1 className="text-xl font-bold sm:text-2xl">{title}</h1>
        </header>
      )}
      {children}
      <div className={cn(compactOnLandscape && "landscape:hidden")}>
        <TabBar />
      </div>
    </div>
  );
}
