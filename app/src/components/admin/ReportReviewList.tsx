import { useEffect, useState } from "react";
import { Flag } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { InfoCard } from "@/components/dashboard/shared";
import { SectionHeader, ItemTitle, FieldLabel, FieldValue } from "@/components/admin/shared";
import { useApi } from "@/hooks/useApi";
import { useAuth } from "@/lib/auth/useAuth";
import { WORKER_BASE } from "@/lib/api/client";
import type { CaptureReviewItem, CapturesListResponse, CaptureDecideResponse } from "@/lib/api/types";

const MODE_LABEL: Record<CaptureReviewItem["mode"], string> = {
  screenshot: "스크린샷",
  video: "영상",
};

// 화각 제보로 봇이 캡처한 파일(스크린샷/영상)은 봇 로컬 디스크에만 있고
// Worker가 Cloudflare Tunnel로 그때그때 프록시해서 가져온다. 목록 응답에는
// 메타데이터만 담고, 실제 파일 바이트는 각 항목을 열람할 때 별도로
// fetch()해서 blob으로 받는다(대량 목록을 한 번에 base64로 embed하면
// 영상 때문에 응답이 급격히 커지는 것을 피하기 위함).
function ReportPreview({ id, mode, token }: { id: string; mode: CaptureReviewItem["mode"]; token: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;

    fetch(`${WORKER_BASE}/admin/captures/file?id=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error("파일을 불러오지 못했습니다.");
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, token]);

  if (error) {
    return <p className="text-xs text-destructive sm:text-sm">미리보기를 불러오지 못했습니다.</p>;
  }
  if (!blobUrl) {
    return <p className="text-xs text-muted-foreground sm:text-sm">미리보기 불러오는 중...</p>;
  }
  if (mode === "video") {
    return <video src={blobUrl} controls className="w-full rounded-lg" />;
  }
  return <img src={blobUrl} alt="제보 캡처" className="w-full rounded-lg" />;
}

export function ReportReviewList() {
  const { call } = useApi();
  const { session } = useAuth();

  const [items, setItems] = useState<CaptureReviewItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    call<CapturesListResponse>("/admin/captures")
      .then((data) => setItems(data.items || []))
      .catch((err) => setError(err instanceof Error ? err.message : "제보 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  function decide(item: CaptureReviewItem, decision: "approved" | "rejected") {
    setDecidingId(item.id);
    setError(null);
    setResult(null);
    call<CaptureDecideResponse>("/admin/captures/decide", {
      method: "POST",
      body: { id: item.id, decision, nickname: item.nickname },
    })
      .then((data) => {
        if (data.penalty) {
          const { name, occurrence, isPCount } = data.penalty;
          const effect = isPCount ? "송출 P 발생" : occurrence === 1 ? "구두 경고" : "총 상점 차감";
          setResult(`${name}님 ${occurrence}차 위반 기록 완료 (${effect})`);
        }
        setItems((prev) => (prev ? prev.filter((i) => i.id !== item.id) : prev));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "처리에 실패했습니다."))
      .finally(() => setDecidingId(null));
  }

  return (
    <Collapsible defaultOpen className="flex flex-col gap-4">
      <SectionHeader icon={Flag} title="화각 제보 검토" loading={loading} onRefresh={load} />
      <div className="h-px w-full bg-border" />
      <CollapsiblePanel className="flex flex-col gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {result && (
          <Alert>
            <AlertDescription>{result}</AlertDescription>
          </Alert>
        )}

        {loading && !items && (
          <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">불러오는 중...</p>
        )}

        {!loading && items && items.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">검토 대기 중인 제보가 없습니다.</p>
        )}

        {items && items.length > 0 && (
          <div className="flex flex-col gap-3">
            {items.map((item) => (
              <InfoCard key={item.id} className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-2">
                  <ItemTitle>{item.nickname}</ItemTitle>
                  <span className="rounded-full bg-muted px-2.5 py-1 text-micro-lg font-semibold text-muted-foreground sm:text-xs">
                    {MODE_LABEL[item.mode]}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-1.5">
                    <FieldLabel>사유</FieldLabel>
                    <FieldValue>{item.reason || "-"}</FieldValue>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <FieldLabel>제보자</FieldLabel>
                    <FieldValue>{item.reporterEmail || "-"}</FieldValue>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <FieldLabel>시각</FieldLabel>
                    <FieldValue>{new Date(item.ts).toLocaleString("ko-KR")}</FieldValue>
                  </div>
                </div>

                {session?.token && <ReportPreview id={item.id} mode={item.mode} token={session.token} />}

                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="destructive"
                    disabled={decidingId === item.id}
                    onClick={() => decide(item, "approved")}
                  >
                    페널티 적용
                  </Button>
                  <Button
                    variant="outline"
                    disabled={decidingId === item.id}
                    onClick={() => decide(item, "rejected")}
                  >
                    반려
                  </Button>
                </div>
              </InfoCard>
            ))}
          </div>
        )}
      </CollapsiblePanel>
    </Collapsible>
  );
}
