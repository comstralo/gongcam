# 채팅 기능 구조 지도 (WEB_CHAT.md)

> 이 문서는 웹 서비스(`app/`, Cloudflare Worker `frame-checker-worker/`)의 **채팅**
> 기능(하단 내비게이션의 "/chat" 경로, 관리자-회원 1:1 문의방)을 프론트~백엔드~
> Stream Chat(getstream.io) 연동까지 실제 코드를 읽어 조사한 결과입니다.
> `docs/WEB_DASHBOARD.md` 등과 같은 목적·형식으로 작성했으며, 구현 명령을 내릴 때
> 이 문서를 참조점으로 삼습니다. 코드가 바뀌면 이 문서도 함께 갱신해야 합니다.
>
> 조사 시점: 2026-09-20(신규 작성 — 이 기능은 2026-09-19 하루 동안 통째로
> 새로 만들어졌는데, `docs/WEB_DASHBOARD.md`/`WEB_REPORT.md`/`WEB_SETTINGS.md`/
> `WEB_ADMIN.md`/`HELPERBOT.md` 5개 기존 설계 문서 어디에도 반영되지 않고 있던
> 것을 코드 전수 조사로 발견해 새로 작성함). 대상 커밋 기준
> `app/src/pages/ChatPage.tsx`, `app/src/pages/chat-theme.css`,
> `app/src/App.tsx`(라우트), `app/src/components/layout/TabBar.tsx`(탭),
> `frame-checker-worker/src/chat.js`, `frame-checker-worker/src/index.js`
> (라우팅), `frame-checker-worker/wrangler.toml`(`STREAM_CHAT_API_KEY`).
>
> 2026-09-21 갱신: 2026-09-20~21 이틀에 걸친 UI/UX 다듬기(탭바 접힘,
> 시간대별 그룹핑, 메시지 액션 메뉴 범위, iOS PWA 키보드/뷰포트 버그
> 시리즈 등)를 반영해 §3.4, §3.5(신규)를 추가/갱신하고 §6에 함정
> 2건을 보강함. 관련 파일: `app/src/hooks/useKeyboardInset.ts`(신규),
> `app/src/components/layout/AppShell.tsx`, `app/index.html`.

## 1. 범위 정의 — "채팅"이란

`App.tsx`의 `MainView`(`"/", "/report", "/chat", "/notifications", "/settings",
"/admin"`)에 등록된 `"/chat"` 경로가 렌더링하는 `ChatPage`를 말한다. 하단 탭바의
"채팅" 항목(`MessageCircle` 아이콘)이며, 다른 메인 뷰들과 마찬가지로 한 번 열리면
언마운트되지 않고 `hidden` 속성으로만 감춘다(WebSocket 연결을 계속 유지해 실시간
수신을 놓치지 않기 위함 — `docs/WEB_DASHBOARD.md` §3.1과 동일한 정책).

내부적으로 하위 라우트나 URL 쿼리 탭 구조는 없다 — `isAdmin` 여부에 따라 완전히
다른 두 화면(§2)을 하나의 컴포넌트가 분기해서 그린다.

**이 문서의 범위에 포함되는 것**: `ChatPage`/`chat-theme.css`가 구현하는 채팅
UI 전체, 그리고 `/chat/token`·`/chat/ensure-user`·`/chat/configure-uploads`
세 백엔드 엔드포인트.

**포함되지 않는 것**: Stream Chat 자체의 기본 기능(메시지 전송/수신, 실시간
동기화, 첨부파일 업로드 등 SDK가 기본 제공하는 부분)은 이 문서에서 다시
설명하지 않는다 — 이 문서는 **이 앱이 Stream 기본 동작을 어떻게 오버라이드/
커스터마이즈했는지**에 집중한다. 회원 인증(로그인 세션, `memberNumber`/
`memberName`)은 `frame-checker-worker/src/auth.js`(별도 문서 없음, `index.js`의
`verifySession`)가 이미 처리하며, 이 기능은 그 세션을 그대로 재사용한다.

