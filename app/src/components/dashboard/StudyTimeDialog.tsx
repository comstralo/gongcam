import { Timer, Search } from "lucide-react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SubRow, InfoCard } from "@/components/dashboard/shared";
import type { ReactNode } from "react";
import type { StatusDay } from "@/lib/api/types";

export function StudyTimeDialog({
  weeklyStudyTime,
  days,
  children,
}: {
  weeklyStudyTime: string;
  days: StatusDay[];
  children: ReactNode;
}) {
  return (
    <Dialog>
      <DialogTrigger className="w-full rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        {children}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Search className="size-4 text-primary sm:size-5" />
            주간 학습시간 · 세부사항
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <InfoCard className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
              <Timer className="size-3.5 shrink-0 text-primary sm:size-4" />
              주간 학습시간
            </span>
            <span className="text-xs sm:text-sm">{weeklyStudyTime}</span>
          </InfoCard>

          <InfoCard className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold sm:text-sm">요일별 학습시간</span>
            {days.map((d) => (
              <SubRow
                key={d.day}
                label={d.day}
                value={d.studyTime || "-"}
                valueClassName="font-sans"
              />
            ))}
          </InfoCard>
        </div>
      </DialogContent>
    </Dialog>
  );
}
