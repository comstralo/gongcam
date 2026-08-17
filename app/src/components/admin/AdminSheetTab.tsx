import { Table } from "lucide-react";
import { ICON_STROKE } from "@/lib/utils";

export function AdminSheetTab() {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
      <Table className="size-8" strokeWidth={ICON_STROKE.large} />
      <p className="text-sm sm:text-base">시트 관리 기능은 준비 중입니다.</p>
    </div>
  );
}