---

## 2. 화면 구조

### 2.1 회원 화면

목록 없이 로그인 즉시 본인-관리자 채널(`inquiry-member-{번호}`)로 바로 진입한다.
채널이 없으면 멱등 생성(`members: [본인, "admin"]`)하고 `channel.watch()`로 연다.
헤더 타이틀은 고정 문자열 "관리자에게 문의하기".

### 2.2 관리자 화면

좌측 사이드바(접기/펼치기 가능, 접혀도 언마운트하지 않고 `width: 0`으로만 감춤 —
`ChannelList`의 활성 채널 구독을 유지하기 위함) + 우측 대화창 2단 레이아웃.
사이드바 상단의 "채팅 목록"/"회원 목록" 알약형 탭(`ChatListHeader`, `ReportPage`와
동일한 디자인 패턴)으로 두 뷰를 전환한다:

- **채팅 목록**(기본) — 지금까지 문의가 들어온 모든 회원과의 채널 목록
  (`ChannelList filters={{ type: "messaging", members: { $in: ["admin"] } }}`).
- **회원 목록**(`AdminMemberList`) — `GET /admin/members`로 전체 회원을 불러와
  스크롤 목록으로 보여준다. 클릭하면:
  1. `POST /chat/ensure-user`로 그 회원을 Stream에 먼저 upsert(§4.2 — 아직 한
     번도 로그인한 적 없는 회원은 Stream에 존재하지 않아 이 단계 없이는
     채널 생성이 400으로 실패한다).
  2. `client.channel("messaging", inquiryChannelId(userId), {...}).watch()`로
     채널을 열고 `setActiveChannel`로 즉시 활성화.
  3. 완료 시 자동으로 "채팅 목록" 뷰로 돌아가 방금 연 대화가 목록에 반영되게 함.

---

## 3. 메시지 UI 커스터마이즈 (`SwipeableMessage` 등)

Stream Chat React는 `ComponentContext`로 각 UI 슬롯을 교체할 수 있는데, 이 앱은
`ChatPage.tsx`의 `ComponentProvider`에서 다음을 오버라이드한다:

| 슬롯 | 대체 컴포넌트 | 목적 |
|---|---|---|
| `Avatar` | `PersonAvatar` | Stream 기본은 이니셜 표시 — 항상 사람 아이콘만 보이게 |
| `ChannelListHeader` | `() => null` | Stream 기본 "채팅" 텍스트 헤더 숨김(`ChatListHeader`가 대신함) |
| `Message` | `SwipeableMessage` | 스와이프 답장/롱프레스·우클릭 메뉴/시간 표시 등 아래 §3.1~§3.4 |
| `AttachmentSelector` | `ImageOnlyAttachmentSelector` | "+" 메뉴를 이미지 첨부 하나로 제한 |
| `AttachmentSelectorInitiationButtonContents` | `ImagePlusButtonIcon` | "+" 버튼 아이콘을 이미지 아이콘으로 |
| `DateSeparator` | `ChatDateSeparator` | "2026년 9월 19일 토요일" 형식, floating(sticky) 배지는 숨김 |
| `QuotedMessage` | `ChatQuotedMessage` | 인용 카드 클릭 시 원본으로 스크롤+흔들림 애니메이션 |

### 3.1 스와이프 답장

메시지 버블을 왼쪽으로 드래그(임계값 40px, 최대 64px)하면 답장 아이콘이 나타나고,
손을 뗄 때 임계값을 넘었으면 `messageComposer.setQuotedMessage(message)`를
호출한다. `pointerdown`/`pointermove`/`pointerup`을 직접 다루는 커스텀 제스처라
다음 세 가지 함정을 실측으로 확인하고 우회했다:

- **이미지의 네이티브 드래그**: `<img>` 기본값 `draggable=true`가 스와이프를
  가로채 이미지 메시지에서만 스와이프가 전혀 안 됐다 — `chat-theme.css`에서
  `-webkit-user-drag: none`으로 해결.
