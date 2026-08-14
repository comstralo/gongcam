import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { RosterView } from "@/components/dashboard/RosterView";
import { useApi } from "@/hooks/useApi";
import type { RosterMember, RosterStatusResponse } from "@/lib/api/types";

export function RosterPage() {
  const { call } = useApi();
  const [members, setMembers] = useState<RosterMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    call<RosterStatusResponse>("/roster-status")
      .then((data) => {
        if (!cancelled) setMembers(data.members || []);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "전체 대시보드를 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card className="w-full">
      <CardContent className="flex flex-col gap-2 sm:gap-2.5">
        {members && <RosterView members={members} />}
        {loading && <p className="text-center font-mono text-xs text-muted-foreground sm:text-sm">불러오는 중...</p>}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
