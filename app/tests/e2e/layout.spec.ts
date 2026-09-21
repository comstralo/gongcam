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
      // 🔧 [버그 수정, 2026-09-21] AuthContext가 세션 유효성을 서버에서
      // 확인(/me/role)한 뒤에야 라우트를 렌더링하도록 바뀌어(비로그인
      // 상태 접속 시 대시보드가 순간 노출되는 문제 수정), 고정된 300ms
      // 대기만으로는 그 네트워크 왕복까지 항상 따라잡지 못하는 경우가
      // 생겼다 — 모든 메인 페이지가 공통으로 갖는 header(타이틀)가
      // 나타남을 실제 로딩 완료 신호로 기다린 뒤, AppShell이 실측
      // (ResizeObserver)으로 안정화될 시간만 짧게 추가로 둔다.
      await page.locator("header").first().waitFor({ state: "attached" });
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
    const collapseBtn = page.locator('button[aria-label="하단 탭 메뉴 펼치기"]');
    const expandBtn = page.locator('button[aria-label="하단 탭 메뉴 접기"]');
    // 🔧 [버그 수정, 2026-09-21] AuthContext가 세션 유효성을 서버에서
    // 확인(/me/role)한 뒤에야 라우트를 렌더링하도록 바뀌어(비로그인 상태
    // 접속 시 대시보드가 순간 노출되는 문제 수정), 고정된 300ms 대기로는
    // 그 네트워크 왕복(실측 약 265ms) + 페이지 자체 로딩을 항상 따라잡지
    // 못하는 경우가 생겼다 — 매직넘버를 늘리는 대신 실제 로딩 완료
    // 신호(둘 중 하나의 버튼이 나타남)를 기다린다.
    await collapseBtn.or(expandBtn).first().waitFor({ state: "attached" });
    const innerHeight = await page.evaluate(() => window.innerHeight);
    // 둘 중 하나는(접힘/펼침 상태에 따라) 반드시 화면 안에 있어야 한다.
    const collapseBox = (await collapseBtn.count()) > 0 ? await collapseBtn.boundingBox() : null;
    const expandBox = (await expandBtn.count()) > 0 ? await expandBtn.boundingBox() : null;
    const box = collapseBox || expandBox;
    expect(box, "탭바 접기/펼치기 버튼을 찾을 수 없음").not.toBeNull();
    if (box) {
      expect(box.y + box.height).toBeLessThanOrEqual(innerHeight);
    }
  });

  // 🔧 [버그 수정, 2026-09-22 사용자 지시: "큰 화면에서 '제보' 탭에서
  // 스크롤을 하면 스크롤이 되는데, 넘치는 영역이 없는데 왜 굳이
  // 스크롤이 되는거야?"] — AppShell의 overflow-y-auto wrapper가
  // TabBar를 가리지 않기 위한 padding-bottom을 콘텐츠 실제 높이와
  // 무관하게 항상 적용해, 콘텐츠 자체는 안 넘쳐도 그 padding만으로
  // scrollHeight가 clientHeight를 넘어섰다(실측: 제보 탭 diff 78px ≈
  // padding 79px). 콘텐츠가 짧은 화면(제보 등)에서 스크롤 여지가 아예
  // 없어야 한다는 것과, 콘텐츠가 실제로 긴 화면(대시보드)에서는 여전히
  // 정상적으로 스크롤되어야 한다는 것을 대조로 검증한다 — 이 회귀가
  // 재발하면 "짧은 화면은 스크롤 없음" 쪽에서, "패딩을 아예 없애 TabBar가
  // 콘텐츠를 가림" 같은 반대쪽 회귀는 "긴 화면은 스크롤 있음" 쪽에서 잡힌다.
  test("제보: 콘텐츠가 짧으면 스크롤 여지가 없다", async ({ authedPage: page }) => {
    await page.goto("#/report");
    const scrollable = page.locator(".overflow-y-auto").first();
    await scrollable.waitFor({ state: "attached" });
    const { scrollHeight, clientHeight } = await scrollable.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(scrollHeight - clientHeight).toBeLessThanOrEqual(1);
  });

  test("대시보드: 콘텐츠가 뷰포트보다 길면 정상적으로 스크롤된다", async ({ authedPage: page }) => {
    // 🔧 [디버그 확인, 2026-09-22] 처음엔 "대시보드는 항상 콘텐츠가
    // 뷰포트보다 길다"고 가정했는데, 실측 결과 iPad(810×1080, 세로로
    // 긴 화면)에서는 대시보드 콘텐츠(910px)가 그 뷰포트에 정확히 다
    // 들어가 diff:0이 정상이었다 — 이는 버그가 아니라 이번에 고친
        // 수정이 의도대로 작동한다는 증거였다(콘텐츠가 안 넘치면 스크롤
    // 여지도 없어야 함). "대시보드는 항상 넘친다"는 가정 자체가 기기
    // 화면 크기에 의존해 깨지기 쉬우므로, 뷰포트를 인위적으로 작게
    // 줄여 반드시 넘치는 상황을 만든 뒤 검증한다 — 기기와 무관하게
    // 항상 같은 결론을 낸다.
    await page.setViewportSize({ width: 400, height: 400 });
    await page.goto("#/");
    // header가 붙는 시점엔 아직 /status 응답이 안 와 카드가 비어 있어
    // (diff:0) 이 테스트가 "우연히 통과"할 위험이 있었다(실측: header
    // 붙은 직후 scrollHeight===clientHeight, 이후 실제 데이터
    // 렌더링되며 벌어짐). "목표시간" 라벨(실제 상태 카드, 데이터 로드
    // 후에만 렌더링)이 나타남을 기다려 데이터 로딩 완료를 확인한다.
    await page.getByText("목표시간").first().waitFor({ state: "attached" });
    const scrollable = page.locator(".overflow-y-auto").first();
    const { scrollHeight, clientHeight } = await scrollable.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    // 뷰포트를 400×400으로 좁혀 반드시 넘치게 만든 상태 — 이 값이
    // 0에 가까우면 "패딩을 없애다가 콘텐츠 자체 오버플로 감지 로직까지
    // 함께 망가뜨렸다"는 신호다.
    expect(scrollHeight - clientHeight).toBeGreaterThan(50);
  });
});