- **실제 마우스 클릭이 미세하게 떨려 click이 억제되는 문제**: `setPointerCapture`로
  포인터를 캡처하면, 실제 마우스로 클릭할 때의 1~3px 미세한 흔들림이
  `pointermove`를 발생시켜 브라우저가 "드래그 중"으로 오판하고 뒤이은 `click`
  합성을 생략한다(자동화된 정확히 같은 좌표의 합성 이벤트로는 재현 안 됨 —
  실제 마우스에서만 재현). 이동 거리가 데드존(5px) 이하면 우리가 직접
  `.click()`을 원래 타겟에 합성 발생시켜 우회.
- **세로 스크롤 중 미세한 가로 흔들림에 반응**: 세로 이동량과 비교해 가로
  이동이 더 뚜렷할 때만 스와이프로 인정(`Math.abs(delta) < Math.abs(deltaY)`면
  무시).

### 3.2 이미지 확대 모달

이미지를 클릭하면 Stream 기본 `GalleryUI`가 확대 모달을 연다. 이 앱이 추가로
손댄 부분:

- **본인 이미지 헤더의 "당신" → 실제 이름**: `GalleryHeader`(Stream 내부
  컴포넌트, `ComponentContext`로 교체 불가 — `ModalGallery.tsx`가 `GalleryUI`를
  prop으로 직접 주입해 컨텍스트 오버라이드보다 우선함)가 본인이 보낸 이미지일
  때 `t("You")`(="당신")를 그대로 텍스트로 렌더링한다. `ChatPage`의
  `MutationObserver`가 DOM에서 이 텍스트가 정확히 "당신"일 때만(상대방 이름은
  건드리지 않음) 로그인한 사용자의 실제 이름(`client.user.name`, §4.1의
  `userName`)으로 치환한다.
- **배경 클릭 시 닫기**: Stream의 `closeOnBackgroundClick`은 이벤트 타겟이
  정확히 `slide-container` 자신일 때만 닫는데, 실제로는 그 유일한 자식
  (`media-container`/`media`)이 컨테이너 전체를 채워 거의 항상 무시된다.
  `<img>`/`<video>` 자신이 아닌 모든 클릭에서 닫기 버튼을 대신 눌러주는 전역
  리스너로 보완.
- **헤더 위치**: `.str-chat__gallery__header`를 `position: absolute`로 이미지
  위에 오버레이해 사진과 헤더 사이 간격을 좁힘(`chat-theme.css`).

### 3.3 메시지 액션 메뉴 (수정/삭제/반응)

Stream이 이미 편집/삭제/반응 추가 기능을 갖춘 `MessageActions` 메뉴를
내장하고 있는데, 이 앱이 새로 만든 것은 그 메뉴를 여는 **카카오톡식 롱프레스
(모바일, 450ms)/우클릭(PC) 트리거**뿐이다 — 이미 렌더링된 "..." 토글 버튼
(`[data-testid="message-actions-toggle-button"]`)을 프로그래매틱하게
`.click()`한다.

이 과정에서 실측으로 확인한 함정들(모두 `ChatPage.tsx` 인라인 주석에 상세
경위 기록):

- 토글 버튼을 담은 `.str-chat__message-options`는 기본 `display:none`이라
  `.click()` 시점에 크기가 0이면 메뉴가 화면 좌상단(8,8)으로 fallback한다 —
  클릭 직전에 인라인 `!important`로 강제로 보이게 만든다.
- 이 컨테이너 자신에게 `width: 96px` 고정값이 있어(자식 3개를 다 숨겨도
  사라지지 않음), 강제로 보이게 하면 grid 레이아웃이 그만큼 이미지/버블을
  줄이거나 밀어낸다 — 사용자 요청으로 결국 이 3개 버튼(토글 포함)을 전부
  화면에서 사라지게(크기 0) 만들되, **`toggleBtn.click()` 호출 이후에만**
  크기를 줄인다(그 전에 줄이면 클릭 시점 위치 계산 자체가 깨짐).
