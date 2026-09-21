import { test, expect, delayApiRoute, failApiRoute } from "./fixtures";

// 🔧 [2026-09-21 사용자 지시: "다양한 환경 대응을 위한 도구를 체계적으로
// 적용"] 이번 세션에서 반복된 레이아웃 버그(문서가 뷰포트보다 커져 로드
// 직후부터 스크롤됨, 브라우저 줌 배율에 따라 v버튼이 화면 밖으로 잘림 등)
// 를 다시 사람이 스크린샷으로 재현하지 않아도 되도록, 그 근본 불변식만
// 최소한으로 기계적으로 검증한다. 구체적인 시각적 디자인 회귀(색상/
// 간격 등)는 다루지 않는다 — 그건 사람 눈으로 보는 게 더 정확하고,
// 이 스위트의 목적은 "문서 스크롤 여지" 같은 구조적 회귀만 잡는 것이다.

test.describe("로그인 페이지 — 로그인 불필요", () => {
  test("문서가 뷰포트를 넘지 않는다(스크롤 여지 없음)", async ({ page }) => {
    // 🔧 [버그 수정, 2026-09-22 사용자 지시: "여러 환경에서의 문제점을
    // 테스트 단계에서 파악하고 싶다" 중 가로모드 프리셋 추가로 발견] —
    // LoginPage.tsx는 AppShell을 쓰지 않는 독립 레이아웃(min-h-dvh +
    // justify-center)이라, iPhone을 가로로 눕힌 것과 같은 664×390(세로
    // 공간이 극히 좁음)에서는 타이틀+로그인 카드+체커 카드 3덩어리의
    // 자연 높이가 390px를 넘어 로그인 버튼이 첫 화면 밖으로 밀려났었다
    // (실측: scrollHeight 562px). LoginPage.tsx에 mobile-landscape:
    // variant로 우선순위 낮은 요소(타이틀, 안내문구, 체커 카드, 각 모드
    // 설명 문구)를 숨기고 간격을 줄여 로그인 버튼까지 스크롤 없이 보이게
    // 고친 뒤(실측: scrollHeight 390px===innerHeight), 더 이상 예외
    // 처리 없이 모든 프로젝트에서 동일하게 검증한다.
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
  test("제보: 콘텐츠가 짧으면 스크롤 여지가 없다", async ({ authedPage: page }, testInfo) => {
    // 🔧 [디버그 확인, 2026-09-22] "제보는 항상 짧다"는 가정이
    // mobile-iphone-landscape(390px 세로, 헤더+탭바를 뺀 실제 스크롤
    // 영역이 220px 남짓)에서는 깨진다 — 대상자 선택/사유 입력 등 여러
    // 필드가 있는 제보 폼 자체의 자연 높이(708px)가 그보다 훨씬 길어
    // 실제로 스크롤이 필요하다(스크린샷 실측 확인, 정상 UX). "대시보드:
    // 콘텐츠가 뷰포트보다 길면 정상적으로 스크롤된다" 테스트가 이미
    // 다루는 것과 같은 종류의 기기 의존성이라, 그 테스트처럼 뷰포트를
    // 강제로 좁히는 대신 여기서는 애초에 좁은 이 프로젝트를 제외한다.
    testInfo.skip(
      testInfo.project.name === "mobile-iphone-landscape",
      "이 프로젝트는 세로 공간이 너무 좁아(390px) 제보 폼 자체가 자연스럽게 넘친다 — '콘텐츠가 짧다'는 이 테스트의 전제 자체가 성립하지 않음"
    );
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

  // 🔧 [2026-09-22 사용자 지시: "여러 환경에서의 문제점을 테스트 단계에서
  // 파악하고 싶다"] — viewportRect.top > 0(키보드가 실제로 떠 있을 때)
  // 분기는 이 세션에서 가장 많이 손댄 로직(AppShell.tsx의 v버튼 top 계산,
  // ChatPage의 position:fixed 컨테이너 재계산)인데, 실제 키보드를 띄울 수
  // 없는 자동화 환경 특성상 지금까지 테스트가 단 한 번도 이 경로를 타지
  // 않았다 — fixtures.ts의 keyboardUpPage가 visualViewport.offsetTop/
  // height를 흉내 내 이 경로를 처음으로 실행해본다.
  // 🔧 [디버그 확인, 2026-09-22] 처음엔 "키보드가 뜬 상태에서도 v버튼이
  // 화면에 보여야 한다"고 가정하고 작성했는데, 실제로는 ChatPage.tsx의
  // 별도 effect(1366행 부근, 사용자 지시: "네비바 올라온 상태에서 입력
  // 모드로 가면... 자연히 접히도록 해줘")가 keyboardUp이 되는 순간
  // 탭바를 강제로 펼침(false)으로 만들어, AppShell.tsx의 3분기
  // (collapsibleTabBar && tabBarCollapsed && keyboardUp → ReportZeroHeight,
  // 즉 아무것도 렌더링 안 함) 자체가 그 조합에서는 도달 불가능한 상태다
  // — "키보드가 뜬 채로 v버튼이 보인다"는 이 앱에서 애초에 일어날 수
  // 없는 조합이었다(실측: 최초 버전은 collapseTabBar가 존재하지도 않는
  // 버튼을 기다리며 30초 타임아웃으로 실패했다). 대신 실제로 검증
  // 가능한 두 불변식으로 바꾼다: (1) 키보드가 뜨면 TabBar/v버튼 자리가
  // 정확히 비워진다(ReportZeroHeight 분기가 실행됨), (2) 키보드가
  // 닫히면 자동으로 원래 펼침 상태로 복원된다(같은 effect의 반대쪽 분기).
  test("PWA + 키보드가 뜨면 탭바/v버튼 자리가 비워진다", async ({ authedKeyboardUpPwaPage: page }) => {
    await page.goto("#/chat");
    // 키보드가 뜬 채로 페이지가 로드되므로, ChatPage의 자동 접힘 effect가
    // 실행된 뒤에는 TabBar도 v버튼도 둘 다 없어야 한다(그 자리는
    // 채팅 컨테이너가 그대로 이어받음). 초기 tabBarCollapsed 값이
    // window.innerWidth < 768(App.tsx)로 뷰포트마다 다르지만(모바일은
    // 원래 접힘으로 시작), 결과는 어느 쪽이든 "키보드가 떠 있으면 이
    // 자리는 항상 비어 있다"로 동일하다 — 모바일은 원래 접힘 상태를
    // 유지하는 것뿐이고, 데스크톱/태블릿은 펼침에서 접힘으로 자동
    // 전환된다.
    const nav = page.locator('nav[aria-label="하단 탭 메뉴"]');
    const vButton = page.locator('button[aria-label="하단 탭 메뉴 펼치기"]');
    await expect(nav).toHaveCount(0);
    await expect(vButton).toHaveCount(0);
  });

  // 🔧 [디버그 확인, 2026-09-22] "키보드가 닫히면 자동으로 펼침 상태로
  // 복원된다"(ChatPage.tsx의 autoCollapsedRef)는 오직 "키보드가 뜨는
  // 순간 탭바가 펼침(false)에서 접힘(true)으로 자동 전환된 경우"에만
  // 발동하는 로직이다 — 모바일(초기 tabBarCollapsed=true, App.tsx의
  // window.innerWidth<768)에서는 애초에 펼침 상태를 거친 적이 없어
  // autoCollapsedRef가 계속 false로 남고, 자동 복원도 일어나지
  // 않는다(사용자가 수동으로 접은 것과 구분할 방법이 없으므로 코드가
  // 의도적으로 건드리지 않음 — 실측: mobile-iphone/mobile-android/
  // mobile-iphone-landscape 모두 실패로 이 가정 오류를 확인했다).
  // 그래서 이 시나리오는 초기값이 항상 펼침인 넓은 뷰포트(desktop/
  // tablet, 768px 이상)에서만 의미가 있다.
  test(
    "PWA + 키보드가 닫히면 자동으로 접혔던 탭바가 다시 펼쳐진다(넓은 화면, 768px 이상)",
    async ({ authedKeyboardUpPwaPage: page }, testInfo) => {
      testInfo.skip(
        testInfo.project.use.viewport !== undefined && testInfo.project.use.viewport!.width < 768,
        "이 프로젝트는 초기 tabBarCollapsed=true(모바일)라 자동 복원 전환 자체가 일어나지 않음"
      );
      await page.goto("#/chat");
      const nav = page.locator('nav[aria-label="하단 탭 메뉴"]');
      await expect(nav).toHaveCount(0);

      // 키보드를 다시 내린 것처럼 흉내 낸다(offsetTop을 0으로 되돌림) —
      // visualViewport 이벤트를 실제로 디스패치해야 useVisualViewportRect의
      // resize/scroll 리스너가 재계산을 트리거한다.
      await page.evaluate(() => {
        // fixtures.ts의 injectKeyboardUp이 이미 window.visualViewport를
        // Proxy로 감싸둔 상태다 — 그 Proxy를 다시 한 겹 더 씌워
        // offsetTop=0(키보드 닫힘)으로 바꾸고, 실제 리스너가 반응하도록
        // resize 이벤트를 디스패치한다.
        const current = window.visualViewport!;
        const proxy = new Proxy(current, {
          get(target, prop) {
            if (prop === "offsetTop") return 0;
            if (prop === "height") return window.innerHeight;
            const value = Reflect.get(target, prop, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        Object.defineProperty(window, "visualViewport", { value: proxy, configurable: true });
        window.visualViewport?.dispatchEvent(new Event("resize"));
        window.dispatchEvent(new Event("resize"));
      });

      // 키보드가 닫혔으므로 자동으로 펼침 상태로 복원되어 TabBar가
      // 다시 나타나야 한다(autoCollapsedRef 로직).
      await expect(nav).toHaveCount(1, { timeout: 5000 });
    }
  );

  test("일반 브라우저 탭에서는 키보드 시뮬레이션을 걸어도 v버튼이 여전히 순수 CSS bottom을 쓴다", async ({
    authedKeyboardUpPage: page,
  }) => {
    await page.goto("#/chat");
    const btn = await collapseTabBar(page);
    const style = await btn.evaluate((el) => (el as HTMLElement).style.cssText);
    // isStandalonePwa()가 false이므로 useVisualViewportRect()가 항상
    // null을 반환해야 한다 — 키보드 시뮬레이션을 걸었어도 이 가드
    // 자체가 무력화하는지가 핵심 검증 대상이다.
    expect(style).toContain("bottom");
    expect(style).not.toContain("top:");
  });
});

// 🔧 [2026-09-22 사용자 지시: "여러 환경에서의 문제점을 테스트 단계에서
// 파악하고 싶다"] — 레이아웃은 안 깨져도 콘솔에만 에러가 나는 회귀(예:
// React 경고 폭증, 처리되지 않은 프로미스 거부)는 지금까지 이 스위트가
// 전혀 잡지 못했다. 이번 세션에서 고친 화면들을 중심으로, 정상 경로에서
// 콘솔에 새로운 에러/경고가 없어야 함을 확인한다(fixtures.ts의
// KNOWN_CONSOLE_NOISE로 기존 알려진 잡음만 필터링).
test.describe("콘솔 에러 감지", () => {
  const PAGES = [
    { path: "#/", label: "대시보드" },
    { path: "#/report", label: "제보" },
    { path: "#/chat", label: "채팅" },
    { path: "#/settings", label: "설정" },
  ];

  for (const { path, label } of PAGES) {
    test(`${label}: 콘솔에 새로운 에러/경고가 없다`, async ({ authedPage: page, consoleErrors }) => {
      await page.goto(path);
      await page.locator("header").first().waitFor({ state: "attached" });
      await page.waitForTimeout(500);
      expect(consoleErrors.errors, consoleErrors.errors.join("\n")).toEqual([]);
    });
  }
});

// 🔧 [2026-09-22 사용자 지시: "여러 환경에서의 문제점을 테스트 단계에서
// 파악하고 싶다"] — AuthContext의 sessionVerified 로직(/me/role 응답을
// 받은 뒤에야 라우트를 렌더링)이 실제로 느리거나 실패하는 네트워크에서도
// "비로그인 대시보드 순간 노출" 같은 레이아웃 버그를 만들지 않는지는
// 지금까지 빠른 응답(로컬/CI 모두 왕복 수백ms) 전제로만 테스트됐다 —
// page.route로 응답을 인위적으로 늦추거나 실패시켜 그 가정 자체를
// 깨보고, 그래도 레이아웃 불변식이 유지되는지 확인한다.
test.describe("네트워크 지연/실패 시 레이아웃", () => {
  test("/me/role이 3초 지연되어도 로딩 중 화면이 뷰포트를 넘지 않는다", async ({ authedPage: page }) => {
    await delayApiRoute(page, "/me/role", 3000);
    await page.goto("#/");
    // sessionVerified가 아직 false인 로딩 구간 — App.tsx가 이 동안
    // 아무 라우트도 렌더링하지 않으므로 화면은 비어 있거나 최소한이어야
        // 한다. 그 상태에서도 문서가 뷰포트를 넘어서면 안 된다.
    await page.waitForTimeout(500);
    const { scrollHeight, innerHeight } = await page.evaluate(() => ({
      scrollHeight: document.body.scrollHeight,
      innerHeight: window.innerHeight,
    }));
    expect(scrollHeight).toBeLessThanOrEqual(innerHeight + 1);
    // 지연이 끝난 뒤에는 정상적으로 대시보드가 렌더링되어야 한다(무한
    // 로딩 상태로 멈추는 회귀를 잡는다). 위에서 이미 500ms를 소비했고
    // 지연 자체가 3000ms이므로, 남은 지연분(최대 2500ms) + 렌더링/
    // 데이터 로드 여유를 합쳐 넉넉히 기다린다(실측: 타이트하게 5000ms로
    // 두면 CI처럼 느린 환경에서 간헐적으로 실패했다).
    await page.getByText("목표시간").first().waitFor({ state: "attached", timeout: 8000 });
  });

  test("/me/role이 500을 반환해도(401이 아님) 로그아웃되지 않고 레이아웃이 유지된다", async ({
    authedPage: page,
  }) => {
    await failApiRoute(page, "/me/role", 500);
    await page.goto("#/");
    // AuthContext는 401만 로그아웃으로 처리하므로, 500은 sessionVerified만
    // true로 만들고 세션은 유지되어야 한다 — 로그인 페이지로 튕기면 회귀.
    await page.getByText("목표시간").first().waitFor({ state: "attached", timeout: 5000 });
    const { scrollHeight, innerHeight } = await page.evaluate(() => ({
      scrollHeight: document.body.scrollHeight,
      innerHeight: window.innerHeight,
    }));
    expect(scrollHeight).toBeLessThanOrEqual(innerHeight + 1);
  });

  test("/me/role이 401을 반환하면 로그인 페이지로 이동하고 레이아웃이 유지된다", async ({ authedPage: page }) => {
    await failApiRoute(page, "/me/role", 401);
    await page.goto("#/");
    // clearSession() 이후 라우팅이 로그인 화면으로 향해야 한다 — 이 앱은
    // 해시 라우팅이므로 URL의 #/login 또는 로그인 페이지 고유 요소로 확인.
    await page.waitForURL(/#\/login/, { timeout: 5000 });
    const { scrollHeight, innerHeight } = await page.evaluate(() => ({
      scrollHeight: document.body.scrollHeight,
      innerHeight: window.innerHeight,
    }));
    expect(scrollHeight).toBeLessThanOrEqual(innerHeight + 1);
  });
});