// 🔧 [2026-09-22] useKeyboardInset.ts의 isStandalonePwa() 가드가 지키는
// 두 방향 불변식을 각각 검증한다: (1) PC/일반 브라우저 탭은 이 JS
// 좌표계를 절대 타면 안 된다(순수 CSS 폴백만 써야 함) — 이게 지켜지지
// 않으면 이번 세션에서 반복된 "PC까지 iOS 우회 코드가 오염시키는" 버그가
// 재발한다. (2) PWA standalone에서는 이 보정이 실제로 동작해야 한다.
//
// 검증 대상은 TabBar가 펼쳐진 상태의 접기 버튼(TabBar.tsx, top/bottom
// 삼항 로직 없음)이 아니라, 탭바가 접힌 뒤 나타나는 "펼치기" 버튼
// (AppShell.tsx, viewportRect 기준 삼항 로직을 가진 바로 그 버튼)이다
// — 데스크톱은 채팅 탭바 기본값이 펼침이라(App.tsx의 chatTabBarCollapsed
// 초기값, PC 판정 시 false) 먼저 접기 버튼을 눌러 상태를 만들어야 한다.
async function collapseTabBar(page: import("@playwright/test").Page) {
  const expandBtn = page.locator('button[aria-label="하단 탭 메뉴 펼치기"]');
  const collapseTrigger = page.locator('button[aria-label="하단 탭 메뉴 접기"]');
  // 🔧 [디버그 확인, 2026-09-22] ChatPage는 React.lazy라 goto 직후 바로
  // collapseTrigger.count()를 재면 아직 청크 로딩 전이라 0이 나와
  // 클릭을 건너뛰고, 이후 "펼치기" 버튼을 영원히 기다리게 되는 경합이
  // 있었다(실측 재현) — 두 버튼 중 하나가 나타날 때까지 먼저 기다린다.
  await expandBtn.or(collapseTrigger).first().waitFor({ state: "attached" });
  if ((await collapseTrigger.count()) > 0) {
    await collapseTrigger.first().click();
    await expandBtn.waitFor({ state: "attached" });
  }
  return expandBtn;
}

test.describe("PWA standalone 분기 — isStandalonePwa() 가드", () => {
  test("일반 브라우저 탭(PWA 아님)에서는 v버튼이 항상 순수 CSS bottom로 고정된다", async ({
    authedPage: page,
  }) => {
    await page.goto("#/chat");
    const btn = await collapseTabBar(page);
    const style = await btn.evaluate((el) => (el as HTMLElement).style.cssText);
    // viewportRect 기반 JS 계산 경로를 탔다면 인라인 style에 "top:"이
    // 들어간다 — PWA가 아니므로 반드시 "bottom:" 폴백만 써야 한다.
    expect(style).toContain("bottom");
    expect(style).not.toContain("top:");
  });

  test("PWA standalone에서는 v버튼이 화면 안에 정확히 위치한다(키보드 없을 때도)", async ({
    authedPwaPage: page,
  }) => {
    await page.goto("#/chat");
    const btn = await collapseTabBar(page);
    const innerHeight = await page.evaluate(() => window.innerHeight);
    const box = await btn.boundingBox();
    expect(box, "PWA 모드에서 v버튼을 찾을 수 없음").not.toBeNull();
    if (box) {
      // 🔧 [버그 수정, 2026-09-21] 키보드가 없을 때(대부분의 경우)는
      // viewportRect.top===0이라 이제 PWA에서도 순수 CSS bottom 폴백을
      // 쓴다(f7ca6bb 커밋 이후 JS 좌표계였다가, iPad/iPhone 오차 문제로
      // 되돌림) — 그래도 화면 안에 있어야 한다는 결과 자체는 동일.
      expect(box.y).toBeGreaterThan(0);
      expect(box.y + box.height).toBeLessThanOrEqual(innerHeight);
    }
  });
});