- **[가장 까다로웠던 버그]** 롱프레스로 메뉴를 여는 손가락을 뗄 때, 브라우저가
  그 터치를 이어서 이미지 위에 진짜 `click`을 발생시켜 확대 모달이 함께
  열리고, 그 클릭이 Stream의 `document` 레벨 "바깥 클릭 시 메뉴 닫기" 캡처
  리스너(`DialogPortal.mjs`)까지 트리거해 메뉴도 같이 닫혀버렸다. `document`에
  리스너를 먼저 등록해 `stopPropagation`으로 막으려는 시도는 실측 결과
  실패했다(Stream 리스너가 실제로는 먼저 등록되어 있었고, `preventDefault`는
  이미 등록된 다른 리스너의 실행 자체를 막지 못함 — 브라우저 이벤트 스펙).
  최종 해결책은 **원본 `TouchEvent`(React `PointerEvent`가 아님)의
  `preventDefault()`**로 브라우저가 `click` DOM 이벤트 자체를 생성하지 못하게
  막는 것 — W3C 스펙상 `touchend`에서 이걸 호출하면 그로부터 파생되는 클릭이
  아예 생성되지 않는다. 등록 순서 경쟁에 의존하지 않는 유일하게 확실한 방법.

### 3.4 발신자 이름/시간 표시

- **발신자 이름**: 로그인 세션의 `memberName`을 그대로 Stream user name으로
  쓴다(§4.1) — 관리자도 고정 문자열 "관리자"가 아니라 실제 이름이 표시된다.
  카카오톡처럼 같은 사람이 연속으로 보낸 메시지 그룹에서는 첫 메시지에만
  아바타+이름을 보여준다(`useSenderNameToShow`).
  🔧 [버그 수정, 2026-09-21] Stream의 `groupStyles`(`"top"`/`"middle"`/
  `"bottom"`/`"single"`)는 오직 "같은 발신자가 연속으로 보냈는가"만 보고,
  그 사이 시간이 몇 분이 지났든 전혀 고려하지 않는다(Stream 자체에 이
  기준을 넣는 옵션이 없음 — 실측: 16분 간격에도 `groupStyles`가 계속
  `"middle"`). `processedMessages`에서 직전 메시지를 찾아 분/시/날짜가
  다르면 `groupStyles` 값과 무관하게 그룹 시작으로 취급하도록 보정했다.
- **시간**: Stream 기본은 dayjs 24시간제 — `formatMessageDate()`로 12시간제
  ("오전/오후 h:mm")로 직접 렌더링하고, 같은 분에 연속으로 보낸 메시지는
  마지막 것에만 표시한다. 읽음 확인은 카카오톡처럼 "1" 배지(상대가 안 읽었을
  때만 표시, `useUnreadOneBadge`)로 대체.
- **메시지 여백 롱프레스/우클릭**: §3.3의 액션 메뉴 트리거는 처음엔 메시지
  버블 전체(빈 여백 포함)에 걸려 있어, 아바타-이름 사이나 인용카드+사진이
  있는 메시지의 콘텐츠 사이 빈 공간을 눌러도 메뉴가 떴다. 실제 콘텐츠
  요소(텍스트/이미지/인용카드) 위에서만 인정하도록 좁혔다.
- **메시지 액션 메뉴가 입력창(composer) 아래로 관통하는 문제**: floating-ui의
  `flip` 미들웨어가 채팅 전용 `position:fixed` 컨테이너(§3.5)를 화면
  경계로 인식하지 못해, 메뉴가 화면 하단 기준으로만 뒤집혀 입력창 영역을
  뚫고 내려가곤 했다. `requestAnimationFrame`으로 메뉴가 실제 렌더링된
  뒤 DOM 위치를 다시 읽어, 입력창 상단을 넘으면 위로 밀어올리는 사후
  보정을 추가했다(`getBoundingClientRect().height`는 `bottom` CSS
  오프셋을 반영 못 하므로 `window.innerHeight - rect.top`으로 총 높이를
  계산).

