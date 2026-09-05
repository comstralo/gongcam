import { Download, Share, SquarePlus } from "lucide-react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { InfoCard, ItemTitle } from "@/components/dashboard/shared";
import { useInstallPrompt } from "@/hooks/useInstallPrompt";
import { ICON_STROKE } from "@/lib/utils";

// iOS Safari는 beforeinstallprompt 자체를 지원하지 않아(애플 정책), 코드로
// 설치를 트리거할 방법이 없다 — "공유 → 홈 화면에 추가"를 사용자가 직접
// 누르도록 안내하는 것이 유일한 방법이다. NotifyPrefsCard의 주의사항에 이미
// 있는 동일한 안내 문구와 표현을 그대로 재사용한다.
const IOS_STEPS = [
  "하단(또는 상단) 공유 버튼을 누른다.",
  "\"홈 화면에 추가\"를 선택한다.",
  "우측 상단 \"추가\"를 누르면 완료된다.",
];

export function InstallAppCard() {
  const { installed, canInstall, platform, promptInstall } = useInstallPrompt();

  if (!canInstall || installed) return null;

  return (
    <InfoCard className="flex items-center justify-between gap-2.5">
      <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
        <Download className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
        <ItemTitle>앱으로 설치</ItemTitle>
      </span>

      {platform === "android" ? (
        <Button size="sm" variant="outline" className="shrink-0 text-xs sm:text-sm" onClick={promptInstall}>
          설치하기
        </Button>
      ) : (
        <Dialog>
          <DialogTrigger
            className="shrink-0 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <span className="pointer-events-none inline-flex h-8 items-center rounded-md border bg-background px-3 text-xs shadow-xs sm:text-sm">
              설치하기
            </span>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-1.5">
                <SquarePlus className="size-4 text-primary sm:size-5" />
                홈 화면에 추가하기
              </DialogTitle>
            </DialogHeader>
            <ol className="flex flex-col gap-2.5">
              {IOS_STEPS.map((step, i) => (
                <li key={step} className="flex items-start gap-2 text-xs sm:text-sm">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-micro-lg font-semibold text-primary">
                    {i + 1}
                  </span>
                  <span className="pt-0.5">
                    {i === 0 ? (
                      <span className="inline-flex items-center gap-1">
                        하단(또는 상단) <Share className="inline size-3.5 text-muted-foreground" /> 공유 버튼을 누른다.
                      </span>
                    ) : (
                      step
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </DialogContent>
        </Dialog>
      )}
    </InfoCard>
  );
}
