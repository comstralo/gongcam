import { Link } from "react-router-dom";
import { MessageCircle, FileText, Table, Megaphone, ScanLine, type LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { ICON_STROKE } from "@/lib/utils";

// 스터디 바로가기 — 링크 값은 추후 실제 URL로 교체 예정.
const externalLinks: { key: string; icon: LucideIcon; label: string; href: string }[] = [
  { key: "chat", icon: MessageCircle, label: "단체 채팅방", href: "#" },
  { key: "rules", icon: FileText, label: "스터디 규정", href: "#" },
  { key: "sheet", icon: Table, label: "원본 시트", href: "#" },
  { key: "notice", icon: Megaphone, label: "공지사항", href: "#" },
];

export function LinksPage() {
  return (
    <Card className="w-full page-content">
      <CardContent className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-2.5">
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
        <Link
          to="/checker"
          className="flex flex-col items-center gap-1.5 rounded-xl border bg-muted px-3 py-3 text-center shadow-xs transition-colors hover:bg-accent sm:py-3.5"
        >
          <ScanLine className="size-4 shrink-0 text-primary sm:size-5" strokeWidth={ICON_STROKE.default} />
          <span className="truncate text-xs font-semibold sm:text-sm">체커</span>
        </Link>
      </CardContent>
    </Card>
  );
}