### 3.5 하단 탭바 접힘 + 키보드/뷰포트 대응 (iOS PWA 특유의 함정)

채팅은 입력창까지 세로 공간이 빠듯해, 하단 탭바(`TabBar`)를 접어 `^`
아이콘 하나로 줄일 수 있는 `AppShell`의 `collapsibleTabBar` 옵트인을 쓰는
유일한 화면이다. 이 기능과 "키보드가 뜨면 채팅 입력창이 카카오톡처럼
키보드 바로 위까지 붙어야 한다"는 요구가 겹치면서, **iOS PWA(홈 화면에
추가해 standalone으로 실행) 특유의 뷰포트 버그 여러 개**를 실기기 + Mac
Safari 원격 디버깅(iOS 기기 웹 인스펙터)으로 실측 후 하나씩 해결해야
했다. 관련 코드: `app/src/hooks/useKeyboardInset.ts`,
`app/src/components/layout/AppShell.tsx`, `app/index.html`.

**iOS Safari/PWA의 키보드 처리 방식**: 키보드가 뜰 때 `100dvh`나 레이아웃
자체를 줄이지 않고, 대신 `visualViewport`("카메라")를 문서 좌표계 안에서
키보드 높이만큼 아래로 이동(`offsetTop > 0`)시킨다. 근본 해법은 채팅
컨테이너 자체를 `position:fixed`로 만들고 `top`/`height`를
`visualViewport.offsetTop`/`height`로 매 `resize`마다 직접 계산하는
것(`useVisualViewportRect`) — 카카오톡 웹뷰 등 실제 모바일 채팅 UI가 쓰는
표준 패턴과 같다. 이 방식을 `TabBar`(`collapseButton`/`viewportRect` prop)와
채팅 컨테이너 둘 다에 일관되게 적용해야 한다 — 한쪽만 적용하면 뷰포트가
어긋난 두 좌표계가 서로 겹쳐 요소가 잘리거나 파묻히는 문제가 재발한다
(아래 "발견된 버그들" 4번째 항목).

**발견된 iOS 고유 버그들** (모두 PWA standalone, 실기기 실측으로 확인 —
시뮬레이터/Playwright로는 재현 안 됨):

1. **`visualViewport.offsetTop`/`height` 원복 실패**: 키보드를 닫은 뒤
   `visualViewport.height`가 원래값(예: 844)이 아니라 상단 안전영역만큼
   (예: 47px) 줄어든 값(797)에 계속 머무는 경우가 있다. `resize` 이벤트를
   아무리 재구독하거나 디바운스해도 고쳐지지 않는다 — 브라우저 자체가
   잘못된 값을 보고하는 것이라 그렇다. `index.html`의 viewport meta에
   `interactive-widget=resizes-content`(iOS 16.4+, 키보드 등장/해제에
   맞춰 레이아웃 뷰포트를 브라우저가 직접 리사이즈하도록 위임하는 표준
   속성)를 추가해봤으나 이 WebView(PWA standalone)에서는 효과가
   없었다 — 유지는 하되(다른 최신 기기에서 도움이 될 수 있음) 이 버그의
   실질적 해법으로 의존하지 않는다.
2. **`window.innerHeight`도 동시에 같은 버그를 겪는다**: 1번과 완전히
   독립된 문제가 아니라, `innerHeight`와 `visualViewport.height`가
   "둘 다 함께" 같은 잘못된 값(797)을 보고한다 — 즉 두 API 사이의 계산
   불일치가 아니라 WebKit이 이 시점에 보고하는 뷰포트 값 자체가 실제로
   잘못됐다는 뜻이다.
