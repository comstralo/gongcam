import { Card, CardContent } from "@/components/ui/card";

export function AdminDeniedCard() {
  return (
    <Card className="w-full page-content">
      <CardContent className="pt-6 text-center text-sm leading-relaxed text-muted-foreground">
        관리자 계정으로 로그인해야 접근할 수 있습니다.
      </CardContent>
    </Card>
  );
}
