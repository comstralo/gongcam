import { test, expect } from "./fixtures";

// 🔧 [2026-09-21 사용자 지시: "다양한 환경 대응을 위한 도구를 체계적으로
// 적용"] 이번 세션에서 반복된 레이아웃 버그(문서가 뷰포트보다 커져 로드
// 직후부터 스크롤됨, 브라우저 줌 배율에 따라 v버튼이 화면 밖으로 잘림 등)
// 를 다시 사람이 스크린샷으로 재현하지 않아도 되도록, 그 근본 불변식만
// 최소한으로 기계적으로 검증한다. 구체적인 시각적 디자인 회귀(색상/
// 간격 등)는 다루지 않는다 — 그건 사람 눈으로 보는 게 더 정확하고,
// 이 스위트의 목적은 "문서 스크롤 여지" 같은 구조적 회귀만 잡는 것이다.

test.describe("로그인 페이지 — 로그인 불필요", () => {
  test("문서가 뷰포트를 넘지 않는다(스크롤 여지 없음)", async ({ page }) => {
    await page.goto("#/login");
    const { scrollHeight, innerHeight } = await page.evaluate(() => ({
      scrollHeight: document.body.scrollHeight,
      innerHeight: window.innerHeight,
    }));
    // 서브픽셀 반올림 오차(이번 세션에서 실측된 종류)를 감안해 1px 여유.
    expect(scrollHeight).toBeLessThanOrEqual(innerHeight + 1);
  });
});

test.describe("로그인 후 메인 화면 — DEV_LOGIN_SECRET 필요 시에만 실행", () => {
  const PAGES = [
    { path: "#/", label: "대시보드" },
    { path: "#/report", label: "제보" },
    { path: "#/chat", label: "채팅" },
    { path: "#/settings", label: "설정" },
  ];

  for (const { path, label } of PAGES) {
    test(`${label}: 문서가 뷰포트를 넘지 않는다`, async ({ authedPage: page }) => {
      await page.goto(path);
      // AppShell이 실측(ResizeObserver)으로 안정화될 시간을 짧게 준다 —
      // 첫 프레임 매직넘버 폴백 직후 값이 바뀌는 경우를 피한다.
      await page.waitForTimeout(300);
      const { scrollHeight, innerHeight } = await page.evaluate(() => ({
        scrollHeight: document.body.scrollHeight,
        innerHeight: window.innerHeight,
      }));
      expect(scrollHeight).toBeLessThanOrEqual(innerHeight + 1);
    });
  }

  test("제보: 타이틀+탭이 스크롤 시에도 화면에 고정된다", async ({ authedPage: page }) => {
    await page.goto("#/report");
    const header = page.locator("header");
    const before = await header.boundingBox();
    await page.evaluate(() => {
      const scrollable = document.querySelector(".overflow-y-auto");
      if (scrollable) scrollable.scrollTop = 200;
    });
    const after = await header.boundingBox();
    expect(after?.y).toBe(before?.y);
  });

  test("채팅: 하단 탭 메뉴 접기/펼치기 버튼이 화면 안에 있다(잘리지 않음)", async ({ authedPage: page }) => {
    await page.goto("#/chat");
    await page.waitForTimeout(300);
    const innerHeight = await page.evaluate(() => window.innerHeight);
    const collapseBtn = page.locator('button[aria-label="하단 탭 메뉴 펼치기"]');
    const expandBtn = page.locator('button[aria-label="하단 탭 메뉴 접기"]');
    // 둘 중 하나는(접힘/펼침 상태에 따라) 반드시 화면 안에 있어야 한다.
    const collapseBox = (await collapseBtn.count()) > 0 ? await collapseBtn.boundingBox() : null;
    const expandBox = (await expandBtn.count()) > 0 ? await expandBtn.boundingBox() : null;
    const box = collapseBox || expandBox;
    expect(box, "탭바 접기/펼치기 버튼을 찾을 수 없음").not.toBeNull();
    if (box) {
      expect(box.y + box.height).toBeLessThanOrEqual(innerHeight);
    }
  });
});