3. **`document.documentElement.clientHeight`(실제 렌더링 가시 영역)까지
   같은 문제를 겪는다**: `html`/`body`에 인라인으로 정확한 높이(844px)를
   강제해도, `clientHeight`는 여전히 797로 남을 수 있다 — 이 차이만큼
   문서 전체가 스크롤 가능해지는 부작용이 생기지만, `position:fixed`
   요소는 스크롤과 무관하게 항상 뷰포트에 고정되므로 실질적인 문제는
   아니다(불필요한 스크롤 여지 자체는 남겨둔다 — 아래 4번째 함정 참고).
4. **DOM 위치 역산 방식의 이중 함정**: `AppShell`의 `^`버튼(탭바 접힘
   힌트)은 원래 `bottom: calc(env(safe-area-inset-bottom)/2)`처럼 순수
   CSS로 화면 최하단에 고정됐는데, 이 `bottom` 오프셋 자체가 레이아웃
   뷰포트(`window.innerHeight`) 하단을 기준으로 계산되므로 1~2번 버그의
   영향을 그대로 물려받는다. `tabBarHeight`를
   `window.innerHeight - 버튼의 rect.top`으로 역산하는 방식도 마찬가지
   함정에 걸린다: 뷰포트 높이가 보정돼도 버튼의 실제 DOM 위치는 그
   보정 "이전" 시점 기준으로 그려진 채 남아 있어, 두 낡은 값이 상쇄되지
   않고 오히려 어긋난다. **해결책은 뷰포트 참조 자체를 없애는 것** —
   버튼은 자기 자신의 렌더링 높이(콘텐츠 크기, 뷰포트와 무관하게 항상
   정확)에 안전영역 상수(`useSafeAreaInsetBottom`)만 더해 순수 CSS
   값만으로 계산하고, 위치도 `bottom` 오프셋 대신 `TabBar`와 동일하게
   `viewportRect` 기준 `top`으로 직접 계산한다.
5. **`.str-chat__message-list-scroll`은 실제 스크롤 컨테이너가 아니다**:
   Stream 소스(`MessageList.mjs`)를 직접 읽어 확인한 결과, `onScroll`/
   `ref`가 걸리는 실제 스크롤 컨테이너는 `messageListClass`(기본값
   `"str-chat__message-list"`)이고, `.str-chat__message-list-scroll`은
   그 안의 `InfiniteScroll` 컴포넌트(콘텐츠 래퍼)일 뿐이다 — computed
   `overflow-y: visible`(스크롤 불가능한 상태)이고 `scrollTop`을 대입해도
   즉시 0으로 원복된다. 채팅 컨테이너가 리사이즈될 때(키보드 뜸/닫힘)
   Stream이 스크롤 위치를 자동으로 재조정하지 않는 문제를 보정하려면
   `.str-chat__message-list`를 `ResizeObserver`로 감시해야 한다.

이 중 어느 하나라도 놓치면 "`^`버튼이 안 보이거나 입력창에 파묻힌다",
"컨테이너는 정상 크기인데 마지막 메시지가 안 보이고 스크롤을 올려야
과거 메시지가 나온다" 같은 증상이 재발한다 — 콘솔 로그나 배지 값만으로
추측하지 말고, Mac Safari의 iOS 기기 웹 인스펙터(설정 > Safari > 고급 >
"웹 검사기" 켜기 → 케이블 1회 연결)로 실제 `getBoundingClientRect()`/
`getComputedStyle()` 값을 직접 확인해야 정확히 잡힌다.

---

## 4. 백엔드 (`frame-checker-worker/src/chat.js`)

Node.js 전용 `stream-chat` 서버 SDK 대신 Stream REST API를 fetch로 직접
호출한다(Cloudflare Workers 런타임 호환성 — SDK가 Node 전용 API를 쓸 위험을
피함). JWT(HS256)는 표준 형식으로 직접 서명하며, 이 프로젝트 기존 세션 토큰
(`signSession`, header 없는 2-part)과는 다른 별도 구현이다.

