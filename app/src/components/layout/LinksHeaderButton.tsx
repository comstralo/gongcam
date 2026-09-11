import { Link } from "react-router-dom";
import { Link2, MessageCircle, FileText, Table, Megaphone, ScanLine, type LucideIcon } from "lucide-react";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { ICON_STROKE } from "@/lib/utils";

// 스터디 바로가기 — 링크 값은 추후 실제 URL로 교체 예정.
const externalLinks: { key: string; icon: LucideIcon; label: string; href: string }[] = [
  { key: "chat", icon: MessageCircle, label: "단체 채팅방", href: "#" },
  { key: "rules", icon: FileText, label: "스터디 규정", href: "#" },
  { key: "sheet", icon: Table, label: "원본 시트", href: "#" },
  { key: "notice", icon: Megaphone, label: "공지사항", href: "#" },
];

// 🔧 [사용자 지시] "링크 메뉴를 우측 상단의 다크모드 토글 버튼 좌측에
// 넣어줘" — 하단 탭바의 "링크" 항목을 헤더로 옮긴다. ThemeToggleButton과
// 동일한 원형 아이콘 버튼 톤(평소엔 존재감 낮추고 hover로만 드러남)을
// 맞춘다.
// 🔧 [사용자 지시] "링크 버튼은 눌렀을 때 페이지 이동이 아니라 모달에서
// 뜨도록 해줘" — NavLink로 /links 페이지 전체를 이동시키던 것을,
// TotalPenaltyDialog 등과 동일한 Dialog 패턴으로 바꿔 헤더 자리에서 바로
// 목록을 보여준다.
// 🔧 [사용자 지시] "이제 링크 페이지는 제거해. 모달에서만 보이도록 해" —
// 이 모달이 유일한 진입점이 됐으므로 별도 페이지(LinksPage.tsx)와
// /links 라우트, 하단 탭 전환용 상태를 모두 제거했다.
export function LinksHeaderButton() {
  return (
    <Dialog>
      <DialogTrigger
        aria-label="링크"
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Link2 className="size-4.5" strokeWidth={ICON_STROKE.default} />
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Link2 className="size-4 text-primary sm:size-5" />
            링크
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-2.5">
          {externalLinks.map((link) => (
            <a
              key={link.key}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className="flex flex-col items-center gap-1.5 rounded-xl border bg-muted px-3 py-3 text-center shadow-xs transition-colors hover:bg-accent sm:py-3.5"
            >
              <link.icon className="size-4 shrink-0 text-primary sm:size-5" strokeWidth={ICON_STROKE.default} />
              <span className="truncate text-xs font-semibold sm:text-sm">{link.label}</span>
            </a>
          ))}
          <DialogClose
            nativeButton={false}
            render={
              <Link
                to="/checker"
                className="flex flex-col items-center gap-1.5 rounded-xl border bg-muted px-3 py-3 text-center shadow-xs transition-colors hover:bg-accent sm:py-3.5"
              >
                <ScanLine className="size-4 shrink-0 text-primary sm:size-5" strokeWidth={ICON_STROKE.default} />
                <span className="truncate text-xs font-semibold sm:text-sm">체커</span>
              </Link>
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