| Method | Path | 핸들러 | 인증 | 설명 |
|---|---|---|---|---|
| POST | `/chat/token` | `handleChatToken` | 세션(누구나) | Stream용 JWT 발급 + 유저 upsert |
| POST | `/chat/ensure-user` | `handleChatEnsureUser` | 세션+관리자 | 관리자가 먼저 대화를 시작할 회원을 사전 upsert |
| POST | `/chat/configure-uploads` | `handleChatConfigureUploads` | 세션+관리자 | Stream 앱 전체 설정에서 비이미지 업로드 차단(1회성) |

### 4.1 `/chat/token` — `userId`/`userName` 결정 규칙

- `isAdmin` 판정은 이 프로젝트 전역 관례(`session.email`과 `env.ADMIN_EMAIL`
  대소문자 무시 비교)와 동일 — 세션 자체에 `isAdmin` 필드는 없다.
- `userId`: 회원은 `member-{memberNumber}`, 관리자는 고정값 `"admin"`(주
  관리자 1명 체계).
- `userName`: `session.memberName || session.name || (isAdmin ? "관리자" :
  "회원")`. 🔧 관리자도 세션 토큰(로그인 시점 발급)에 이미 `memberName`이
  들어있음을 실측으로 확인해(관리자 계정도 회원 명단에 등록되어 있어 로그인
  시 함께 채워짐) 별도 구글 시트 재조회 없이 세션 값을 그대로 재사용한다 —
  처음엔 `report-review.js`의 "스터디장 (이름)"처럼 시트를 다시 조회하려
  했으나 불필요했다.
- 매 토큰 발급 시 `upsertStreamUser`로 Stream에 해당 유저를 upsert한다(멱등,
  이름이 바뀌었을 경우 최신화 목적).

### 4.2 채널 id 규칙

`inquiryChannelId(memberUserId) = "inquiry-" + memberUserId` (예:
`inquiry-member-3`). 회원 쪽 `userId`를 그대로 채널 id에 써서, 같은 회원이
다시 들어와도 항상 같은 채널로 멱등 연결된다.

### 4.3 업로드 제한

프론트의 "+" 메뉴 제한(§3의 `ImageOnlyAttachmentSelector`)만으로는 API 직접
호출이나 드래그앤드롭으로 임의 파일 업로드를 막지 못한다. `stream-chat` SDK
소스(`AttachmentManager.getUploadConfigCheck`)를 직접 읽어 확인한 결과, 업로드
차단 검증은 **채널 타입 설정이 아니라 앱 전체 설정**(`GET`/`PATCH /app`의
`file_upload_config`)만 참조하고, `allowed_mime_types` 비교가 완전 일치(`===`)
라 `"image/*"` 와일드카드는 매치되지 않는다는 것도 확인했다 — 그래서
`file_upload_config.allowed_mime_types`를 실제 이미지 MIME 목록
(`IMAGE_MIME_TYPES`)으로 명시적으로 좁혀 비이미지 파일 업로드를 차단한다.
관리자가 배포 후 1회만 호출하면 되는 설정용 엔드포인트.

---

## 5. 환경 변수

`frame-checker-worker/wrangler.toml`에 `STREAM_CHAT_API_KEY`(공개 가능한 값,
프론트에도 그대로 노출됨 — Stream 관례)가 일반 변수로 등록되어 있다. 비밀 값인
`STREAM_CHAT_API_SECRET`은 `wrangler secret put`으로 별도 등록(`env` 객체에는
있지만 `wrangler.toml`에는 없음).

---

## 6. 알려진 함정 / 특이사항

- **실제 마우스/터치 이벤트와 합성 이벤트(Playwright `dispatchEvent` 등)의
  차이가 이 기능 개발 중 최소 3회(스와이프 클릭 억제, 이미지 확대+메뉴 동시
  발동, 롱프레스 종료 시 클릭 누출) 똑같은 패턴으로 재현됐다.** 합성
  `PointerEvent`로는 재현되지 않고 실제 마우스/터치에서만 재현되는 버그를
  마주치면, "손 떨림"이나 "브라우저의 네이티브 이벤트 승격" 같은 실제 입력
  장치 특유의 동작을 의심할 것 — Playwright의 CDP 레벨 `Input.dispatchTouchEvent`
  나 `page.mouse`가 실제 브라우저 클릭 승격 로직을 더 정확히 재현한다(단순
  `element.dispatchEvent(new PointerEvent(...))`보다 신뢰도가 높음).
- **`document`에 등록된 두 캡처 리스너 중 어느 게 먼저 실행되는지는
  등록 순서에 의존하며, `preventDefault()`는 이미 등록된 다른 리스너의
  실행 자체를 막지 못한다.** Stream Chat React 내부의 여러 곳
  (`DialogPortal.mjs` 등)이 `document`에 직접 클릭 캡처 리스너를 걸어두므로,
  이 리스너들과 순서를 다투는 방식(예: `stopPropagation`)은 신뢰할 수 없다 —
  대신 원본 이벤트(`TouchEvent`)의 `preventDefault()`로 애초에 그 파생
  이벤트 자체가 생성되지 않게 막는 편이 유일하게 확실하다(§3.3 참고).
- **`ModalGallery`가 `GalleryUI`를 prop으로 직접 주입해 `ComponentContext`
  오버라이드보다 우선한다** — 이미지 확대 모달의 헤더(`GalleryHeader`)처럼
  일부 Stream 내부 컴포넌트는 슬롯 교체가 아예 불가능하다. 이럴 때는
  `MutationObserver`나 DOM 텍스트 감지 같은 imperative 우회가 필요하다(§3.2).
- **Vite dev 서버의 HMR이 이 파일(특히 `ChatPage.tsx`의 이벤트 리스너 등록
  로직)을 여러 차례 오래된 상태로 유지해 버그처럼 보인 사례가 반복됐다** —
  `rm -rf node_modules/.vite` + dev 서버 완전 재시작이 실측 검증 전 거의
  매번 필요했다.
- **iOS PWA(standalone)의 뷰포트 버그는 스크린샷/디버그 배지 값 비교만으로는
  근본 원인에 못 미친다** — §3.5에 정리된 5가지 버그는 겉보기 증상(여백,
  `^`버튼 위치, 스크롤 안 됨)이 서로 뒤섞여 나타나 여러 차례 잘못된 원인을
  짚고 되돌리는 시행착오를 거쳤다. Mac Safari의 iOS 기기 웹 인스펙터로
  실기기에 직접 연결해 `getBoundingClientRect()`/`getComputedStyle()`을
  콘솔에서 직접 확인하고 나서야 각 버그를 정확히 분리해 잡을 수 있었다 —
  다음에 비슷한 증상이 재발하면 처음부터 이 방법을 쓸 것.
- **`.str-chat__message-list-scroll`과 `.str-chat__message-list`를 혼동하기
  쉽다** — 이름이 비슷해 직관적으로는 전자가 스크롤 컨테이너처럼 보이지만,
  실제 `onScroll`/스크롤 가능한 요소는 후자다(§3.5의 5번 항목). Stream
  DOM에서 스크롤 위치를 직접 조작해야 할 일이 생기면 반드시 소스
  (`MessageList.mjs`)나 실측(`overflow-y` computed style, `scrollTop`
  대입 후 값이 실제로 바뀌는지)으로 확인할 것.

---

## 7. 관련 문서

- `docs/WEB_DASHBOARD.md` §11, `docs/WEB_ADMIN.md` §7 — 이 기능이 5개 기존
  설계 문서 어디에도 없었다는 사실이 교차 기록되어 있다(이 문서 작성으로
  해소됨).
- `docs/WEB_ADMIN.md` — 관리자 전용 회원 목록(`GET /admin/members`, §3.5)을
  `AdminMemberList`가 그대로 재사용한다.
