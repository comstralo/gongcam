import { useEffect, useRef, useState } from "react";
import { StreamChat } from "stream-chat";
import {
  Chat,
  Channel,
  ChannelList,
  ChannelHeader,
  MessageList,
  MessageComposer,
  MessageUI,
  Thread,
  Window,
  LoadingIndicator,
  useChatContext,
  useMessageContext,
  useMessageComposerController,
  useMessageListContext,
  useChannelActionContext,
  useChannelStateContext,
  useAttachmentSelectorContext,
  useComponentContextIcons,
  AttachmentSelector,
  ContextMenu,
  ContextMenuButton,
  useContextMenuContext,
  QuotedMessagePreviewUI,
  ComponentProvider,
  Streami18n,
  MessageReactions,
  type ContextMenuProps,
} from "stream-chat-react";
import "stream-chat-react/dist/css/index.css";
import "@/pages/chat-theme.css";
import { MessageCircle, X, User, Reply, ImagePlus, Pin, Smile } from "lucide-react";
import { InfoCard } from "@/components/dashboard/shared";
import { AdminListSkeleton, AdminEmptyState, AdminSearchInput } from "@/components/admin/shared";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApi } from "@/hooks/useApi";
import { useAuth } from "@/lib/auth/useAuth";
import { useTheme } from "@/hooks/useTheme";
import { useVisualViewportRect, useSafeAreaInsetTop } from "@/hooks/useKeyboardInset";
import { ICON_STROKE, cn } from "@/lib/utils";
import type { AdminMembersResponse, ChatTokenResponse } from "@/lib/api/types";

// 🔧 [버그 수정, 2026-09-19 사용자 지시: "꾹 눌러서 메뉴를 띄웠을 때,
// 이미지 영역을 터치해서 취소하려고 하면 이미지가 열려버린다"] —
// 롱프레스로 메뉴를 여는 그 손가락을 뗄 때, 브라우저가 이 터치를 이어서
// 이미지 위에 진짜 click 이벤트를 발생시켜(실측: CDP 터치 이벤트로
// 재현, 합성 PointerEvent로는 재현 안 됨) 확대 모달이 열리고, 그 클릭이
// Stream의 DialogPortalDestination(document에 capture:true로 걸리는
// "바깥 클릭 시 다이얼로그 닫기" 리스너, 소스 확인)까지 트리거해 메뉴도
// 함께 닫혀버렸다. Stream의 이 리스너는 다이얼로그가 실제로 열릴 때(즉
// 사용자가 롱프레스하는 시점)에야 등록되는 반면, 이 플래그를 지켜보는
// 우리 리스너는 ChatPage가 마운트되는 앱 초기 렌더 시점에 이미 등록돼
// 있어 캡처 단계에서 항상 Stream보다 먼저 실행된다(캡처는 document의
// 리스너부터 등록 순서대로 실행) — 이 순서를 이용해 원치 않는 클릭
// 자체를 Stream이 보기 전에 여기서 완전히 삼킨다. 메시지마다 새로
// 렌더링되는 SwipeableMessage 안의 지역 상태로는 이 전역 순서를 보장할
// 수 없어 모듈 스코프 변수로 둔다.
let blockNextClick = false;

// 🔧 [사용자 지시, 2026-09-19] "지난 메시지도 '오후 5:56'처럼 시간이
// 표시되도록" — Stream 기본 MessageTimestamp는 dayjs의 로케일 인식
// 포맷(LT)을 쓰는데, i18n 설정과 무관하게 실측 결과 24시간제("18:00")로
// 표시되고 있었다. 이 함수로 이 앱이 원하는 12시간제(오전/오후 h:mm)
// 포맷을 만들고, SwipeableMessage가 직접 시간을 그릴 때 사용한다.
// 🔧 [버그 수정] 원래 MessageList의 formatDate prop으로 넘겼었는데,
// renderMessages.mjs 소스를 보면 이 prop이 메시지 타임스탬프뿐 아니라
// DateSeparator(날짜 구분선)에도 그대로 전달된다 — 그 결과 구분선까지
// "오후 5:04" 같은 시간 형식으로 나오는 문제가 있었다(사용자 실측
// 스크린샷으로 확인). 지금은 MessageList에 넘기지 않고 이 함수만
// 메시지 시간 렌더링에 쓴다(날짜 구분선은 별도 ChatDateSeparator가
// 전담).
function formatMessageDate(date: Date) {
  const hours24 = date.getHours();
  const period = hours24 < 12 ? "오전" : "오후";
  const hours12 = hours24 % 12 || 12;
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${period} ${hours12}:${minutes}`;
}

// 🔧 [사용자 지시, 2026-09-19] "날짜 표시도 '2026년 6월 26일 금요일'
// 같은 식으로" — 메시지 사이사이에 나오는 날짜 구분선(오늘이 아닌
// 과거 날짜)을 이 형식으로 고정한다. ComponentContext.DateSeparator
// 슬롯으로 Stream 기본 컴포넌트를 완전히 대체한다(마크업/클래스는
// 그대로 재사용해 기존 CSS 스타일이 깨지지 않게 한다).
const WEEKDAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"] as const;

function formatFullDate(date: Date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const weekday = WEEKDAY_NAMES[date.getDay()];
  return `${year}년 ${month}월 ${day}일 ${weekday}요일`;
}

// 🔧 [버그 수정, 2026-09-19 사용자 지시: "왜 이게 위에 떠다니냐"] —
// Stream은 이 슬롯을 두 군데서 함께 쓴다: 메시지 사이사이의 고정
// 구분선(floating 없음), 그리고 스크롤 중 상단에 sticky로 뜨는
// FloatingDateSeparator(floating=true). 이 컴포넌트가 floating prop을
// 무시하고 항상 같은 마크업(비-floating 클래스)을 그려서, sticky
// 위치 스타일(.str-chat__date-separator--floating의 position:absolute
// 등)이 전혀 안 붙은 채 문서 흐름에 끼어들어 원래 구분선과 겹쳐
// "두 개가 동시에 떠 있는" 것처럼 보였다. 이 앱은 애초에 떠다니는
// 배지 자체가 필요 없다는 사용자 지시(이전 턴)가 있었으므로,
// floating일 때는 아예 렌더링하지 않는다.
function ChatDateSeparator({ date, floating }: { date: Date; floating?: boolean }) {
  if (floating) return null;
  return (
    <div className="str-chat__date-separator" data-date={date.toISOString()} data-testid="date-separator">
      <div className="str-chat__date-separator-date">{formatFullDate(date)}</div>
    </div>
  );
}

// 🔧 [사용자 지시, 2026-09-19] "쉐이크 애니메이션 테스트 해보니까 가까운
// 메시지는 1번 이동으론 발동이 안 되고 2번부터는 잘 됨. 먼 곳에 있는
// 메시지는 여러 번 눌러봐도 확인이 안 됨" — 처음엔 Stream의
// useMessageContext().highlighted(boolean)를 useEffect 의존성으로
// 관찰했는데, 같은 메시지를 연속으로 인용 클릭하면 그 값 자체는
// true→true로 유지돼(React가 값 동일성으로 판단) effect가 재실행되지
// 않았다 — 그래서 같은 메시지를 다시 클릭하면(먼 메시지를 여러 번,
// 또는 가까운 메시지를 2번째부터) 흔들림이 트리거되지 않았다.
// Stream의 내부 state 변화에 기대는 대신, 인용(quoted) 메시지 카드
// 자체의 클릭을 이 컴포넌트(ComponentContext.QuotedMessage 슬롯,
// 원본 QuotedMessage.mjs를 대체)가 직접 가로채, jumpToMessage 호출
// 직후 대상 메시지 DOM([data-shake-target='<id>'], SwipeableMessage가
// 심어둔 속성)을 스크롤 완료까지 폴링한 뒤 클래스를 "제거 → 강제
// 리플로우 → 재추가"하는 imperative 방식으로 흔들림을 재생한다 —
// React state 동일성 판단이 전혀 개입하지 않아 몇 번을 연속으로
// 클릭해도, 대상이 이미 화면에 보이든 멀리 있든 항상 동작한다.
// 🔧 [버그 수정, 2026-09-22 사용자 지시: "'나에게 답장' 처럼 답장 메시지
// 포함된 버블은 답장 영역만이 아니라 버블 전체를 누르면 이동 이벤트가
// 발생하게 해줘"] — 원래 jumpToMessage + 흔들림 재생 로직이
// ChatQuotedMessage(인용 카드 자신)의 onClick 안에만 있어, 같은 버블
// 안이라도 카드 아래 본문 텍스트를 누르면 아무 반응이 없었다. 이 로직을
// 공용 함수로 뽑아 아래 SwipeableMessage의 버블 wrapper 클릭에서도 함께
// 쓴다.
function jumpToQuotedMessage(jumpToMessage: (id: string) => void, targetId: string) {
  jumpToMessage(targetId);

  // 최근에 시작된 폴링만 유효하도록, 이 클릭 시점의 토큰을 클로저에
  // 담아 이후 폴링 루프 안에서 계속 자기 자신을 확인한다(별도 정리
  // 로직 없이도, 새 클릭이 들어오면 이전 루프는 새 토큰과 다음 프레임
  // 비교에서 자연히 낡은 스크롤 상태를 관찰하게 되지만, 최종적으로
  // el.classList 토글 자체는 멱등이라 무해하다).
  let lastTop: number | null = null;
  let stableCount = 0;
  const checkSettled = () => {
    const el = document.querySelector<HTMLElement>(`[data-shake-target="${CSS.escape(targetId)}"]`);
    if (!el) {
      requestAnimationFrame(checkSettled);
      return;
    }
    const top = el.getBoundingClientRect().top;
    if (lastTop !== null && Math.abs(top - lastTop) < 1) {
      stableCount++;
    } else {
      stableCount = 0;
    }
    lastTop = top;
    if (stableCount >= 2) {
      // 같은 요소를 연속으로 흔들 때 CSS 애니메이션이 "이미 실행 중"이라
      // 재시작이 안 되는 것을 막기 위해, 클래스를 먼저 지우고 강제로
      // 리플로우(offsetWidth 읽기)시킨 뒤 다시 추가한다.
      el.classList.remove("chat-shake");
      void el.offsetWidth;
      el.classList.add("chat-shake");
      return;
    }
    requestAnimationFrame(checkSettled);
  };
  requestAnimationFrame(checkSettled);
}

// 🔧 [사용자 지시, 2026-09-23] "핀(메시지 고정)도 실제로 구현하는게
// 맞을 것 같아" — 메시지 액션 메뉴의 "핀"은 이미 동작했지만(Stream
// 기본 기능), 고정된 메시지를 한눈에 볼 수 있는 화면이 이 앱에
// 전혀 없어 고정해도 효과를 체감할 수 없었다. 카카오톡의 "공지"처럼
// 채널 헤더 바로 아래에 가장 최근에 고정된 메시지 1개를 요약해서
// 보여주는 배너를 추가한다 — 누르면 그 메시지로 스크롤 이동, "고정
// 해제" 버튼으로 바로 해제할 수 있다. useChannelStateContext().
// pinnedMessages는 Channel이 message.new/message.updated 등 실시간
// 이벤트를 받을 때마다 자동으로 갱신되므로(Stream 소스 확인), 별도
// 폴링 없이 항상 최신 상태를 반영한다.
function PinnedMessageBanner() {
  const { pinnedMessages } = useChannelStateContext();
  const { jumpToMessage } = useChannelActionContext();
  const { client } = useChatContext();

  if (!pinnedMessages || pinnedMessages.length === 0) return null;

  // 가장 최근에 고정된 메시지를 보여준다(여러 개면 배지로 개수만 함께 표시).
  const latest = [...pinnedMessages].sort((a, b) => {
    const aTime = a.pinned_at ? new Date(a.pinned_at).getTime() : 0;
    const bTime = b.pinned_at ? new Date(b.pinned_at).getTime() : 0;
    return bTime - aTime;
  })[0];

  const previewText = latest.text?.trim()
    ? latest.text
    : latest.attachments && latest.attachments.length > 0
      ? "사진"
      : "";

  function handleClick() {
    jumpToQuotedMessage(jumpToMessage, latest.id);
  }

  async function handleUnpin(e: React.MouseEvent) {
    e.stopPropagation();
    // 🔧 [버그 수정, 2026-09-23 실측] channel.unpinMessage는 존재하지
    // 않는 메서드였다(실행 시 "channel.unpinMessage is not a function"
    // pageerror로 확인) — stream-chat SDK 소스(client.ts) 확인 결과
    // pinMessage/unpinMessage는 channel이 아니라 StreamChat 클라이언트
    // 인스턴스에 있다. Stream React가 제공하는 usePinHandler는
    // MessageContext(메시지 컴포넌트 내부)에 종속되어 이 배너(메시지
    // 목록 바깥) 위치에서는 쓸 수 없으므로, useChatContext의 client로
    // 직접 해제한다.
    await client.unpinMessage(latest);
  }

  return (
    // 🔧 [lint 수정] 배너 본체 클릭(이동)과 "고정 해제" 클릭(해제)이
    // 서로 다른 동작이라 처음엔 <button> 안에 <span role="button">을
    // 중첩했는데, HTML 표준상 button은 button을 포함할 수 없어(interactive
    // content 중첩 금지) jsx-a11y가 정당하게 지적했다. 바깥을 button이
    // 아닌 div로 바꾸고, 배너 본체 클릭과 "고정 해제"를 각각 독립된
    // <button> 두 개로 나눠 형제로 둔다.
    <div className="flex w-full items-center gap-2 border-b bg-secondary/60 px-3 py-2 text-xs">
      <button
        type="button"
        onClick={handleClick}
        className="flex min-w-0 flex-1 items-center gap-2 text-left transition-colors hover:text-foreground"
      >
        <Pin className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={ICON_STROKE.default} />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {previewText}
          {pinnedMessages.length > 1 && (
            <span className="ml-1 text-muted-foreground/70">+{pinnedMessages.length - 1}</span>
          )}
        </span>
      </button>
      <button
        type="button"
        onClick={handleUnpin}
        className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground/70 hover:bg-background hover:text-foreground"
      >
        고정 해제
      </button>
    </div>
  );
}

function ChatQuotedMessage() {
  const { message } = useMessageContext();
  const { jumpToMessage } = useChannelActionContext();
  const { quoted_message } = message;
  if (!quoted_message) return null;

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    e.stopPropagation();
    e.preventDefault();
    jumpToQuotedMessage(jumpToMessage, quoted_message!.id);
  }

  return (
    <QuotedMessagePreviewUI
      quotedMessage={quoted_message}
      onClick={handleClick}
    />
  );
}

// 🔧 [버그 수정, 2026-09-19 사용자 지시] "메시지마다 시간이 붙어있지
// 않다 — 가장 아래 메시지에만 붙는다" → "같은 시각(분)에 전송된 메시지가
// 여러 개면 그 중 마지막에만" — 처음엔 Stream 기본 CSS
// (.str-chat__li--top/--middle의 metadata를 display:none)가 "같은
// 그룹(같은 발신자 연속)의 마지막에만" 시간을 보여주는 줄 알았으나,
// 이는 시각과 무관하게 그룹 전체에서 하나만 남기는 동작이라 분이 달라도
// (5:04 → 5:20) 시간이 안 보이는 문제가 있었다. "같은 분에 보낸
// 메시지들 중 마지막에만" 표시하려면 시각 비교가 필요해 CSS만으로는
// 안 되고, 다음 메시지와 분 단위까지 비교하는 이 함수로 직접 판정한다.
function isSameMinute(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate() &&
    a.getHours() === b.getHours() &&
    a.getMinutes() === b.getMinutes()
  );
}

// 🔧 [Stream Chat 도입, 2026-09-19 사용자 지시] "관리자-회원 1:1 문의방" —
// 회원은 본인과 관리자 단둘이 있는 채널 하나만 보면 되고(자동 생성/접속),
// 관리자는 지금까지 문의가 들어온 모든 회원과의 채널 목록을 볼 수 있어야
// 한다. 채널 id는 회원 쪽 userId("member-{번호}")를 그대로 써서, 같은
// 회원이 다시 들어와도 항상 같은 채널로 이어지게 한다(멱등 생성).
function inquiryChannelId(memberUserId: string) {
  // Stream 채널 id는 영문/숫자/@_- 만 허용 — memberUserId가 이미
  // "member-숫자" 형태라 그대로 안전하게 쓸 수 있다.
  return `inquiry-${memberUserId}`;
}

// 🔧 [사용자 지시] "상대방 아이콘을 사람 모양을 한 그림 형태로" — Stream
// 기본 Avatar(dist/es/components/Avatar/Avatar.mjs 실측 확인)는 userName이
// 있으면 icons.IconUser 슬롯 오버라이드와 무관하게 무조건 이니셜을
// 렌더링하는 고정 로직이라("재희"→"재"), ComponentContext의 icons.IconUser
// 오버라이드만으로는 해결되지 않는다(이니셜 자체가 없을 때만 그 슬롯을
// 쓰는 폴백 경로). 이니셜 로직 자체를 쓰지 않는 완전히 새로운 Avatar를
// ComponentContext.Avatar slot에 꽂아 항상 사람 아이콘만 보여준다 — Stream
// 원형 배경(str-chat__avatar 클래스)은 그대로 재사용해 크기/테두리 등
// 기존 스타일과 어울리게 한다.
function PersonAvatar({ size, className }: { size?: string | null; className?: string }) {
  return (
    <div
      className={cn(
        "str-chat__avatar flex items-center justify-center",
        size && `str-chat__avatar--size-${size}`,
        className
      )}
      data-testid="avatar"
    >
      <User className="size-[60%]" strokeWidth={ICON_STROKE.default} />
    </div>
  );
}

// 🔧 [사용자 지시, 2026-09-24] "이모지가 부착되는 모양새를 카카오톡에
// 맞춰줘 — 지금은 버블 위쪽에 있잖아" — Stream 기본 MessageReactions는
// verticalPosition="top"이 기본값이라 리액션 배지가 버블 위쪽에 떠
// 있었다(MessageReactions.mjs 소스 확인: top/bottom 둘 다 지원하는
// prop). 카카오톡은 배지를 버블 하단 모서리에 겹쳐 붙이므로
// verticalPosition="bottom"만 강제 지정한 얇은 wrapper를
// ComponentContext.MessageReactions 슬롯에 꽂는다 — 배지 자체의 동작
// (카운트, 클릭 시 상세 목록 등)은 100% Stream 컴포넌트 그대로다.
function BottomMessageReactions(props: React.ComponentProps<typeof MessageReactions>) {
  return <MessageReactions {...props} verticalPosition="bottom" />;
}

// 🔧 [사용자 지시, 2026-09-19] "'+' 버튼을 누르면 파일/명령어가 나오는데
// 이미지 첨부만 나오도록" + "일반 파일은 필요 없고 보안 위협도 있어
// 이미지만 전송 가능하도록 제한" — Stream 기본 "+" 메뉴는 파일/설문/
// 위치공유/명령어 액션을 갖는데(defaultAttachmentSelectorActionSet),
// 이 앱은 채널 config에 폴/위치공유/명령어를 켠 적이 없어 실제로는
// 파일/명령어 두 개만 보이고 있었다. 라벨을 "이미지 첨부"로 바꾼 단일
// 액션만 남긴 커스텀 ActionButton.
//
// 실제 강제(사용자가 API를 직접 호출하거나 우회해도 막히는 최종 방어선)는
// 서버 쪽 Stream 앱 설정(chat.js의 handleChatConfigureUploads, PATCH
// /app의 file_upload_config.allowed_mime_types를 이미지로 제한 —
// stream-chat SDK 소스를 직접 읽어 확인한 바, 업로드 차단 검증
// (getUploadConfigCheck)이 앱 설정만 참조하고 채널 타입 설정은 안 봄)이
// 담당한다. 여기서는 UX 개선 목적으로만 클라이언트 accept 힌트(브라우저
// 파일 선택 다이얼로그가 이미지만 보여주도록)를 추가로 설정한다 —
// messageComposer.attachmentManager.acceptedFiles는 기본값이 빈 배열
// (제한 없음)이라 직접 채워야 UploadButton.mjs가 만드는 <input accept>에
// 반영된다.
// 🔧 [사용자 지시, 2026-09-19] "+ 버튼을 이미지 아이콘으로 직관적으로
// 바꿔줘" — "+"(IconPlus)는 ComponentContext.icons 전역 슬롯이라 폴
// 옵션 추가 버튼(NumericInput)이나 이모지 반응 추가 버튼
// (ReactionSelector)에도 함께 쓰여, 거길 오버라이드하면 그쪽 아이콘까지
// 바뀐다. Stream이 "+" 버튼 전용으로 따로 마련해둔
// AttachmentSelectorInitiationButtonContents 슬롯(AttachmentSelector.mjs:
// 있으면 IconPlus 대신 이걸 렌더링)을 대신 오버라이드해 이 버튼에만
// 정확히 적용한다.
function ImagePlusButtonIcon() {
  return <ImagePlus className="str-chat__attachment-selector__menu-button__icon" strokeWidth={ICON_STROKE.default} />;
}

// 🔧 [버그 수정, 2026-09-20 사용자 지시: "가장 위에 메시지를 꾹 누르면
// 메뉴가 안보이는 영역에 생성 돼"] — MessageActions.mjs가 이 메시지
// 액션 메뉴에 넘기는 기본 placement는 "top-start"/"top-end"(메시지
// 위쪽에 뜨도록)이고, floating-ui의 flip 미들웨어가 공간이 부족하면
// 아래로 뒤집어주는 구조이긴 하다. 하지만 이 채팅 화면은 헤더를
// position:fixed로 얹어 실제 콘텐츠 시작 지점이 뷰포트 맨 위(0)가
// 아니라 그 아래(74px 등)인데, flip은 이 사실을 모르고 순수 뷰포트
// 좌표만 기준으로 "위쪽에 공간이 있다"고 판단해버린다(실측: 리스트
// 맨 위 근처 메시지를 꾹 누르면 메뉴가 헤더 뒤로 가려짐). 채팅 메시지
// 리스트는 항상 아래로 스크롤되는 구조라 아래쪽엔(최소한 입력창까지는)
// 항상 공간이 있으므로, 이 메뉴만큼은 애초에 top이 아니라 bottom을
// 기준으로 열리도록 ComponentContext.ContextMenu 슬롯에서 placement를
// 강제로 뒤집는다.
//
// 이 슬롯은 "+"(이미지 첨부) 메뉴에도 공유되는데(AttachmentSelector.mjs
// 확인), 그건 입력창 바로 위에서 열려 이미 위쪽 공간이 충분하고
// 강제로 아래로 뒤집으면 오히려 입력창을 가리게 된다 — className으로
// 메시지 액션 메뉴("str-chat__message-actions-box")일 때만 좁힌다.
function ChatActionsContextMenu(props: ContextMenuProps) {
  const isMessageActionsMenu =
    typeof props.className === "string" && props.className.includes("str-chat__message-actions-box");
  const placement = !isMessageActionsMenu
    ? props.placement
    : props.placement === "top-start"
      ? "bottom-start"
      : props.placement === "top-end"
        ? "bottom-end"
        : props.placement;
  return <ContextMenu {...props} placement={placement} />;
}

function ImageAttachmentAction() {
  const { IconAttachment } = useComponentContextIcons();
  const { fileInput } = useAttachmentSelectorContext();
  const { closeMenu } = useContextMenuContext();

  return (
    <ContextMenuButton
      className="str-chat__attachment-selector-actions-menu__button str-chat__attachment-selector-actions-menu__upload-file-button"
      Icon={IconAttachment}
      onClick={() => {
        fileInput?.click();
        closeMenu();
      }}
    >
      이미지 첨부
    </ContextMenuButton>
  );
}

function ImageOnlyAttachmentSelector() {
  const messageComposer = useMessageComposerController();
  // 🔧 [버그 수정] 액션 항목이 하나뿐이면 Stream이 메뉴를 열지 않고 클릭
  // 즉시 그 액션(fileInput.click())을 실행한다 — 이 설정을
  // ImageAttachmentAction(메뉴 항목, 조건부 마운트) 안의 useEffect에 뒀더니
  // "+' 버튼 클릭 → 즉시 액션 실행"이 같은 렌더 사이클에서 일어나
  // acceptedFiles 설정이 반영되기 전에 파일 선택창이 열려버렸다("+"
  // 버튼과 항상 함께 마운트되는 이 컴포넌트로 옮겨, 메뉴를 열기 전에
  // 이미 설정이 끝나 있도록 한다.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/immutability -- acceptedFiles는 stream-chat SDK 공식 setter
    messageComposer.attachmentManager.acceptedFiles = ["image/*"];
  }, [messageComposer]);

  return <AttachmentSelector attachmentSelectorActionSet={[{ ActionButton: ImageAttachmentAction, type: "uploadFile" }]} />;
}

// 🔧 [사용자 지시, 2026-09-19] "상대방 읽음 확인은 '1'의 사라짐으로" —
// 카카오톡 관례: 내가 보낸 메시지 옆에 상대가 아직 안 읽었으면 "1"이
// 붙어 있다가, 상대가 읽으면 사라진다. Stream 기본 MessageStatus는
// 체크마크 아이콘(전송/전달/읽음)으로 표시하는데, 이 앱은 1:1 DM만
// 쓰므로 readBy(이 메시지를 읽은 사용자 목록, 본인 제외)가 비어있으면
// "1"을 보여주고 채워지면 사라지는 방식으로 완전히 대체한다.
// 🔧 [버그 수정, 2026-09-19] 원래는 ComponentContext.MessageStatus 슬롯
// (Stream 기본 metadata 안)으로 렌더링했으나, 시간을 버블 옆에 직접
// 그리기 위해 metadata 전체를 display:none으로 숨기게 되면서(아래
// SwipeableMessage 참고) 이 배지도 함께 안 보이게 됐다. 훅으로 뽑아
// SwipeableMessage가 직접 호출해 우리가 그리는 시간 옆에 렌더링한다.
function useUnreadOneBadge() {
  const { isMyMessage, message, readBy } = useMessageContext();
  const { client } = useChatContext();
  // 🔧 [버그 수정] message.status가 "received"가 아닌 경우(막 전송해
  // 서버 확인 대기 중인 optimistic 상태 등)까지 조건에 넣으면, 방금 보낸
  // 메시지에는 "1"이 아예 안 붙었다가 다음 렌더링에야 나타나는 부자연
  // 스러운 깜빡임이 생긴다 — 카카오톡처럼 보낸 즉시 "1"이 붙어야 하므로
  // 실패(error)한 메시지만 제외한다.
  if (!isMyMessage() || message.type === "error") return false;
  // 🔧 [버그 수정] readBy에는 "이 메시지를 읽은 모든 사용자"가 들어있는데,
  // 채널을 열어놓고 있는 발신자 본인도 자동으로 markRead되어 포함된다
  // (Stream 기본 MessageStatus도 동일하게 client.user.id를 제외하는
  // 로직을 쓴다 — readersWithoutOwnUser). 이걸 빼지 않으면 상대가 전혀
  // 읽지 않았어도 본인이 채널을 보고 있다는 이유만으로 "1"이 즉시
  // 사라지는 오동작이 생긴다.
  const readByOthers = (readBy ?? []).some((user) => user.id !== client.user?.id);
  return !readByOthers;
}

// 🔧 [사용자 지시, 2026-09-19] "카카오톡처럼 메시지를 좌측으로 당기면
// 답장하기" — Stream Chat 자체는 답장(quote reply) 기능과
// messageComposer.setQuotedMessage(message) API는 이미 갖고 있지만
// (MessageActions의 "인용 답장" 메뉴가 내부적으로 이걸 쓴다), 스와이프
// 제스처 UI는 없다. ComponentContext.Message 슬롯을 이 래퍼로 교체해,
// 메시지 버블을 pointer 드래그로 왼쪽으로 당기면(임계값 40px) 살짝
// 밀리는 시각적 피드백과 함께 답장 아이콘이 나타나고, 손을 떼는 순간
// 임계값을 넘었으면 해당 메시지를 인용 답장으로 설정한다. 실제 메시지
// 렌더링(내용/아바타/시간 등)은 Stream 기본 MessageUI를 그대로 감싸서
// 재사용한다 — 버블 UI 자체를 새로 만들 필요는 없다.
// 🔧 [버그 수정, 2026-09-20 사용자 지시: "현재 상대방 메시지에 상대방의
// 아이콘만 보이는 상황이잖아? 카카오톡처럼 아이콘과 이름을 출력하도록
// 해줘" → (구현 후) "네가 구현한건 너무 균형이 안맞잖아 ... 아이콘,
// 이름, 메시지 요소가 다 따로 노는 것 같아"] — 처음엔 Stream이 그리는
// 아바타(MessageUI 내부, grid의 avatar 영역, align-self: end)는 그대로
// 두고 이름만 position:absolute로 옆에 끼워 넣었는데, Stream의 grid
// 자체 높이는 이름의 존재를 전혀 모르므로(이름이 grid 밖 오버레이라
// 높이 계산에 기여하지 않음) 아바타가 항상 "버블 높이" 기준으로만
// 정렬돼 이름과 나란해질 수 없는 구조적 한계가 있었다(실측: align-self
// 를 start로 바꿔도 grid 높이 자체가 안 늘어나 아바타가 여전히 버블과
// 같은 위치). Stream이 그리는 아바타를 완전히 숨기고(.str-chat__message
// .str-chat__avatar { display: none }, chat-theme.css), 이 wrapper가
// [아바타, {이름 위/버블 아래}] 레이아웃을 처음부터 직접 구성한다 —
// 그러면 아바타와 이름이 모두 우리가 만든 같은 flex row의 자연스러운
// 정렬 규칙을 따르므로 항상 정확히 나란하다.
function useSenderNameToShow(): string | null {
  const { message, isMyMessage, groupStyles } = useMessageContext();
  const { processedMessages } = useMessageListContext();
  // 🔧 [버그 수정] 이 Stream 버전의 MessageContext는 firstOfGroup/
  // endOfGroup/groupedByUser를 채우지 않는다(실측: 항상 undefined) —
  // 대신 groupStyles(문자열 배열, 예: ["single"]/["top"]/["middle"]/
  // ["bottom"])로 그룹 내 위치를 나타낸다. "top"(그룹 첫 메시지) 또는
  // "single"(그룹에 메시지가 하나뿐)일 때만 그룹의 시작이므로, 이때만
  // 이름을 보여준다(카카오톡처럼 같은 사람이 연속으로 보낸 메시지
  // 그룹에서는 첫 메시지에만 표시).
  let isGroupStart = groupStyles?.includes("top") || groupStyles?.includes("single");
  // 🔧 [버그 수정, 2026-09-20 사용자 지시: "전송 시각이 다른 경우엔
  // 아바타랑 이름이 붙어야 하는데... 분 단위가 분명히 다른데 안뜨는
  // 메시지들이 있어"] — Stream의 groupStyles는 오직 "같은 발신자가
  // 연속으로 보냈는가"만 보고 "middle"/"bottom"을 매기며, 그 사이
  // 시간이 몇 분이 지났든 전혀 고려하지 않는다(Stream 자체에 이 기준을
  // 넣는 옵션이 없음, 실측: 16분 간격에도 groupStyles가 계속 "middle").
  // 카카오톡 등 참고 기준대로 "직전 메시지와 분 단위가 다르면(다른
  // 발신자 그룹처럼) 새로 아바타/이름을 보여준다"를 여기서 직접
  // 보정한다 — processedMessages에서 바로 이전 메시지를 찾아 생성
  // 시각의 분이 다르면 groupStyles 값과 무관하게 그룹 시작으로 취급.
  if (!isGroupStart) {
    const idx = processedMessages.findIndex((m) => m.id === message.id);
    const prevMessage = idx > 0 ? processedMessages[idx - 1] : undefined;
    const prevCreatedAt = prevMessage && "created_at" in prevMessage ? prevMessage.created_at : undefined;
    const prevDate = prevCreatedAt ? new Date(prevCreatedAt) : null;
    const thisDate = message.created_at ? new Date(message.created_at) : null;
    if (prevDate && thisDate && (prevDate.getMinutes() !== thisDate.getMinutes() || prevDate.getHours() !== thisDate.getHours() || prevDate.toDateString() !== thisDate.toDateString())) {
      isGroupStart = true;
    }
  }
  if (isMyMessage() || !isGroupStart) return null;
  return message.user?.name || message.user?.id || null;
}

function SwipeableMessage() {
  const { message, isMyMessage, handleReaction } = useMessageContext();
  const messageComposer = useMessageComposerController();
  const { jumpToMessage } = useChannelActionContext();
  const { processedMessages } = useMessageListContext();
  const showUnreadOne = useUnreadOneBadge();
  const senderName = useSenderNameToShow();
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef<number | null>(null);
  const SWIPE_THRESHOLD = 40;
  const MAX_DRAG = 64;
  // 🔧 [사용자 지시, 2026-09-24] "PC 화면에서는 메시지에 마우스 오버를
  // 하면 표정을 남기는 버튼을 띄워줘" — hover의 "반응 추가" 버튼을
  // 눌렀을 때 Stream 드롭다운 메뉴 안의 이모지 선택기(dropdown-react-
  // action → ReactionSelector, floating-ui 다이얼로그)를 자동 클릭으로
  // 대신 열어보려 했으나, 그 다이얼로그가 실제 마우스 클릭에만 반응하고
  // 프로그래매틱 클릭(el.click(), 완전한 pointerdown~click 이벤트
  // 시퀀스를 직접 디스패치해도 isTrusted:false)에는 반응하지 않음을
  // 실측으로 확인했다(반면 "답장"은 평범한 onClick이라 문제없이 동작).
  // 그 다이얼로그를 억지로 열려 하는 대신, 이 컴포넌트가 직접 작은
  // 이모지 팝오버를 그려 Stream이 이미 제공하는 handleReaction(message
  // context)을 호출한다 — 우리 버튼의 onClick 자체가 진짜 트러스티드
  // 클릭이라 이 경로는 문제가 생기지 않는다.
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  const messageWrapperRef = useRef<HTMLDivElement | null>(null);
  const QUICK_REACTIONS: { type: string; emoji: string; label: string }[] = [
    { type: "haha", emoji: "😂", label: "Joy" },
    { type: "like", emoji: "👍", label: "Thumbs up" },
    { type: "love", emoji: "❤️", label: "Heart" },
    { type: "sad", emoji: "😔", label: "Sad" },
    { type: "wow", emoji: "😮", label: "Astonished" },
    { type: "fire", emoji: "🔥", label: "Fire" },
  ];

  useEffect(() => {
    if (!showReactionPicker) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (!messageWrapperRef.current?.contains(e.target as Node)) setShowReactionPicker(false);
    };
    document.addEventListener("click", handleOutsideClick, true);
    return () => document.removeEventListener("click", handleOutsideClick, true);
  }, [showReactionPicker]);

  // 🔧 [버그 수정, 2026-09-19 사용자 지시: "가까운 메시지는 1번 이동으론
  // 발동이 안 되고 2번부터는 잘 됨. 먼 메시지는 여러 번 눌러도 확인이
  // 안 됨"] — 이전 구현은 Stream의 useMessageContext().highlighted
  // (boolean)를 useEffect 의존성으로 썼는데, 같은 메시지를 연속으로
  // 인용 클릭하면 값 자체는 true→true로 안 바뀌어(React가 값 동일성
  // 으로 판단) effect가 재실행되지 않았다. 흔들림 트리거는 이제
  // ChatQuotedMessage(ComponentContext.QuotedMessage 슬롯, 아래 정의)
  // 가 클릭 시 imperative하게(DOM 클래스 직접 토글) 담당한다 — React
  // state 동일성 문제 자체가 없어져 몇 번을 연속으로 클릭해도 항상
  // 재생된다. 아래 최상위 div의 data-shake-target 속성이 그 트리거의
  // querySelector 대상이 된다.

  // 🔧 [사용자 지시] "같은 시각(분)에 전송된 메시지가 여러 개면 그 중
  // 마지막에만 시간 표시" — 다음 메시지가 존재하고 그 메시지가 이
  // 메시지와 같은 분에 생성됐다면(발신자와 무관하게, 사용자 지시 그대로)
  // 이 메시지의 시간은 숨긴다. 날짜 구분선/스레드 알림 등 실제 채팅
  // 메시지가 아닌 항목은 created_at이 없어 자연히 다음 메시지 취급을
  // 건너뛰지 않는다(둘 다 유효한 Date일 때만 비교).
  const messageIndex = processedMessages.findIndex((m) => m.id === message.id);
  const nextMessage = messageIndex >= 0 ? processedMessages[messageIndex + 1] : undefined;
  const nextCreatedAtRaw = nextMessage && "created_at" in nextMessage ? nextMessage.created_at : undefined;
  const thisCreatedAt = message.created_at ? new Date(message.created_at) : null;
  const nextCreatedAt = nextCreatedAtRaw ? new Date(nextCreatedAtRaw) : null;
  const showTimestamp = !(thisCreatedAt && nextCreatedAt && isSameMinute(thisCreatedAt, nextCreatedAt));

  // 🔧 [사용자 지시, 2026-09-19] "이미지에서도 클릭(확대)과 스와이프
  // (답장) 둘 다 되게 해달라 — 이동량이 작으면 클릭, 크면 스와이프" —
  // 인용 카드나 이미지 확대 버튼처럼 Stream이 이미 자체 onClick을 건
  // 인터랙티브 요소를 pointerdown 시점에 통째로 예외 처리(closest로
  // 걸러 드래그 자체를 시작 안 함)하면, 그 요소 위에서는 스와이프
  // 답장이 영영 불가능해진다(이미지 전체가 <button>이라 사실상 이미지
  // 위 스와이프 자체가 막힘). 반대로 예외 처리를 안 하면, 실제 마우스
  // 클릭 중 손이 미세하게(1~3px) 떨려 발생하는 pointermove가
  // setPointerCapture로 캡처된 이 wrapper를 "드래그 중"으로 확정시켜
  // 버려 뒤이은 click 합성 이벤트가 억제된다(자동화된 pointer 이벤트는
  // 정확히 같은 좌표만 재현해 이 떨림이 없어 재현 안 됐지만, 실제 마우스
  // 클릭으로는 인용 카드·이미지 모두 동일하게 재현됨을 확인). 그래서
  // pointerdown은 항상 시작하되(캡처도 항상 검), pointerup 시점에
  // 실제 이동 거리가 데드존 이하였다면 우리가 직접 click을 원래
  // 타겟(버튼 등)에 합성 발생시켜 Stream의 onClick이 정상 실행되게
  // 만든다 — 이동 거리가 크면(의도한 스와이프) 기존처럼 답장 처리만
  // 하고 클릭은 합성하지 않는다.
  const MOVE_DEAD_ZONE = 5;
  const pointerDownTargetRef = useRef<HTMLElement | null>(null);
  const pointerDownPosRef = useRef<{ x: number; y: number } | null>(null);
  // 🔧 [버그 수정, 2026-09-20] endDrag가 유령 재실행(지연된
  // lostpointercapture 등)으로 잘못 다시 호출되는 것을 막기 위한 가드 —
  // 자세한 경위는 endDrag 안의 주석 참고. handlePointerDown이 실제로
  // 드래그를 시작할 때만 그 pointerId를 기록하고, endDrag가 정상
  // 종료되는 순간 즉시 null로 되돌린다.
  const activePointerIdRef = useRef<number | null>(null);
  // 🔧 [사용자 지시, 2026-09-19] "메시지를 꾹 눌러서 수정/삭제/반응(꾹
  // 눌러서 여는 컨텍스트 메뉴)" — Stream은 이미 편집/삭제/리액션 전체
  // 기능을 갖춘 MessageActions 메뉴를 내장하고 있다(실측 확인: "메시지
  // 수정"/"메시지 삭제"/"반응 추가" 등 전부 이미 존재). 유일하게 없던
  // 것은 그 메뉴를 여는 카카오톡식 롱프레스 트리거뿐이라, 새로 만들지
  // 않고 이미 각 메시지에 렌더링된 "..." 토글 버튼
  // ([data-testid="message-actions-toggle-button"])을 꾹 눌렀을 때
  // 대신 클릭해주는 방식으로 구현한다. 길게 누르는 동안 스와이프가
  // 함께 시작되면 어색하므로(예: 손이 살짝 떨려도 롱프레스가 씹히지
  // 않도록), 타이머는 pointerdown 즉시 시작하되 데드존을 넘는 이동이
  // 생기면(=스와이프 의도로 판정) 즉시 취소한다.
  const LONG_PRESS_MS = 450;
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);

  function clearLongPressTimer() {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // 텍스트 선택/버튼 클릭 등 일반 상호작용을 방해하지 않도록, 주 버튼
    // (마우스 좌클릭 또는 터치)만 드래그 시작으로 인정한다.
    if (e.button !== 0 && e.pointerType === "mouse") return;
    // 🔧 [버그 수정, 2026-09-19 사용자 지시: "모바일에선 여전히 이미지가
    // 열리거나 답장 원본 메시지로 이동해버린다" → "꾹 눌러서 메뉴를
    // 띄웠을 때, 이미지 영역을 터치해서 취소하려고 하면 이미지가
    // 열려버린다"] — document/wrapper capture 리스너로 click을
    // stopPropagation하는 방식은 실측 결과 실패했다(Stream의
    // DialogPortal.mjs가 document에 직접 건 캡처 리스너가 실제로는
    // 우리보다 먼저 등록돼 있어 늦었고, preventDefault는 이미 등록된
    // 다른 리스너의 실행 자체를 막지 못한다 — 브라우저 이벤트 스펙).
    // 등록 순서 경쟁에 의존하지 않는 유일한 확실한 방법은 애초에
    // 브라우저가 click DOM 이벤트 자체를 만들지 않게 하는 것 — 이는
    // 원본 TouchEvent(React의 PointerEvent가 아님)의 preventDefault()
    // 만 보장한다(W3C 스펙: touchend의 preventDefault는 그로부터
    // 파생되는 click 생성 자체를 억제). 이 요소에 네이티브 touchend
    // 리스너를 캡처 단계로 걸어 다음 touchend 하나만 확실히 삼킨다.
    //
    // 🔧 [버그 수정, 2026-09-20] 액션 메뉴(ContextMenuButton)는 DOM상
    // document.body 근처의 별도 portal에 렌더링되어 이 wrapper의
    // 실제 자손이 아니지만, React는 이벤트를 DOM 트리가 아니라 React
    // 엘리먼트 트리를 따라 위임한다(portal이어도 React 트리상으로는
    // 이 메시지의 자손이라 발생). 그 결과 "메뉴 안의 버튼(예: 인용
    // 답장, 반응 추가)"을 누른 pointerdown이 실제 DOM 조상은 전혀
    // 거치지 않고도 이 이미지 메시지 wrapper의 onPointerDown까지
    // 올라온다. e.target이 실제로 이 DOM 요소(e.currentTarget) 내부에
    // 있을 때만 "이 wrapper를 눌렀다"고 인정하고, 아닌 경우(메뉴
    // 버튼을 누른 것이 React 트리를 통해 위임된 경우)는 이 wrapper와
    // 전혀 무관한 이벤트이므로 아래로 흘려보내지 않고 완전히
    // 무시한다.
    //
    // 🔧 [버그 수정, 2026-09-20 사용자 재보고: "'반응 추가'를 눌러도
    // 팝업 메뉴 뒤의 이미지 메시지가 눌려서 이미지 크게 보기가
    // 돼버려"] — 처음엔 이 분기를 "메뉴가 열린 상태 + 이 wrapper
    // 내부를 눌렀을 때"로만 좁히고, 조건이 거짓이면(=위임된 pointerdown)
    // 그대로 아래 "새 드래그 시작" 로직(479행~)으로 흘려보냈다. 그
    // 결과 이 이미지와 무관한 메뉴 버튼 터치인데도 이 wrapper에
    // setPointerCapture가 걸리고 activePointerIdRef까지 갱신되어
    // (실측: gotpointercapture의 target이 엉뚱하게 이 wrapper로 찍힘),
    // 곧이어 오는 pointerup/lostpointercapture가 "클릭이었다" 분기로
    // 빠져 pointerDownTargetRef(이 이미지 자신)를 다시 click()해버렸다.
    // 메뉴가 열려 있는 동안 이 wrapper의 실제 DOM 밖에서 위임되어 온
    // pointerdown은 이 wrapper 입장에서 처리할 이벤트가 전혀 아니므로,
    // 아래로 흘려보내지 않고 여기서 완전히 return해야 한다.
    if (document.querySelector(".str-chat__message-actions-box--open")) {
      if (!e.currentTarget.contains(e.target as Node)) {
        return;
      }
      e.preventDefault();
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      e.currentTarget.addEventListener(
        "touchend",
        (touchEvent: Event) => {
          touchEvent.preventDefault();
        },
        { capture: true, once: true, passive: false }
      );
      return;
    }
    // 🔧 [버그 수정, 2026-09-22 사용자 지시: "'나에게 답장' 처럼 답장
    // 메시지 포함된 버블은 답장 영역만이 아니라 버블 전체를 누르면 이동
    // 이벤트가 발생하게 해줘 ... ㅇㅇ 쪽을 터치하면 이동이 안되는 것
    // 같거든"] — 원래 "click" in target 검사는 모든 Element(텍스트의
    // <p>조차)가 참이라(HTMLElement는 전부 click 메서드를 가짐), 실제로는
    // 아무 onClick도 없는 순수 텍스트를 눌러도 이 텍스트 자신에게
    // click()을 합성해버렸다 — 실측 확인: "ㅇㅇ" 텍스트를 클릭하면
    // pointerDownTargetRef.current가 그 <p> 요소 자체가 되어, 아래
    // "이 메시지가 답장이면 원본으로 이동" 분기(도달 불가)보다 먼저
    // "클릭 가능 요소를 눌렀다" 분기가 걸려 그 <p>에 무의미한 click()만
    // 합성되고 끝났다(원본 elseif가 && pointerDownTargetRef.current로
    // 분기하므로). 이 로직의 실제 의도(SVG 아이콘 위를 눌러도 Stream이
    // onClick을 건 실제 버튼/링크까지 안전하게 찾기)에 맞게, 버튼/링크/
    // role=button 요소이거나 그 자손일 때만 잡는다 — 순수 텍스트/이미지
    // 등은 이제 null로 남아 아래 "버블 전체 클릭 시 답장 원본으로 이동"
    // 분기가 정상적으로 실행된다.
    const target = e.target as Element;
    pointerDownTargetRef.current = target.closest<HTMLElement>("button, a, [role='button']");
    pointerDownPosRef.current = { x: e.clientX, y: e.clientY };
    activePointerIdRef.current = e.pointerId;
    // 🔧 [버그 수정, PC 브라우저] 왼쪽으로 당기면 버블 자체가 translateX로
    // 밀려나므로, capture 없이는 커서가 금방 버블 바깥으로 벗어나
    // 이후의 pointermove/pointerup을 이 요소가 받지 못했다. 그 결과
    // startXRef가 리셋되지 않은 채 남아, 이후 이 요소 위로 마우스를
    // 지나가기만 해도(버튼을 누르지 않아도) 마지막 pointermove 좌표
    // 기준으로 다시 반응해 버블이 계속 좌우로 흔들리는 것처럼 보였다.
    // setPointerCapture로 이후 모든 pointer 이벤트를 커서 위치와 무관
    // 하게 이 요소가 계속 받도록 고정해 해결한다. 브라우저가 이미 그
    // 포인터를 해제한 극단적 타이밍(예: 매우 빠른 연속 탭)에는
    // NotFoundError를 던질 수 있는데, 이 실패는 드래그 자체를 막을
    // 이유가 아니므로 무시한다.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // no-op
    }
    startXRef.current = e.clientX;
    setDragging(true);

    longPressFiredRef.current = false;
    const wrapperEl = e.currentTarget;
    clearLongPressTimer();
    // 🔧 [버그 수정, 2026-09-20 사용자 지시: "어중간한 위치에서 꾹
    // 누르면 이런 식으로 떠"] — 이 wrapper(onPointerDown이 걸린 최상위
    // div)는 아바타/이름/시간까지 포함한 메시지 행 전체를 감싸므로,
    // 그 사이 여백(어중간한 위치)을 눌러도 롱프레스 타이머가 그대로
    // 등록돼 메뉴가 떴다. 처음엔 .str-chat__message-bubble 안인지만
    // 확인했는데, 인용 답장+사진처럼 여러 콘텐츠가 한 버블 안에 세로로
    // 쌓인 경우(Stream 소스 확인: QuotedMessage와 Attachment가 같은
    // MessageBubble의 형제로 렌더링됨) 그 사이 빈 여백도 여전히 버블
    // "안"이라 인정되어 재발했다(사용자 재보고: "삭제된 메시지 아래
    // 메시지에 대고 한거야" — 인용 카드와 사진 사이 여백). 실제 콘텐츠
    // 요소(텍스트, 첨부 이미지/파일, 인용 카드) 위일 때만 인정한다.
    // 🔧 [버그 수정, 2026-09-22 사용자 지시: "이미지 메시지 버블에 대고
    // 마우스 우클릭 하면 팝업 메뉴가 뜨질 않아"] — 이 셀렉터가 처음부터
    // 잘못된 클래스명을 쓰고 있었다. stream-chat-react의
    // AttachmentContainer.mjs 소스와 실제 DOM 실측(Playwright로 이미지
    // 조상 체인 직접 추적) 둘 다로 확인: 모든 첨부(이미지/파일/카드
    // 등)에 항상 붙는 공용 클래스는 "str-chat__message-attachment"이고,
    // ".str-chat__attachment"(끝에 "message-" 없음)는 카드/Giphy에
    // 액션 버튼이 있을 때만 붙는 완전히 다른 내부 wrapper라 이미지
    // 메시지에는 애초에 존재하지 않는다 — 이 조건이 이미지를 절대
    // 매칭할 수 없어 롱프레스도, 우클릭(아래 handleContextMenu의 동일
    // 조건)도 이미지 메시지에서는 처음부터 한 번도 동작한 적이 없었다.
    if (
      !target.closest(
        ".str-chat__message-text, .str-chat__message-attachment, .str-chat__quoted-message-preview"
      )
    )
      return;
    longPressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      openMessageActionsMenu(wrapperEl);
      // 🔧 [버그 수정, 2026-09-19 사용자 지시: "꾹 눌러서 메뉴를 띄웠을
      // 때, 이미지 영역을 터치해서 취소하려고 하면 이미지가 열려버린다"]
      // — 실측(CDP 실제 터치 이벤트)해보니 문제는 "메뉴를 취소하려는
      // 두 번째 터치"가 아니라 롱프레스로 메뉴를 "여는" 바로 이 첫
      // 번째 터치 자체였다: 타이머가 발동해 메뉴를 연 뒤 손가락을
      // 떼면, 브라우저가 이 터치를 이어서 이미지 위에 진짜 click을
      // 발생시켜 확대 모달이 열리고, 그 IMG 클릭이 Stream의 document
      // 캡처 리스너("바깥 클릭 시 다이얼로그 닫기", DialogPortal.mjs)
      // 까지 트리거해 메뉴도 함께 닫혔다.
      //
      // document에 우리 리스너를 먼저 등록해 stopPropagation으로
      // Stream의 리스너 실행 자체를 막으려는 시도(blockNextClick +
      // ChatPage의 전역 capture 리스너)는 실측 결과 실패했다 —
      // preventDefault는 클릭의 "기본 동작"만 막을 뿐 이미 등록된 다른
      // 리스너의 실행 자체는 막지 못하고(브라우저 이벤트 스펙), Stream
      // 리스너가 실제로는 우리보다 먼저 등록되어 있어(실측: 이벤트
      // 리스너 등록 로그로 확인) stopPropagation도 늦었다. 등록 순서
      // 경쟁에 의존하지 않는 유일한 확실한 방법은 애초에 브라우저가
      // click DOM 이벤트 자체를 만들지 않게 하는 것 — 이는 원본
      // TouchEvent(React의 PointerEvent가 아님)의 preventDefault()만
      // 보장한다(W3C 터치 이벤트 스펙: touchend에서 preventDefault를
      // 부르면 그로부터 파생되는 마우스/클릭 이벤트가 생성되지 않음).
      // 이 wrapperEl에 네이티브 touchend 리스너를 캡처 단계로 걸어
      // 다음 touchend 하나만 확실히 삼킨다(리스너는 { once: true }로
      // 자동 정리).
      wrapperEl.addEventListener(
        "touchend",
        (touchEvent: Event) => {
          touchEvent.preventDefault();
        },
        { capture: true, once: true, passive: false }
      );
    }, LONG_PRESS_MS);
  }

  // 🔧 [사용자 지시, 2026-09-19] "PC에서는 마우스 우클릭으로 해당
  // 메뉴가 뜨도록" — 롱프레스(모바일)와 우클릭(PC) 둘 다 같은 액션
  // 메뉴를 열어야 하므로, 토글 버튼을 찾아 클릭하는 로직을 공용
  // 함수로 뽑아 재사용한다.
  // 🔧 [사용자 지시, 2026-09-24] "PC 화면에서는 메시지에 마우스 오버를
  // 하면 표정을 남기는 버튼, 답장을 하는 버튼을 띄워줘" — 새로 만든
  // hover 오버레이(아래 SwipeableMessage 렌더 부분)의 두 버튼이 각각
  // "반응 추가"/"답장" 항목을 자동으로 클릭해 곧장 그 액션까지
  // 실행되게 한다. 이 두 액션 모두 이미 검증된 openMessageActionsMenu
  // 인프라(위치 계산, 레이아웃 흔들림 방지) 위에서 열리는 드롭다운
  // 메뉴 안에 존재하므로, 새 메뉴 UI를 따로 만들 필요 없이 메뉴를 열고
  // 해당 항목을 프로그래밍적으로 클릭하는 것만으로 충분하다.
  function triggerMessageAction(wrapperEl: HTMLElement, actionSelector: string) {
    openMessageActionsMenu(wrapperEl);
    // 🔧 [버그 수정] openMessageActionsMenu 내부에서도 toggleBtn.click()
    // 직후 requestAnimationFrame으로 항목 정리(thread-action 제거 등)를
    // 하는데, 그 항목 정리가 실행되기도 전에(같은 프레임의 RAF 콜백은
    // 등록 순서대로 실행되지만, Stream의 ContextMenu 다이얼로그 자체가
    // --open 클래스를 실제로 붙이는 시점은 React 렌더 커밋 이후라 1개의
    // RAF로는 아직 늦을 수 있음 — 실측: 자동 클릭이 씹혀 메뉴만 열린
    // 채로 남았다) 이 자동 클릭 시도가 실행되면 실패한다. MutationObserver로
    // 박스가 실제로 열리는 시점을 직접 기다린 뒤 클릭한다.
    // 🔧 [버그 수정] target.click()(순수 DOM 메서드, click 이벤트 1개만
    // 발생)으로는 이 버튼이 반응하지 않았다(실측: 실제 마우스 클릭은
    // 정상 동작하는데 .click()만 메뉴가 그대로 남아있었음) — Stream의
    // 반응 선택기 다이얼로그(floating-ui 기반)가 pointerdown 등 실제
    // 클릭 제스처의 앞선 이벤트에 반응하는 것으로 보인다. 실제 클릭이
    // 발생시키는 이벤트 시퀀스(pointerdown → mousedown → pointerup →
    // mouseup → click)를 그대로 재현한다.
    const dispatchRealClick = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const point = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      const opts = { bubbles: true, cancelable: true, view: window, ...point };
      el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerId: 1, isPrimary: true }));
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerId: 1, isPrimary: true }));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.dispatchEvent(new MouseEvent("click", opts));
    };
    const tryClick = () => {
      const box = document.querySelector<HTMLElement>(".str-chat__message-actions-box--open");
      const target = box?.querySelector<HTMLButtonElement>(actionSelector);
      if (target) {
        dispatchRealClick(target);
        return true;
      }
      return false;
    };
    if (tryClick()) return;
    const observer = new MutationObserver(() => {
      if (tryClick()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // 메뉴가 끝내 안 열리는 예외 상황(다른 메뉴가 이미 열려 있는 등)에
    // 옵저버가 무한정 남지 않도록 안전장치로 짧게 후 정리한다.
    setTimeout(() => observer.disconnect(), 2000);
  }

  function openMessageActionsMenu(wrapperEl: HTMLElement) {
    const toggleBtn = wrapperEl.querySelector<HTMLButtonElement>('[data-testid="message-actions-toggle-button"]');
    const optionsEl = wrapperEl.querySelector<HTMLElement>(".str-chat__message-options");
    const innerEl = wrapperEl.querySelector<HTMLElement>(".str-chat__message-inner");
    if (!toggleBtn || !optionsEl || !innerEl) return;
    // 🔧 [버그 수정, 2026-09-19 사용자 지시: "롱프레스 할 때 좌측
    // 모서리에 떠버리면 어떡함"] — 이 토글 버튼을 담은
    // .str-chat__message-options는 기본 display:none이고
    // :hover/:focus-within/(다이얼로그가 열려 React가 붙이는 --active
    // 클래스)일 때만 flex가 된다. display:none 요소는 focus()조차
    // 받을 수 없어(브라우저 스펙) focus 우회는 실패했고(실측:
    // activeElement 그대로, getBoundingClientRect는 계속 0×0), 클래스만
    // 미리 붙이는 방법도 실패했다 — Stream CSS에 더 구체적인 규칙
    // (`.str-chat__message .str-chat__message-inner .str-chat__message-
    // options { display: none; }`)이 있어 :has() 기반 규칙과
    // specificity가 부딪혀 여전히 안 보이는 상태로 남았다(computed
    // style로 실측 확인). display:none인 요소는 크기가 0이라, Stream이
    // 메뉴 위치 계산에 쓰는 참조 요소 크기가 0이 되어 fallback 좌표
    // (실측: left/top 8px, 화면 좌상단)로 메뉴가 떴다. 인라인
    // !important로 확실히 이기게 만든다(실측 확인) — 이건 React가
    // 관리하지 않는 우리 쪽 스타일이라, 메뉴가 닫힐 때(Stream이
    // .str-chat__message-actions-box--open을 제거하는 시점을
    // MutationObserver로 감지) 우리가 직접 지워야 한다.
    optionsEl.style.setProperty("display", "flex", "important");
    const quickActionsToHide = optionsEl.querySelectorAll<HTMLElement>(
      '[data-testid="thread-action"], [data-testid="message-reaction-action"]'
    );
    quickActionsToHide.forEach((el) => el.style.setProperty("display", "none", "important"));
    // 🔧 [버그 수정] Stream의 DialogAnchor(useDialogAnchor)는 다이얼로그가
    // 열릴 때 참조 요소(referenceElement, 곧 이 toggleBtn)를 "얼려서"
    // 위치 계산에 쓰는데, 그 값을 실제로 재는(getBoundingClientRect)
    // 시점이 useEffect(커밋 이후 비동기) 안이라 우리가 click() 직후
    // 동기적으로건 setTimeout(0)이건 DOM class 변화 감지든 그 update()
    // 호출 전에 display:none을 걸면 여전히 0×0으로 fallback했다(실측:
    // 셋 다 좌상단 8,8). 대신 display는 그대로 두고 폭/높이/패딩만
    // 0으로 줄인다 — getBoundingClientRect가 0×0이 아닌 유효한 위치
    // (폭 0)를 반환해 언제 적용해도 메뉴 위치 계산이 깨지지 않는다.
    // 🔧 [버그 수정, 2026-09-19 사용자 지시: "왜 줄어드는거임?" →
    // "저 버튼을 없애버리면 되는거 아니야?" → "그 버튼도 숨기라고.
    // 자꾸 메시지가 옆으로 가버리잖아"] — .str-chat__message-inner의
    // 옵션 열(auto) 폭은 .str-chat__message-options "자기 자신"에
    // 고정된 `width: var(--str-chat-message-options-size)`(=96px,
    // 소스 확인: 자식 3개를 다 숨겨도 컨테이너 자체 width가 그대로라
    // grid-template-columns가 계속 "96px ..."로 잡혔다 — 실측)에서
    // 나온다. optionsEl 자신의 width도 0으로 강제해야 하는데, 이걸
    // click() 이전에 하면 toggleBtn(이 컨테이너의 자식)의 위치 계산
    // 자체가 0폭 컨테이너 기준이 되어버리므로, toggleBtn과 마찬가지로
    // click() 이후로 미룬다.
    const shrinkOptionsAndToggle = () => {
      optionsEl.style.setProperty("width", "0", "important");
      toggleBtn.style.setProperty("width", "0", "important");
      toggleBtn.style.setProperty("height", "0", "important");
      toggleBtn.style.setProperty("padding", "0", "important");
      toggleBtn.style.setProperty("border", "0", "important");
      toggleBtn.style.setProperty("min-width", "0", "important");
      toggleBtn.style.setProperty("overflow", "hidden", "important");
    };
    const cleanupObserver = new MutationObserver(() => {
      if (!document.querySelector(".str-chat__message-actions-box--open")) {
        optionsEl.style.removeProperty("display");
        optionsEl.style.removeProperty("width");
        quickActionsToHide.forEach((el) => el.style.removeProperty("display"));
        toggleBtn.style.removeProperty("width");
        toggleBtn.style.removeProperty("height");
        toggleBtn.style.removeProperty("padding");
        toggleBtn.style.removeProperty("border");
        toggleBtn.style.removeProperty("min-width");
        toggleBtn.style.removeProperty("overflow");
        cleanupObserver.disconnect();
      }
    });
    cleanupObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    // display:none → flex로 막 바뀐 직후 곧바로 getBoundingClientRect를
    // 쓰는 코드가 이어지면 브라우저가 아직 레이아웃을 재계산(flush)하지
    // 않았을 수 있어, 실제로 한 번 읽어 강제로 레이아웃을 확정시킨 뒤에
    // 클릭한다(레이아웃 스래싱을 의도적으로 1회 강제).
    void toggleBtn.getBoundingClientRect();
    toggleBtn.click();
    shrinkOptionsAndToggle();
    // 🔧 [버그 수정, 2026-09-20 사용자 지시: "메시지 보내기 영역
    // 아래로는 메뉴가 뚫고 내려가지 않도록"] — 이 메뉴는
    // ChatActionsContextMenu에서 placement를 강제로 bottom-start/
    // bottom-end로 뒤집는데(위쪽에서 열리면 헤더 뒤로 가려지는 문제
    // 수정), floating-ui의 flip은 기본적으로 뷰포트 전체를 경계로
    // 계산해 "아래쪽에 얼마나 남았는지"만 볼 뿐, 우리 채팅 입력창이
    // 그 훨씬 위에서 화면을 사실상 가로막고 있다는 사실은 몰라
    // 입력창 아래(심지어 화면 밖)까지 메뉴가 뚫고 내려가는 경우가
    // 있었다. floating-ui가 위치를 다 정한 뒤(다음 프레임) 실제 렌더된
    // 위치를 직접 읽어, 입력창 상단을 넘으면 그만큼 위로 강제 보정한다.
    requestAnimationFrame(() => {
      const box = document.querySelector<HTMLElement>(".str-chat__message-actions-box--open");
      if (!box) return;
      // 🔧 [버그 수정, 2026-09-23 사용자 지시: "꾹 눌렀을 때 뜨는 메뉴에서
      // '스레드 답장'은 제거해줘"] — 위에서 이미 quickActionsToHide로
      // thread-action을 숨겼지만, 그건 메시지 옆 빠른 아이콘 줄
      // (.str-chat__message-options)에 있는 것뿐이었다. 우클릭/롱프레스로
      // 열리는 이 전체 드롭다운 메뉴(.str-chat__message-actions-box) 안의
      // "스레드 답장" 항목은 완전히 다른 DOM 위치(box 내부
      // .str-chat__context-menu__body의 자식)라 전혀 숨겨지지 않고 있었다
      // (실측: 우클릭 메뉴에 "스레드 답장"이 그대로 보임). 이 앱은 스레드
      // 기능 자체를 쓰지 않기로 한 결정(빠른 아이콘 줄 숨김 코드의 기존
      // 의도)이므로, 드롭다운 쪽도 같은 testid로 찾아 완전히 제거한다 —
      // display:none이 아니라 DOM에서 아예 remove()하는 이유는, 남겨두면
      // 메뉴 항목 사이에 그 자리만큼 빈 여백이 생기기 때문이다(다른
      // display:none 항목들은 위치 계산용으로 남겨둬야 했던 toggleBtn과
      // 달리, 이건 목록 항목이라 완전히 제거해도 레이아웃에 문제가 없다).
      box.querySelector('[data-testid="thread-action"]')?.remove();
      // 🔧 [버그 수정, 2026-09-23 사용자 지시: "이미지 메시지에 대해서
      // '첨부 파일 다운로드'나 '메시지 수정'은 빼줘. 다운로드는 못하게
      // 하고 싶고, 메시지 수정은 의미가 없지 않아?"] — 실측 확인: 이미지
      // 메시지에 "메시지 수정"을 누르면 입력창에 그 이미지가 첨부파일로
      // 다시 로드될 뿐, 텍스트 캡션처럼 실제로 고칠 대상이 없어 사실상
      // 무의미한 재업로드 기능이었다(사용자 판단이 맞음). "첨부 파일
      // 다운로드"는 aria-label로 텍스트 메시지엔 아예 나타나지 않아
      // 항상 제거해도 안전하지만, "메시지 수정"은 텍스트 메시지에서는
      // 여전히 정상 기능이므로 이 메시지가 이미지 첨부를 포함할 때만
      // 제거한다.
      const isImageMessage = !!wrapperEl.querySelector(".str-chat__message-attachment--image");
      box.querySelector('button[aria-label="첨부 파일 다운로드"]')?.remove();
      if (isImageMessage) {
        box.querySelector('button[aria-label="메시지 수정"]')?.remove();
      }
      const composer = document.querySelector<HTMLElement>(".str-chat__message-composer");
      if (!composer) return;
      const boxRect = box.getBoundingClientRect();
      const composerTop = composer.getBoundingClientRect().top;
      const overflow = boxRect.bottom - composerTop;
      if (overflow > 0) {
        const currentTop = parseFloat(getComputedStyle(box).top) || boxRect.top;
        box.style.setProperty("top", `${currentTop - overflow}px`, "important");
      }
    });
  }

  function handleContextMenu(e: React.MouseEvent<HTMLDivElement>) {
    // 🔧 [버그 수정, 2026-09-20] 롱프레스와 동일하게, 실제 콘텐츠(텍스트/
    // 첨부/인용 카드) 바깥에서의 우클릭은 브라우저 기본 메뉴를 그대로
    // 둔다 — 자세한 경위는 handlePointerDown의 동일 가드 주석 참고.
    // 🔧 [버그 수정, 2026-09-22 사용자 지시: "이미지 메시지 버블에 대고
    // 마우스 우클릭 하면 팝업 메뉴가 뜨질 않아"] — 잘못된 클래스명
    // (".str-chat__attachment")을 쓰고 있었다 — 근거는
    // handlePointerDown의 동일 셀렉터 수정 부분 주석 참고. 이미지
    // 메시지는 이 클래스가 애초에 존재하지 않아 우클릭이 처음부터
    // 한 번도 동작하지 않았다.
    if (
      !(e.target as Element).closest(
        ".str-chat__message-text, .str-chat__message-attachment, .str-chat__quoted-message-preview"
      )
    )
      return;
    // 브라우저 기본 우클릭 메뉴(복사/검사 등) 대신 우리 액션 메뉴를 연다.
    e.preventDefault();
    clearLongPressTimer();
    openMessageActionsMenu(e.currentTarget);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (startXRef.current === null) return;
    const delta = e.clientX - startXRef.current;
    if (Math.abs(delta) < MOVE_DEAD_ZONE) return;
    // 🔧 [버그 수정, 2026-09-19 사용자 지시: "모바일에서 스크롤 할 때
    // 답장 제스처가 민감해서 그냥 넘기는데 메시지가 좌측으로 살짝살짝
    // 이동하려는 듯한 움직임이 있다"] — 세로 스크롤 중에도 손가락이
    // 완벽한 직선으로만 움직이지 않아 가로 성분이 섞이는데, 기존
    // 로직은 X 이동량만 보고 5px만 넘으면 곧바로 dragX를 세팅해
    // 스크롤 의도인 제스처에도 버블이 반응해버렸다. Y 이동량과 비교해
    // 실제로 가로쪽 움직임이 더 클 때만(세로보다 가로가 더 뚜렷한
    // 제스처일 때만) 스와이프로 인정한다 — 세로 스크롤은 touch-pan-y로
    // 이미 브라우저에 위임하고 있어(className) 여기서 막을 필요는
    // 없고, 우리 쪽 시각 효과(translateX)만 반응하지 않게 한다.
    const deltaY = pointerDownPosRef.current !== null ? e.clientY - pointerDownPosRef.current.y : 0;
    if (Math.abs(delta) < Math.abs(deltaY)) return;
    // 데드존을 넘어선 이동은 스와이프 의도이므로 롱프레스는 취소한다
    // (누른 채 손이 미끄러진 경우 메뉴가 뜨면 스와이프와 충돌해 어색함).
    clearLongPressTimer();
    // 왼쪽으로만 당겨지게(카카오톡과 동일 방향) — 오른쪽 드래그는 0으로 고정.
    const clamped = Math.min(0, Math.max(-MAX_DRAG, delta));
    setDragX(clamped);
  }

  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    // 🔧 [버그 수정, 2026-09-20 사용자 지시: "꾹 누르면 메뉴가 뜨는
    // 기능 있잖아? 근데 메뉴를 누르면 해당 메뉴 기능이 실행되는게
    // 아니라 뒤에 위치한 메시지가 이미지면 이미지가 클릭되어 확장되어
    // 버리는데?"] — 실측(CDP 실제 터치 + click 이벤트 캡처 로깅)으로
    // 정확한 경위를 확인했다: 롱프레스로 메뉴를 연 뒤 손을 떼면 그
    // 시점의 endDrag가 정상 실행되고 activePointerIdRef/longPressFiredRef
    // 등 모든 상태를 리셋한다. 그 후 사용자가 실제 메뉴 항목(예: "인용
    // 답장")을 클릭하면, Stream의 그 onClick이
    // messageComposer.setQuotedMessage 이후 textarea.focus()를
    // 호출하는데, 이 포커스 이동이 (오래전 롱프레스 때 이 이미지
    // wrapper에 걸어뒀던) setPointerCapture를 브라우저가 암묵적으로
    // 해제시켜 lostpointercapture 이벤트를 뒤늦게(실측: 메뉴 클릭
    // 시점으로부터 약 460ms 후) 재발생시킨다 — onLostPointerCapture도
    // 이 endDrag로 연결돼 있어, 이미 리셋된 pointerDownTargetRef가
    // (그사이 다른 제스처가 없었다면 여전히 이전 이미지 엘리먼트를
    // 가리키고 있는 경우) "클릭이었다"는 분기로 잘못 빠져 그 이미지를
    // 다시 click()해 확대 모달을 열어버렸다. 근본 원인은 "이미 한 번
    // 완전히 종료 처리된 제스처의 유령 재실행"이므로, 이 이벤트의
    // pointerId가 handlePointerDown이 기록해둔 "현재 진행 중인" ID와
    // 다르면(또는 애초에 진행 중인 제스처가 없으면) 그 어떤 분기도
    // 타지 않고 완전히 무시한다 — 이게 유일하게 확실한 방어다(단순
    // ref 값 리셋 타이밍에 의존한 방어는 실측 결과 위 시나리오를
    // 놓쳤다).
    if (activePointerIdRef.current === null || activePointerIdRef.current !== e.pointerId) {
      return;
    }
    activePointerIdRef.current = null;
    clearLongPressTimer();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    const totalMoveDistance =
      pointerDownPosRef.current !== null
        ? Math.hypot(e.clientX - pointerDownPosRef.current.x, e.clientY - pointerDownPosRef.current.y)
        : Infinity;
    if (longPressFiredRef.current) {
      // 이미 롱프레스로 액션 메뉴를 열었으므로, 손을 떼는 동작에서
      // 추가로 클릭/스와이프가 겹쳐 발생하지 않게 한다. 실제 방어(이미지
      // 확대가 함께 열리는 문제)는 handlePointerDown의 타이머 콜백이
      // 등록해둔 네이티브 touchend 캡처 리스너가 담당한다 — 자세한
      // 경위는 그쪽 주석 참고. 여기서도 preventDefault를 걸어두되(무해한
      // 안전망), blockNextClick 기반 방어는 실측 결과 등록 순서 경쟁에서
      // 져 효과가 없었다.
      e.preventDefault();
    } else if (Math.abs(dragX) >= SWIPE_THRESHOLD) {
      messageComposer.setQuotedMessage(message);
      const textarea = document.querySelector<HTMLTextAreaElement>(".str-chat__textarea__textarea");
      textarea?.focus();
    } else if (totalMoveDistance < MOVE_DEAD_ZONE && pointerDownTargetRef.current) {
      // 실제로는 클릭이었던 것으로 판단 — 우리가 setPointerCapture로
      // 가로챈 탓에 브라우저가 만들지 않았을 수 있는 click을 원래
      // 타겟(예: 인용 카드, 이미지 확대 버튼)에 직접 합성해 발생시켜
      // Stream의 onClick 핸들러가 정상 실행되게 한다. 🔧 [버그 수정]
      // releasePointerCapture 직후 같은 틱에서 바로 .click()을 호출하면
      // 브라우저가 이 요소를 여전히 "포인터 캡처 해제 처리 중"으로 보는
      // 시점이라 클릭이 씹히는 경우가 있었다(실측: click 이벤트 리스너
      // 자체는 발생했는데도 React의 onClick이 실행 안 됨) — 다음 매크로
      // 태스크로 미뤄 완전히 해제된 뒤 클릭하도록 한다.
      const targetToClick = pointerDownTargetRef.current;
      const actionMenuWasOpen = !!document.querySelector(".str-chat__message-actions-box--open");
      setTimeout(() => {
        // 🔧 [버그 수정, 2026-09-19 사용자 지시: "우클릭 메뉴를 취소
        // 하려고 이미지 영역을 클릭했을 때 이미지가 확장돼버린다"] —
        // 액션 메뉴가 열려 있는 동안의 클릭은 "메뉴를 닫으려는 의도"이지
        // 사진을 확대하려는 의도가 아니다. 하지만 Stream의 바깥 클릭
        // 감지(DialogPortal.mjs)는 document에 실제 click 이벤트가
        // 발생해야만 동작하는데, 우리가 만든 click 합성 자체를 여기서
        // 완전히 생략하면(처음 시도) 이미지 확대는 막히지만 메뉴도
        // 함께 안 닫혀버렸다(실측). targetToClick(이미지 등) 대신
        // document.body에 합성 클릭을 쏘면, Stream의 바깥 클릭 감지는
        // 여전히 트리거되어 메뉴가 닫히면서도 이미지 자체의 onClick은
        // 실행되지 않는다.
        if (actionMenuWasOpen) {
          document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        } else {
          targetToClick.click();
        }
      }, 0);
    } else if (totalMoveDistance < MOVE_DEAD_ZONE && message.quoted_message) {
      // 🔧 [버그 수정, 2026-09-22 사용자 지시: "'나에게 답장' 처럼 답장
      // 메시지 포함된 버블은 답장 영역만이 아니라 버블 전체를 누르면
      // 이동 이벤트가 발생하게 해줘 ... ㅇㅇ 쪽을 터치하면 이동이 안되는
      // 것 같거든"] — 위 분기(pointerDownTargetRef.current 존재)는
      // 클릭 가능한 요소(인용 카드, 이미지 등) 위를 직접 눌렀을 때만
      // 잡힌다. 인용 카드 아래 본문 텍스트("ㅇㅇ")처럼 클릭 핸들러가
      // 없는 순수 텍스트 위를 클릭하면 pointerDownTargetRef.current가
      // null이라 이 클릭이 통째로 무시됐다 — 이 메시지가 답장(quoted)
      // 메시지라면, 클릭 가능한 요소가 아닌 버블 영역을 눌렀을 때도
      // 원본 메시지로 이동시킨다(카카오톡처럼 버블 전체가 이동 트리거).
      jumpToQuotedMessage(jumpToMessage, message.quoted_message.id);
    }
    pointerDownTargetRef.current = null;
    pointerDownPosRef.current = null;
    startXRef.current = null;
    longPressFiredRef.current = false;
    setDragging(false);
    setDragX(0);
  }

  return (
    <div
      ref={messageWrapperRef}
      data-shake-target={message.id}
      className="group relative touch-pan-y hover:z-10"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onContextMenu={handleContextMenu}
    >
      {/* 스와이프 중에만 드러나는 답장 아이콘 — 버블 뒤쪽(왼쪽)에 고정,
          당긴 만큼(비율) 서서히 진해지도록 opacity를 dragX에 연동한다. */}
      <div
        className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-muted-foreground"
        style={{ opacity: Math.min(1, Math.abs(dragX) / SWIPE_THRESHOLD) }}
      >
        <Reply className="size-4" strokeWidth={ICON_STROKE.default} />
      </div>
      {/* 🔧 [사용자 지시, 2026-09-19] "시간 표시를 말풍선 좌측 하단에,
          카카오톡처럼 말풍선과 같은 줄에 나란히" — Stream 기본 metadata
          (시간+읽음상태)는 chat-theme.css에서 전부 display:none으로
          숨겼다(grid 레이아웃 재정의가 Stream 내부 규칙과 계속 충돌해
          실측대로 안 붙었음). 대신 여기서 버블(MessageUI)과 시간을 같은
          flex row에 직접 배치한다 — 내 메시지는 [시간, 버블] 순서로
          시간이 왼쪽에, 상대 메시지는 [아바타, {이름, 버블}, 시간]
          순서로 시간이 오른쪽에 오도록 해 항상 버블의 바깥쪽에
          자연스럽게 붙는다. items-end로 버블 하단에 시간을 맞춘다
          (사용자 요청: "좌측 하단"). */}
      {/* 🔧 [버그 수정, 2026-09-20 사용자 지시: "아이콘, 이름, 메시지
          요소가 다 따로 노는 것 같아"] — Stream이 그리는 아바타(MessageUI
          내부 grid, align-self:end)는 이름의 존재를 몰라 이름과 절대
          나란해질 수 없는 구조였다(자세한 경위는 useSenderNameToShow
          위 주석 참고). Stream 아바타는 완전히 숨기고(chat-theme.css의
          .str-chat__avatar { display: none }), 이 row에서 우리가
          [아바타, {이름 위/버블 아래를 세로로 쌓은 flex-col}]을 직접
          그린다 — 아바타(PersonAvatar, size="md"로 Stream과 동일한
          32px)와 이름 모두 이 같은 row/컬럼의 자연스러운 정렬을
          따르므로 항상 정확히 나란하다. */}
      <div
        className={cn("flex items-end gap-0", isMyMessage() ? "justify-end" : "justify-start")}
        style={{
          transform: `translateX(${dragX}px)`,
          transition: dragging ? "none" : "transform 150ms ease-out",
        }}
      >
        {/* 🔧 [사용자 지시, 2026-09-19] "시간/배지를 버블과 좀 더
            가깝게" — 버블 자체의 padding-inline-start를 줄이는 방식은
            버블 안쪽 텍스트 여백까지 함께 좁혀 텍스트가 벽에 붙어
            보이는 부작용이 있었다. 대신 시간 쪽에 음수 margin을 줘서
            버블의 텍스트 패딩은 그대로 두고 시간 블록만 버블 쪽으로
            당긴다(버블 padding-inline이 약 8px이므로 그 절반 정도만
            당겨 완전히 겹치지 않게 한다). */}
        {/* 🔧 [사용자 지시, 2026-09-24] "버튼 오버레이도 시간 표시
            좌측에 작게 뜨도록 — 지금은 너무 커. 이모지도 좀 더 줄여서"
            — 기존엔 버블 아래에 별도로 떠 있는 absolute 오버레이였다.
            시간 표시와 같은 flex row의 실제 아이템으로 넣어 "시간 좌측,
            같은 높이, 작게"를 만족시킨다. hover가 아닐 때는 이 자리를
            차지하지 않도록(w-0) 접어둬 시간 위치 자체는 안 밀리게 한다 —
            group-hover일 때만 폭을 펼친다. */}
        {/* 🔧 [버그 수정, 2026-09-24 사용자 지시: "세로 기준으로 버튼과
            시계 출력이 중앙이 됐으면 좋겠어"] — 버튼 그룹과 시간 표시가
            서로 다른 div(items-center vs items-end/flex-col)였는데,
            부모 row가 items-end(바닥 정렬)라 두 블록의 실제 높이가
            달라 세로로 어긋나 보였다(버튼이 시간보다 위로 치우침). 이
            둘을 하나의 items-center row로 묶어 항상 서로의 세로 중앙에
            맞춰지게 한다. */}
        {isMyMessage() && (
          <div className="mb-1 flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              className="hidden size-4 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground [@media(hover:hover)]:group-hover:opacity-100 sm:[@media(hover:hover)]:flex"
              aria-label="답장"
              onClick={(e) => triggerMessageAction(e.currentTarget.closest("[data-shake-target]") as HTMLElement, 'button[aria-label="메시지 인용"]')}
            >
              <Reply className="size-2.5" strokeWidth={ICON_STROKE.default} />
            </button>
            <div className="relative">
              <button
                type="button"
                className={cn(
                  "flex size-4 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground [@media(hover:hover)]:group-hover:opacity-100 sm:[@media(hover:hover)]:flex",
                  showReactionPicker ? "flex opacity-100" : "hidden"
                )}
                aria-label="반응 추가"
                aria-expanded={showReactionPicker}
                onClick={() => setShowReactionPicker((v) => !v)}
              >
                <Smile className="size-2.5" strokeWidth={ICON_STROKE.default} />
              </button>
              {/* 🔧 [버그 수정, 2026-09-24 사용자 지시: "가려지는 경우가
                  있어"] — 팝오버를 버튼 위쪽(bottom-full)으로 띄우면,
                  이 메시지가 스크롤 리스트 상단 근처에 있을 때 뷰포트
                  위쪽 경계를 넘어가 overflow: hidden auto인
                  .str-chat__message-list에 잘렸다(실측 스크린샷으로
                  확인). 버튼 아래쪽(top-full)으로 방향을 바꿔 이 잘림을
                  없앤다. */}
              {showReactionPicker && (
                <div className="absolute right-0 top-full z-10 mt-1 flex items-center gap-0.5 rounded-full border bg-background p-0.5 whitespace-nowrap shadow-md">
                  {QUICK_REACTIONS.map(({ type, emoji, label }) => (
                    <button
                      key={type}
                      type="button"
                      aria-label={`반응 선택: ${label}`}
                      className="flex size-4 items-center justify-center rounded-full text-[10px] hover:bg-accent"
                      onClick={(e) => {
                        handleReaction(type, e);
                        setShowReactionPicker(false);
                      }}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {showTimestamp && thisCreatedAt && (
              <div className="me-[-4px] flex shrink-0 items-center gap-1 text-[11px] leading-none text-muted-foreground">
                {showUnreadOne && <span className="font-medium">1</span>}
                <span>{formatMessageDate(thisCreatedAt)}</span>
              </div>
            )}
          </div>
        )}
        {/* 🔧 [버그 수정, 2026-09-20 사용자 지시: "아바타가 너무 여백
            없이 좌측에 딱 붙었잖아"] — 이 아바타는 이제 .str-chat__message
            (Stream이 좌우 padding-inline을 주던 그 요소, chat-theme.css:
            302행 근처) 바깥, SwipeableMessage가 만든 flex row의 첫
            항목이라 그 패딩의 영향을 전혀 받지 않는다. 내 메시지 쪽
            바깥 여백(padding-inline-end: 8px)과 대칭이 되도록 ms-2(8px)
            를 명시적으로 준다.
            🔧 [버그 수정, 2026-09-20 사용자 재보고: "여전히 아이콘과
            이름, 말풍선 거리가 멀어. 카카오톡을 참고해서"] — me-2.5
            (10px)가 카카오톡(아바타-말풍선 간격 약 6px)보다 눈에 띄게
            넓었다. me-1.5(6px)로 좁힌다 — 그룹 중간/마지막 메시지의
            빈 아바타 자리(바로 아래)도 버블 시작 위치가 그룹 첫
            메시지와 어긋나지 않도록 동일하게 맞춘다. */}
        {!isMyMessage() &&
          (senderName ? (
            // 🔧 [버그 수정] 부모 row가 items-end라 self 지정이 없으면
            // 아바타도 row 바닥(버블 위치)에 맞춰져 이름과 나란해질 수
            // 없었다 — self-start로 이 아바타만 상단 정렬해 이름과
            // 나란한 카카오톡 구조를 만든다.
            <PersonAvatar size="md" className="ms-2 me-1.5 shrink-0 self-start" />
          ) : (
            // 그룹 중간/마지막 메시지는 카카오톡처럼 아바타 자리를
            // 비워 버블 시작 위치를 그룹 첫 메시지와 맞춘다(아바타
            // 폭 32px + gap 6px).
            <div className="ms-2 me-1.5 w-8 shrink-0" />
          ))}
        <div className="min-w-0">
          {senderName && (
            <div className="mb-1 ms-1 text-[12px] font-medium text-muted-foreground">{senderName}</div>
          )}
          <MessageUI />
        </div>
        {/* 🔧 [버그 수정, 2026-09-24 사용자 지시: "상대의 메시지의 경우
            시간 우측에 제대로 표시되지 않아" + "세로 기준으로 버튼과
            시계 출력이 중앙이 됐으면 좋겠어"] — 버튼을 시간보다 더
            바깥쪽(오른쪽)에 두기 위해 시간 표시 뒤에 배치하고, 세로
            정렬 어긋남을 없애기 위해 시간 표시와 버튼 그룹을 하나의
            items-center row로 합쳤다(따로 있던 flex-col 블록과
            items-center 블록이 서로 다른 높이로 계산돼 부모의
            items-end 기준 정렬이 어긋나 보였다). */}
        {!isMyMessage() && (
          <div className="mb-1 flex shrink-0 items-center gap-0.5">
            {showTimestamp && thisCreatedAt && (
              <div className="ms-[-4px] flex shrink-0 items-center text-[11px] leading-none text-muted-foreground">
                <span>{formatMessageDate(thisCreatedAt)}</span>
              </div>
            )}
            <button
              type="button"
              className="hidden size-4 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground [@media(hover:hover)]:group-hover:opacity-100 sm:[@media(hover:hover)]:flex"
              aria-label="답장"
              onClick={(e) => triggerMessageAction(e.currentTarget.closest("[data-shake-target]") as HTMLElement, 'button[aria-label="메시지 인용"]')}
            >
              <Reply className="size-2.5" strokeWidth={ICON_STROKE.default} />
            </button>
            <div className="relative">
              <button
                type="button"
                className={cn(
                  "flex size-4 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground [@media(hover:hover)]:group-hover:opacity-100 sm:[@media(hover:hover)]:flex",
                  showReactionPicker ? "flex opacity-100" : "hidden"
                )}
                aria-label="반응 추가"
                aria-expanded={showReactionPicker}
                onClick={() => setShowReactionPicker((v) => !v)}
              >
                <Smile className="size-2.5" strokeWidth={ICON_STROKE.default} />
              </button>
              {/* 🔧 [버그 수정, 2026-09-24 사용자 지시: "가려지는 경우가
                  있어"] — 팝오버를 버튼 위쪽(bottom-full)으로 띄우면,
                  이 메시지가 스크롤 리스트 상단 근처에 있을 때 뷰포트
                  위쪽 경계를 넘어가 overflow: hidden auto인
                  .str-chat__message-list에 잘렸다(실측 스크린샷으로
                  확인). 버튼 아래쪽(top-full)으로 방향을 바꿔 이 잘림을
                  없앤다 — 입력창과 겹칠 수 있는 마지막 메시지 근처에서도
                  팝오버 자체는 입력창 위에 그려져(z-index 없이도 DOM
                  순서상 자연스럽게) 가려지지 않는다(실측 확인). */}
              {showReactionPicker && (
                <div className="absolute left-0 top-full z-10 mt-1 flex items-center gap-0.5 rounded-full border bg-background p-0.5 whitespace-nowrap shadow-md">
                  {QUICK_REACTIONS.map(({ type, emoji, label }) => (
                    <button
                      key={type}
                      type="button"
                      aria-label={`반응 선택: ${label}`}
                      className="flex size-4 items-center justify-center rounded-full text-[10px] hover:bg-accent"
                      onClick={(e) => {
                        handleReaction(type, e);
                        setShowReactionPicker(false);
                      }}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// 🔧 [사용자 지시, 2026-09-24] "채팅 목록에서 '더 불러오기' 버튼이 아닌
// 무한 스크롤로 구현" — Stream의 ChannelList는 기본 Paginator로
// LoadMorePaginator(클릭형 버튼)를 쓴다. 이 목록은 이미 바깥
// div(overflow-y-auto)가 스크롤 컨테이너이므로, InfiniteScrollPaginator
// (자체 스크롤 컨테이너를 새로 만듦)를 그대로 쓰면 스크롤 컨테이너가
// 이중으로 겹친다. 대신 이 컴포넌트는 바깥 스크롤 컨테이너를
// closest("[data-scroll-container]")로 찾아 그 스크롤 이벤트를 직접
// 구독하고, 바닥 근처(threshold)에 도달하면 hasNextPage일 때만
// loadNextPage를 호출한다 — 목록 끝에서 계속 스크롤하면 다음 페이지가
// 이어서 로드된다.
function ScrollLoadPaginator({
  hasNextPage,
  isLoading,
  loadNextPage,
  children,
}: {
  hasNextPage?: boolean;
  isLoading?: boolean;
  loadNextPage: () => void;
  children?: React.ReactNode;
}) {
  // 🔧 [버그 수정] Stream의 ChannelList는 이 컴포넌트에게 채널 목록
  // 자체(children)를 넘겨주고, Paginator 구현체가 그걸 렌더링할 책임을
  // 진다(기본 LoadMorePaginator 소스 확인: `!reverse && children` 뒤에
  // 버튼을 붙이는 구조) — children을 빼먹으면 페이지네이션 UI뿐 아니라
  // 채널 목록 자체가 통째로 사라진다(실측: 관리자 계정에 있던 회원과의
  // 대화 채널이 목록에서 완전히 안 보임).
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // isLoading prop이 React 렌더를 거쳐 갱신되기 전 짧은 창에 스크롤
  // 이벤트가 연속으로 여러 번 발생하면 loadNextPage가 중복 호출될 수
  // 있다 — 렌더와 무관하게 즉시 갱신되는 ref로 요청 하나가 끝날 때까지
  // (isLoading이 실제로 true가 될 때까지) 추가 호출을 막는다.
  const requestInFlightRef = useRef(false);

  useEffect(() => {
    if (!isLoading) requestInFlightRef.current = false;
  }, [isLoading]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const scrollContainer = sentinel.closest<HTMLElement>("[data-scroll-container]");
    if (!scrollContainer) return;

    const SCROLL_THRESHOLD_PX = 250;

    const maybeLoadNext = () => {
      if (requestInFlightRef.current || isLoading || !hasNextPage) return;
      const distanceFromBottom =
        scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
      if (distanceFromBottom < SCROLL_THRESHOLD_PX) {
        requestInFlightRef.current = true;
        loadNextPage();
      }
    };

    maybeLoadNext();
    scrollContainer.addEventListener("scroll", maybeLoadNext, { passive: true });
    return () => {
      scrollContainer.removeEventListener("scroll", maybeLoadNext);
    };
  }, [hasNextPage, isLoading, loadNextPage]);

  return (
    <>
      {children}
      {hasNextPage && <div ref={sentinelRef} />}
    </>
  );
}

// 🔧 [사용자 지시, 2026-09-19] "좌측 단의 '채팅' 텍스트를 지우고 '채팅
// 목록'/'회원 목록' 전환 버튼" — 기존 "채팅"은 Stream 기본 ChannelListHeader
// (t("Chats"))가 렌더링하던 고정 텍스트였다. 이 자리를 두 뷰(채널 목록 vs
// 전체 회원 목록)를 오가는 세그먼트 버튼으로 바꾼다. ComponentContext의
// ChannelListHeader 슬롯을 이 컴포넌트로 완전히 교체해 렌더링한다.
// 🔧 [사용자 지시] "탭 전환 디자인을 참고해서" — ReportPage(화각 불량
// 제보/PUSH 알림 전송/내 제보 확인)와 동일한 알약형 Tabs 패턴(공용 Tabs,
// rounded-full bg-secondary p-1, 선택 시 흰 배경+그림자)을 그대로 재사용해
// 앱 전체 디자인 언어와 통일한다.
// 🔧 [사용자 지시, 2026-09-20] "'채팅 목록'/'회원 목록' 토글을 다른
// 메뉴들처럼 상단에 올려줘" — 좌측 사이드바 안(48px 높이, 우측 대화창
// 헤더와 나란히 맞춤)에 있던 걸 페이지 최상단으로 옮겼다. 더 이상 그
// 헤더와 높이를 맞출 필요가 없어져, ReportPage의 실제 패딩(py-2.5)과
// 동일하게 키운다.
// 🔧 [버그 수정, 2026-09-20 사용자 지시: "탭바 아래에 구분선 제거해"] —
// 이 탭이 채팅 박스(border 카드) "안"에 있던 시절엔 border-b가 그 아래
// 목록과의 경계 역할을 했지만, 박스 바깥(다른 페이지 최상단 탭과 같은
// 위치)으로 옮긴 뒤에는 그 바로 아래 채팅 박스 자체의 border-top과
// 겹쳐 이중선처럼 보였다 — ReportPage 등 다른 페이지의 탭도 이런
// 구분선을 쓰지 않는다(제거해 일관성도 맞춘다).
// 🔧 [버그 수정, 2026-09-20 사용자 지시: "탭바 폭이 다른 메뉴랑 달라"] —
// 사이드바 안(48px 높이)에 있던 시절엔 좌우 여백(p-2)이 필요했지만,
// 박스 바깥으로 옮긴 지금은 이 padding 때문에 탭이 그 아래 채팅
// 박스(padding 없음, page-content 전체 폭)보다 좌우로 8px씩 좁아 보였다
// (실측 스크린샷으로 확인). ReportPage 등 다른 페이지의 최상단 탭은
// 이런 wrapper padding 없이 페이지 전체 폭(page-content)을 그대로
// 쓴다 — 동일하게 맞춘다.
function ChatListHeader({
  view,
  onViewChange,
}: {
  view: "channels" | "members";
  onViewChange: (view: "channels" | "members") => void;
}) {
  return (
    <div className="shrink-0">
      <Tabs value={view} onValueChange={(v) => onViewChange(v as "channels" | "members")} className="w-full">
        <TabsList className="h-auto w-full rounded-full bg-secondary p-1">
          <TabsTrigger value="channels" className="h-auto flex-1 rounded-full py-2 text-xs data-active:shadow-sm">
            채팅 목록
          </TabsTrigger>
          <TabsTrigger value="members" className="h-auto flex-1 rounded-full py-2 text-xs data-active:shadow-sm">
            회원 목록
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}

// 🔧 [사용자 지시] "관리자 화면에서는 사용자를 선택해서 메시지를 발신할
// 수 있도록" — 기존에는 회원이 채팅 탭에 먼저 들어와야만(watch 호출)
// 채널이 생기고 관리자 ChannelList에 나타났다. 관리자가 명단에서 상대를
// 먼저 골라 채널을 생성/재사용하고 즉시 활성 채널로 전환하는 UI를 추가한다
// — useChatContext().setActiveChannel로 ChannelList가 관리하는 활성
// 채널 상태에 직접 개입한다(Stream 관례).
// 🔧 [사용자 지시, 2026-09-19] "채팅 목록/회원 목록 전환 버튼" — 기존
// Select 드롭다운 대신, "회원 목록" 뷰를 선택했을 때 전체 회원을 스크롤
// 가능한 목록으로 보여주고 클릭 시 바로 대화를 연다(전환은 완료 시
// 자동으로 "채팅 목록"으로 돌아가 방금 연 대화가 목록에 반영되게 한다).
function AdminMemberList({
  call,
  onOpened,
  isAdmin,
  search,
}: {
  call: ReturnType<typeof useApi>["call"];
  onOpened: () => void;
  isAdmin: boolean;
  search: string;
}) {
  const { client, setActiveChannel } = useChatContext();
  const [members, setMembers] = useState<{ number: string; name: string }[] | null>(null);
  const [openingNumber, setOpeningNumber] = useState<string | null>(null);

  useEffect(() => {
    // 🔧 [사용자 지시, 2026-09-24] "채팅 목록/회원 목록 탭을 관리자·
    // 일반회원 구분 없이 똑같이 보여주되, '관리자에게만 문의' 구조(임의
    // 회원과 새 채팅을 여는 건 관리자만)는 유지" — /admin/members는
    // 서버(requireAdmin)가 이미 회원 계정을 403으로 막고 있어(members.js
    // 확인), 이 탭 자체는 보여주더라도 회원 계정으로 굳이 그 API를
    // 호출할 필요가 없다. 애초에 부르지 않고 바로 안내 문구로 대체해
    // 불필요한 실패 요청과 "등록된 회원이 없습니다"라는 오해의 소지가
    //있는 문구(실제로는 권한이 없는 것이지 회원이 없는 게 아님)를 피한다.
    if (!isAdmin) {
      setMembers([]);
      return;
    }
    call<AdminMembersResponse>("/admin/members")
      .then((data) => setMembers(data.members.map((m) => ({ number: m.number, name: m.name }))))
      .catch(() => setMembers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  async function openChannelWith(memberNumber: string, memberName: string) {
    const userId = `member-${memberNumber}`;
    setOpeningNumber(memberNumber);
    try {
      // 🔧 [버그 수정] Stream Chat은 채널 멤버로 지정하려는 유저가 사전에
      // upsert되어 있어야 한다 — 아직 채팅 탭에 한 번도 들어온 적 없는
      // 회원을 관리자가 먼저 선택하면 "don't exist" 400으로 실패했다
      // (실측). 채널을 열기 직전 이 회원을 먼저 Stream에 등록해둔다.
      await call("/chat/ensure-user", { method: "POST", body: { memberNumber, memberName } });
      const channel = client.channel("messaging", inquiryChannelId(userId), {
        members: [userId, "admin"],
      });
      await channel.watch();
      setActiveChannel(channel);
      onOpened();
    } finally {
      setOpeningNumber(null);
    }
  }

  // 🔧 [UI 일관성, 2026-09-21] 다른 관리자 리스트 7곳(제보 검토/
  // 스터디원·퇴실자 목록/정산·벌금/페널티 대상자/사유반휴 검토)은 이미
  // AdminListSkeleton/AdminEmptyState로 통일되어 있는데, 성격이 같은
  // "관리자용 리스트"인 이 회원 목록만 맨텍스트 한 줄(로딩→갑자기 목록
  // 등장) 방식이 남아 있었다(전수조사에서 발견) — 통일.
  if (members === null) {
    return (
      <div className="p-2.5">
        <AdminListSkeleton rows={4} />
      </div>
    );
  }
  if (!members.length) {
    return (
      <div className="p-2.5">
        <AdminEmptyState>
          {isAdmin ? "등록된 회원이 없습니다." : "관리자만 새 대화 상대를 선택할 수 있습니다."}
        </AdminEmptyState>
      </div>
    );
  }

  // 🔧 [사용자 지시, 2026-09-24] 회원 목록 검색 — 채팅 목록처럼 서버
  // 쿼리로 필터링할 대상(채널)이 없어, 이미 받아온 전체 명단을
  // 클라이언트에서 이름 포함 검색으로 거른다.
  const trimmedSearch = search.trim();
  const filteredMembers = trimmedSearch
    ? members.filter((m) => m.name.includes(trimmedSearch))
    : members;

  if (!filteredMembers.length) {
    return (
      <div className="p-2.5">
        <AdminEmptyState>검색 결과가 없습니다.</AdminEmptyState>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {/* 🔧 [사용자 지시, 2026-09-24] "회원 목록 디자인도 채팅 목록
          디자인과 일치시켜줘" — 채팅 목록(Stream ChannelPreview)은
          원형 아바타(PersonAvatar) + 굵은 이름 + 작은 회색 서브텍스트
          레이아웃(패딩 p-2.5, 아바타-텍스트 간격 gap-2)을 쓴다. 이
          목록은 대화 미리보기가 없어 서브텍스트 자리에 "새 대화 시작"을
          대신 넣어 같은 뼈대를 유지한다. */}
      {filteredMembers.map((m) => (
        <button
          key={m.number}
          type="button"
          disabled={openingNumber !== null}
          onClick={() => openChannelWith(m.number, m.name)}
          className="flex items-center gap-2 border-b p-2.5 text-left hover:bg-accent disabled:opacity-60"
        >
          <PersonAvatar size="md" className="shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{m.name}</div>
            <div className="truncate text-xs text-muted-foreground">새 대화 시작</div>
          </div>
          {openingNumber === m.number && <LoadingIndicator />}
        </button>
      ))}
    </div>
  );
}

// 🔧 [사용자 지시, 2026-09-20] "채팅 화면에 접속하면 목록만 보이고,
// 눌렀을 때 개별 채팅창이 스플릿 돼서 보이도록" — 모바일 메신저 앱과
// 같은 패턴: 아직 대화를 선택하지 않았으면 목록이 전체 폭을 차지하고,
// 회원/채널을 클릭해 활성 채널이 생기면 그때부터 목록(좁게)+대화창
// 2단 스플릿으로 전환된다. 활성 채널 여부(useChatContext().channel)를
// 구독해야 하는데, 이건 <Chat> 컴포넌트의 자식에서만 쓸 수 있는
// 컨텍스트라 ChatPage 최상위 함수 본체에서는 읽을 수 없다 — <Chat> 안에
// 렌더링되는 이 컴포넌트로 관리자 화면 전체를 옮겼다.
function AdminChatArea({
  call,
  sidebarView,
  onSidebarViewChange,
  isAdmin,
}: {
  call: ReturnType<typeof useApi>["call"];
  sidebarView: "channels" | "members";
  onSidebarViewChange: (view: "channels" | "members") => void;
  isAdmin: boolean;
}) {
  const { channel, setActiveChannel } = useChatContext();
  const hasActiveChannel = !!channel;
  // 🔧 [사용자 지시, 2026-09-24] "목록 최상단에 검색창 — '재희' 입력하면
  // 해당 회원의 채팅 목록만 보이도록" — Stream 채널 쿼리 필터는
  // 'member.user.name': { $autocomplete } 연산자로 멤버 이름 부분일치
  // 검색을 서버에서 직접 지원한다(클라이언트에서 로드된 페이지만 거르는
  // channelRenderFilterFn과 달리, 검색어에 맞는 채널이 아직 로드 전
  // 페이지에 있어도 정확히 찾아낸다). 빈 문자열이면 필터를 아예 추가하지
  // 않아 기존 전체 목록 동작을 그대로 유지한다.
  const [channelSearch, setChannelSearch] = useState("");
  const trimmedSearch = channelSearch.trim();
  // 회원 목록 전용 검색어 — 채팅 목록과 달리 서버 쿼리가 아니라
  // AdminMemberList가 이미 들고 있는 전체 명단을 클라이언트에서
  // 필터링한다(회원 수가 적어 별도 페이지네이션이 없는 목록이라 충분).
  const [memberSearch, setMemberSearch] = useState("");

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <div
          className={cn(
            "flex w-full shrink-0 flex-col overflow-hidden transition-[width,opacity] duration-200",
            hasActiveChannel && "max-w-70 border-r opacity-100",
            // 아직 대화를 선택하지 않았으면 항상 전체 폭 — max-w-70 제약
            // 자체를 없앤다. (🔧 버그 수정: w-full이 hasActiveChannel
            // 분기 안에만 있어, 채널이 없을 때는 max-w-none만 걸리고
            // w-full이 빠져 flex 아이템이 shrink-to-fit 폭(자식인
            // ChannelList의 고정 280px)으로만 렌더링됐다 — 실측: "목록으로
            // 돌아가기" 버튼을 눌러도 목록이 여전히 280px로 좁게 남는
            // 버그로 발견.)
            !hasActiveChannel && "max-w-none",
            // 🔧 [버그 수정, 2026-09-20 사용자 지시: "모바일에서 채팅
            // 목록이 안 보인다"] — 모바일 폭에서는 데스크톱과 같은
            // 목록(280px)+대화창 반반 스플릿을 그대로 적용하면 둘 다
            // 너무 좁아져 실사용이 불가능하다(실측: 목록 항목이 여러
            // 줄로 눌리고 대화창 버블 폭도 손바닥만해짐). 모바일
            // 메신저 관례대로, 활성 채널이 있으면 목록을 완전히 숨기고
            // 대화창만 전체 화면으로 보여준다 — "목록으로 돌아가기"
            // (X) 버튼이 이미 있어 대화창에서 언제든 목록으로 돌아갈
            // 수 있으므로 목록을 DOM에서 숨겨도 접근성 문제가 없다.
            hasActiveChannel && "max-md:hidden"
          )}
        >
          {/* 🔧 [버그 수정, 2026-09-21 사용자 지시: "채팅 목록에서 마우스
              스크롤을 하면 위에 타이틀 쪽이 올라가버려"] — 이 목록(채팅
              목록/회원 목록 공용)이 스크롤 끝(맨 위/아래)에 도달한 뒤에도
              계속 휠을 굴리면, 그 넘친 스크롤 제스처가 조상으로 전파돼
              PC 트랙패드/일부 마우스에서 페이지 자체가 살짝 흔들리는
              바운스가 재현됐다. overscroll-behavior: contain으로 이
              컨테이너 안에서 스크롤이 끝나면 그 이상은 조상으로 전파되지
              않게 막는다 — 이 목록에 pull-to-refresh 등 다른 오버스크롤
              용도가 없으므로 무해하다. */}
          {/* 🔧 [사용자 지시, 2026-09-24] "회원 목록 디자인도 채팅 목록
              디자인과 일치시켜줘 — 배경색, 검색창 이런것까지" — 검색창을
              채팅 목록 전용으로 두지 않고 두 뷰 공통 자리(목록 스크롤
              영역 바로 위)에 항상 보여준다. 뷰마다 필터 대상이 달라
              검색어 상태 자체는 분리하지만(channelSearch/memberSearch),
              마크업·클래스·배치는 완전히 동일하게 유지한다. */}
          {/* 🔧 [사용자 지시, 2026-09-24] "검색란이랑 채팅의 이름, 오프라인
              출력부랑 높이를 맞춰줘(검색란을 줄여서)" — 오른쪽 대화창
              헤더는 h-12(48px) 고정인데, AdminSearchInput 안의 Input이
              sm 이상에서 sm:h-11(44px)로 커져 바깥 p-2(상하 16px)까지
              더하면 61px로 헤더보다 커 보였다(실측). wrapper를 헤더와
              똑같이 h-12로 고정하고, 인풋 자체 높이를 h-8(32px)로
              오버라이드해 sm:h-11을 눌러 정확히 48px 안에 들어오게 한다. */}
          <div className="flex h-12 shrink-0 items-center border-b px-2">
            {sidebarView === "channels" ? (
              <AdminSearchInput
                value={channelSearch}
                onChange={setChannelSearch}
                placeholder="이름으로 검색"
                className="h-8 bg-white sm:h-8 sm:text-sm dark:bg-white dark:text-foreground"
              />
            ) : (
              <AdminSearchInput
                value={memberSearch}
                onChange={setMemberSearch}
                placeholder="이름으로 검색"
                className="h-8 bg-white sm:h-8 sm:text-sm dark:bg-white dark:text-foreground"
              />
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-scroll-container>
            {sidebarView === "channels" ? (
              // 🔧 [사용자 지시, 2026-09-20] "목록만 보이고, 눌렀을 때
              // 개별 채팅창이 스플릿 돼서 보이도록" — Stream의
              // ChannelList는 setActiveChannelOnMount 기본값이 true라,
              // 목록에 채널이 하나라도 있으면 마운트 즉시 그 중 최신
              // 채널을 자동으로 열어버려(실측: 목록 화면 대신 곧바로
              // 2단 스플릿으로 시작) 의도한 "목록 우선" 진입이 무너졌다.
              // 명시적으로 꺼서, 사용자가 실제로 채널을 클릭해야만
              // hasActiveChannel이 true가 되게 한다.
              <ChannelList
                filters={
                  trimmedSearch
                    ? {
                        type: "messaging",
                        members: { $in: ["admin"] },
                        "member.user.name": { $autocomplete: trimmedSearch },
                      }
                    : { type: "messaging", members: { $in: ["admin"] } }
                }
                sort={{ last_message_at: -1 }}
                setActiveChannelOnMount={false}
                Paginator={ScrollLoadPaginator}
              />
            ) : (
              <AdminMemberList
                call={call}
                onOpened={() => onSidebarViewChange("channels")}
                isAdmin={isAdmin}
                search={memberSearch}
              />
            )}
          </div>
        </div>
        {/* 🔧 [버그 수정, 2026-09-19 사용자 지시: "박스에 불필요한
            여백이 있어"] Channel(Stream 컴포넌트)이 flex 부모 안에서
            flex-basis 기본값(auto, 콘텐츠 고유 크기)만큼만 잡혀
            오른쪽에 빈 공간이 크게 남았다 — flex-1과 min-w-0(flex
            아이템 기본 min-width:auto가 축소를 막는 문제) 둘 다
            줘야 남는 공간을 실제로 채운다. */}
        {/* 🔧 [사용자 지시, 2026-09-19] "내가 보낸 메시지가 차지하는
            폭이 대화창 폭 대비 너무 크다" — 버블 최대폭을 고정
            280px로 두면 넓은 대화창에서는 적당하지만, 좌측 채널
            목록이 펼쳐져 대화창 자체가 좁아진 경우(실측 스크린샷
            비교로 확인) 여전히 대화창 폭 대비 상대적으로 커 보였다.
            뷰포트 기준(vw)이나 grid 트랙 자체의 %(순환 참조 버그)는
            모두 이 "대화창의 실제 남은 폭"을 반영하지 못했던 반면,
            container query(cqw)는 이 div 자체의 실제 렌더 폭을
            기준으로 하므로 채널 목록이 펼쳐지든 접히든 항상 정확히
            반응한다. */}
        {/* 🔧 [사용자 지시, 2026-09-20] 아직 대화를 선택하지 않았으면
            목록이 전체 폭을 차지해야 하므로 대화창 영역 자체를 렌더링
            하지 않는다 — Channel을 항상 마운트해두고 CSS로만 숨기면
            activeChannel이 없는 상태에서 Channel/Window가 빈 화면을
            그리려 시도해 불필요하다(Stream 관례상 Channel은 활성
            채널이 있을 때만 의미 있는 컴포넌트). */}
        {hasActiveChannel && (
          <div className="chat-message-area min-w-0 flex-1">
            <Channel>
              <Window>
                {/* 🔧 [버그 수정, 2026-09-19] 원래는 이 wrapper의 border-b와
                    ChannelHeader 자체 구분선(.str-chat__channel-header,
                    Stream 기본 스타일)이 겹쳐 두 겹으로 두꺼워 보이고
                    (사용자 지적: "바가 두꺼워서 이상한데"), 두 선의 시작
                    x좌표도 달라(wrapper는 접기 버튼부터, Stream 쪽은 그
                    오른쪽부터 시작) 왼쪽이 비어 보였다. Stream 쪽 border는
                    "[&_.str-chat__channel-header]:border-b-0"로 꺼서
                    완전히 없애고, 접기 버튼까지 포함한 wrapper 전체 폭에
                    선을 한 겹만 그어 끝까지 이어지게 한다(사용자 지시:
                    "얇은 선은 끝까지 차도록"). */}
                <div className="flex h-12 shrink-0 items-center overflow-hidden border-b [&_.str-chat__channel-header]:border-b-0">
                  {/* 🔧 [사용자 지시, 2026-09-20] "이 버튼은 채팅 닫고
                      목록으로 돌아가는 버튼이 되어야 하지 않겠니?" —
                      목록 우선 진입(위 AdminChatArea 주석 참고) 방식으로
                      바뀌면서, 이 버튼의 기존 역할("목록 좁게 접기/펴기")은
                      더 이상 맞지 않는다 — 목록은 이미 활성 채널이 있는 동안
                      항상 좁게(max-w-70) 떠 있으므로, 접어도 얻는 실익이
                      없고 오히려 "목록으로 돌아가기"라는 더 자연스러운
                      모바일 메신저 관례를 이 자리가 대신해야 한다.
                      activeChannel을 해제하면 hasActiveChannel이 false가
                      되어 목록이 다시 전체 폭으로 돌아간다. */}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="ml-1 shrink-0"
                    onClick={() => setActiveChannel(undefined)}
                    aria-label="목록으로 돌아가기"
                    title="목록으로 돌아가기"
                  >
                    <X className="size-5" strokeWidth={ICON_STROKE.default} />
                  </Button>
                  <div className="min-w-0 flex-1">
                    {/* 🔧 [사용자 지시, 2026-09-19] "헤더 우측 사람 아이콘
                        (아바타) 제거" — ChannelHeader는 ComponentContext의
                        Avatar가 아니라 자체 Avatar prop을 직접 받는 구조라
                        (상속 안 받음) 빈 컴포넌트를 명시적으로 넘겨 렌더링
                        자체를 없앤다. */}
                    <ChannelHeader Avatar={() => null} />
                  </div>
                </div>
                <PinnedMessageBanner />
                {/* 🔧 [버그 수정, 2026-09-20 사용자 지시: "메시지 확인이
                    된 상태인데, 이전 메시지의 1 표시가 안사라지는
                    버그가 있어"] — Stream의 useLastReadData(내부 훅,
                    소스 확인)는 returnAllReadData가 기본값 false일 때
                    "내가 보낸 메시지 중 가장 최근 것" 단 하나에
                    대해서만 readBy를 계산한다. 우리 "1" 배지
                    (useUnreadOneBadge, 위 정의)는 메시지별 readBy가
                    비어 있으면 무조건 "안 읽음"으로 간주하므로, 상대가
                    실제로 다 읽었어도 최신 메시지보다 이전에 보낸
                    메시지들은 readBy 자체가 계산되지 않아 "1"이 영원히
                    안 사라졌다(실측: 최신 메시지만 정상 갱신, 그 이전
                    메시지 2개는 계속 "1" 표시). MessageList에
                    returnAllReadData를 켜면 이 계산이 메시지 전체로
                    확장된다. */}
                <MessageList returnAllReadData />
                <MessageComposer />
              </Window>
              <Thread />
            </Channel>
          </div>
        )}
      </div>
    </div>
  );
}

// 🔧 [사용자 지시] 매번 새 WebSocket 연결을 만들지 않도록 StreamChat
// 인스턴스를 모듈 스코프에 캐싱한다(getInstance는 같은 apiKey면 기존
// 인스턴스를 그대로 반환하는 싱글턴 팩토리라 실제로는 안전망에 가깝다).
let chatClient: StreamChat | null = null;

// 🔧 [사용자 지시, 2026-09-23] "'인용 답장' → '답장', '메시지 수정' →
// '수정', '메시지 삭제' → '삭제'로 수정해줘" — 이 문구들은 Stream이
// 자체 한국어 번역(ko.mjs)에서 내려주는 것이라 우리 JSX 어디에도 직접
// 쓰여 있지 않다. Streami18n을 새로 만들어 기본 한국어 번역 위에 이
// 세 키만 짧은 문구로 덮어쓴다 — translationsForLanguage는 지정한 키만
// 오버라이드하고 나머지는 기본 한국어 번역을 그대로 쓴다(Streami18n
// 소스 확인: 기존 번역과 merge). 모듈 스코프에 한 번만 만들어 재사용한다
// (chatClient와 동일한 이유 — 컴포넌트가 리렌더링될 때마다 새로
// 만들 필요가 없다).
const chatI18n = new Streami18n({
  language: "ko",
  translationsForLanguage: {
    "Quote Reply": "답장",
    "Edit Message": "수정",
    "Delete message": "삭제",
  },
});

export function ChatPage({
  visible,
  tabBarCollapsed,
  onTabBarCollapsedChange,
  tabBarHeight,
}: {
  visible: boolean;
  tabBarCollapsed?: boolean;
  onTabBarCollapsedChange?: (collapsed: boolean) => void;
  /**
   * 🔧 [버그 수정, 2026-09-20 사용자 지시: "채팅에서는 여전히 네비바
   * 위치가 이상해"] — AppShell이 ResizeObserver로 실측한 하단 바
   * (TabBar 또는 접힘 버튼)의 실제 화면 상 높이. 예전엔 이 값을
   * 매직넘버(89, 24 등)로 추측했는데 TabBar 쪽 padding/env 계산이
   * 바뀔 때마다 계속 어긋났다 — 이제 실측값을 그대로 받아쓰므로
   * 어긋날 여지가 없다.
   */
  tabBarHeight?: number;
}) {
  const { call } = useApi();
  const { isAdmin } = useAuth();
  const { dark } = useTheme();
  const viewportRect = useVisualViewportRect();
  const safeAreaInsetTop = useSafeAreaInsetTop();
  // 🔧 [버그 수정, 2026-09-21 사용자 재보고: "대시보드에서 아래로 끌었을
  // 때 되던 새로고침이 실종된 것 같다"] — index.css 참고. html의
  // overscroll-behavior-y: none(iOS 러버밴드 바운스 억제, 2026-09-20
  // 채팅 스크롤 버그 수정)이 앱 전체에 걸려 있어, 그 바운스에 의존하는
  // usePullToRefresh 제스처가 대시보드를 포함한 모든 화면에서 죽어
  // 있었다 — 원래 이 규칙은 채팅 화면에만 필요했다. ChatPage가 실제로
  // 화면에 보이는 동안만 html에 .chat-no-bounce를 얹어, 그때만 바운스를
  // 완전히 끄고 다른 화면은 다시 기본값(body와 동일한 contain, 시각적
  // 바운스는 허용)으로 pull-to-refresh가 정상 동작하게 한다. ChatPage는
  // 한 번 방문하면 hidden으로만 감춰지고 계속 마운트 유지되므로(App.tsx)
  // visible prop으로 판단해야 한다 — 언마운트 시점이 아니라.
  useEffect(() => {
    if (!visible) return;
    document.documentElement.classList.add("chat-no-bounce");
    return () => {
      document.documentElement.classList.remove("chat-no-bounce");
    };
  }, [visible]);
  // 🔧 [버그 수정, 2026-09-20 사용자 지시: "네비바 올라온 상태에서 입력
  // 모드로 가면 이렇게 되는데, 자연히 접히도록 해줘"] — 사용자가 탭바를
  // 수동으로 펼쳐둔 채(tabBarCollapsed=false) 입력창을 탭하면, 펼쳐진
  // TabBar 전체가 화면에 그대로 남아 키보드 바로 위에 끼어들었다(실측
  // 스크린샷). 지금까지의 처리(^버튼 숨김, 헤더 오프셋 제거 등)는 모두
  // "이미 접혀 있는 상태"만 다뤘을 뿐, "펼쳐진 상태에서 키보드가 뜨는"
  // 이 경우는 다루지 않았다 — 키보드가 새로 뜨는 순간(viewportRect.top이
  // 0에서 양수로 바뀌는 순간) 탭바가 펼쳐져 있으면 자동으로 접는다.
  // 🔧 [버그 수정, 2026-09-21 사용자 지시: "입력을 하다가 닫으면 ^의
  // 위치가 저렇게 올라와버리고 아래에는 여백이 생긴다"] — 위 effect가
  // 키보드가 뜰 때 탭바를 자동으로 접긴 했지만, 키보드가 다시 닫힐 때
  // (viewportRect.top이 양수→0으로 돌아갈 때) 원래대로 자동으로 펴주는
  // 처리가 없었다 — 그래서 입력을 마치고 키보드를 내려도 탭바는 계속
  // "접힌" 상태(^버튼만 남고 탭바 자체는 숨김)로 남았고, ChatPage가
  // 그 접힌 상태 기준으로 컨테이너 height를 계산해(1598행,
  // tabBarCollapsed ? "6.6rem" : "11.5rem") 실제로는 탭바가 차지해야
  // 할 공간만큼 그대로 빈 여백이 남았다. "자동으로 접었을 때"만
  // 기억해뒀다가 키보드가 닫히면 그때만 자동으로 되돌린다 — 사용자가
  // ^버튼으로 수동으로 접은 경우는 건드리지 않는다.
  const autoCollapsedRef = useRef(false);
  useEffect(() => {
    const keyboardUp = !!viewportRect && viewportRect.top > 0;
    if (keyboardUp && tabBarCollapsed === false) {
      autoCollapsedRef.current = true;
      onTabBarCollapsedChange?.(true);
    } else if (!keyboardUp && autoCollapsedRef.current) {
      autoCollapsedRef.current = false;
      onTabBarCollapsedChange?.(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewportRect?.top]);
  // 🔧 [버그 수정, 2026-09-20] "채팅창에 손가락을 아래 → 위로 스크롤
  // 하면 화면이 움직여" 문제를 body를 position:fixed로 잠가 해결하려
  // 했으나, 그 직후 "상단의 제목 부분이 잘려버려"라는 새 문제가
  // 생겼고, top을 scrollY로 보정해도 여전히 해결되지 않았다 — 근본
  // 원인은 body를 건드리는 방식 자체였다: body의 position을 바꾸면
  // iOS Safari가 그 순간 주소창을 다시 나타내거나 뷰포트 측정을 다시
  // 하는 부작용이 있어, 이 채팅 컨테이너가 매 프레임 구독하는
  // window.visualViewport(useVisualViewportRect)의 top/height 값 자체가
  // 흔들렸다. 그 결과 "키보드가 떠서 카메라가 이동한 상태"로 잘못
  // 판정되어 headerOffsetPx가 0으로 계산돼, 채팅 컨테이너가 헤더가
  // 있어야 할 공간을 확보하지 않은 채 그 위에 겹쳐 올라가 헤더가
  // 잘린 것으로 보인다. body는 전혀 건드리지 않고, 실제 스크롤이
  // 일어나는 메시지 리스트 자체(.str-chat__message-list, chat-theme.css)
  // 에 overscroll-behavior: none을 걸어 그 컨테이너의 바운스가 body로
  // 전파되는 것 자체를 막는, 훨씬 국소적인 방식으로 대체한다.
  const [client, setClient] = useState<StreamChat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // 🔧 [사용자 지시, 2026-09-19] "채팅 목록"(대화 중인 채널들)과 "회원
  // 목록"(전체 회원, 새 대화 시작용)을 전환하는 버튼 — 기존에는 상단에
  // 드롭다운(새 대화 시작할 회원 선택)과 채널 목록이 동시에 늘 보였지만,
  // 이제 둘 중 하나만 보이도록 뷰를 나눈다.
  const [sidebarView, setSidebarView] = useState<"channels" | "members">("channels");
  // 탭을 오갈 때마다 재연결하지 않도록, 이미 연결을 시도했으면 다시
  // 시도하지 않는다 — visible이 false→true로 바뀔 때마다 실행되는
  // useEffect 의존성 배열과 별개로, 연결 자체는 세션당 1회면 충분하다.
  const connectedRef = useRef(false);

  // 🔧 [사용자 지시, 2026-09-19] "이미지 크게 띄웠을 때(확대 모달) 헤더에
  // '당신'으로 나오는 것 → 로그인한 사람의 실제 이름(예: '재희1')으로"
  // — 확대 모달(GalleryHeader)이 본인이 보낸 이미지일 때 t("You")
  // (="당신")를 직접 텍스트로 렌더링한다. 이 헤더는 Stream의
  // ModalGallery.tsx가 GalleryUI를 ComponentContext보다 우선해 prop으로
  // 직접 주입하므로(Gallery.mjs: `GalleryUI$1 ?? ContextGalleryUI ??
  // GalleryUI`) ComponentProvider로는 교체 불가능함을 소스 확인함 — 대신
  // 모달이 열릴 때 DOM에 나타나는 제목 요소를 감지해 텍스트가 정확히
  // "당신"일 때만(=상대방이 보낸 이미지의 실제 이름은 절대 건드리지 않음)
  // 로그인한 본인의 이름으로 안전하게 치환한다.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const el = document.querySelector<HTMLElement>(".str-chat__gallery__title");
      const myName = client?.user?.name;
      if (el && el.textContent === "당신" && myName) {
        el.textContent = myName;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [client]);


  // 🔧 [버그 수정, 2026-09-19 사용자 지시: "PC 기준으로 여백을 눌러도
  // 안 닫히는데?"] — Stream의 GalleryUI.handleBackgroundClick은
  // `event.target !== event.currentTarget`이면 즉시 무시하는데,
  // .str-chat__gallery__slide-container의 유일한 자식인 media-container/
  // media(사진을 감싸는 flex 컨테이너, 둘 다 width:100%;height:100%)가
  // slide-container 전체를 꽉 채운다(소스 확인). 즉 "사진 주변 여백"으로
  // 보이는 영역도 실제 DOM상으로는 이미 media-container/media에 속해
  // target이 slide-container 자신이 되는 경우가 사실상 없어
  // closeOnBackgroundClick=true가 켜져 있어도 실사용에서는 거의 항상
  // 무시된다. 처음엔 .str-chat__gallery__media--image(사진을 감싸는 div)
  // 전체를 "사진"으로 보고 예외 처리했으나, 이 div 자체도 media와 마찬가지로
  // 넓은 영역을 차지해(실측: 사진 경계 30px 바깥도 이 클래스로 잡힘)
  // 결과적으로 아무 데도 안 닫혔다 — 실제 이미지 픽셀 영역과 정확히 일치하는
  // 것은 <img class="str-chat__base-image"> 자신뿐이므로, target이 정확히
  // 이 <img>일 때만 예외로 두고 나머지는 모두 닫는다.
  useEffect(() => {
    function handleModalBackgroundClick(e: MouseEvent) {
      const modal = document.querySelector<HTMLElement>(".str-chat__modal--open.str-chat__gallery-modal");
      if (!modal) return;
      const target = e.target as HTMLElement;
      if (target.closest(".str-chat__gallery__header-actions, .str-chat__gallery__nav-button")) return;
      if (target.tagName === "IMG" || target.tagName === "VIDEO") return;
      document.querySelector<HTMLButtonElement>(".str-chat__gallery__action-button--close")?.click();
    }
    document.addEventListener("click", handleModalBackgroundClick);
    return () => document.removeEventListener("click", handleModalBackgroundClick);
  }, []);

  // 🔧 [버그 수정, 2026-09-19 사용자 지시: "꾹 눌러서 메뉴를 띄웠을 때,
  // 이미지 영역을 터치해서 취소하려고 하면 이미지가 열려버린다"] —
  // SwipeableMessage(모듈 상단의 blockNextClick 플래그 정의 참고)가
  // 롱프레스로 액션 메뉴를 여는 시점에 이 플래그를 세팅해두면, 뒤이어
  // 브라우저가 이미지 위에 발생시키는 진짜 click을 여기서 Stream의
  // document 캡처 리스너(DialogPortal.mjs, "바깥 클릭 시 다이얼로그
  // 닫기")가 보기 "전에" 가로채 완전히 삼킨다. 캡처 단계에서 같은
  // document에 여러 리스너가 있으면 등록된 순서대로 실행되는데, 이
  // ChatPage는 앱이 처음 렌더될 때 마운트되는 반면 Stream의 리스너는
  // 다이얼로그가 실제로 열릴 때(=사용자가 롱프레스하는 시점)에야
  // 등록되므로, 이 리스너가 항상 먼저 등록되어 항상 먼저 실행된다.
  useEffect(() => {
    function handleGlobalClickCapture(e: MouseEvent) {
      if (blockNextClick) {
        blockNextClick = false;
        e.preventDefault();
        e.stopPropagation();
      }
    }
    document.addEventListener("click", handleGlobalClickCapture, { capture: true });
    return () => document.removeEventListener("click", handleGlobalClickCapture, { capture: true });
  }, []);

  useEffect(() => {
    if (connectedRef.current) return;
    connectedRef.current = true;

    call<ChatTokenResponse>("/chat/token", { method: "POST" })
      .then(async (data) => {
        const c = chatClient ?? StreamChat.getInstance(data.apiKey);
        chatClient = c;
        await c.connectUser({ id: data.userId, name: data.userName }, data.token);
        setClient(c);

        if (!isAdmin) {
          // 🔧 [사용자 지시, 2026-09-24] 예전엔 이 채널을 열어 별도
          // memberChannel state에 저장하고 회원 전용 단일 채널 뷰에
          // 바로 렌더링했다 — 이제 회원도 "채팅 목록"(AdminChatArea의
          // ChannelList)에서 자기 채널을 보고 클릭해 들어가므로 그 state
          // 자체는 더 이상 쓰지 않는다. 다만 watch() 호출은 그대로
          // 남긴다 — 이게 "회원-관리자" 채널을 멱등 생성/등록하는
          // 역할이라, 한 번도 대화를 시작한 적 없는 신규 회원이라도
          // 로그인 즉시 이 채널이 Stream에 존재하게 되어 "채팅 목록"에
          // 바로 나타난다(watch 없이는 채널 자체가 생성되지 않아 목록이
          // 비어 보였을 것).
          const channel = c.channel("messaging", inquiryChannelId(data.userId), {
            members: [data.userId, "admin"],
          });
          await channel.watch();
        }
      })
      .catch((err) => {
        connectedRef.current = false;
        setError(err instanceof Error ? err.message : "채팅 연결에 실패했습니다.");
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 🔧 [버그 수정, 2026-09-21 사용자 지시: "위로 스와이프하면 메시지가
  // 더 나온다"로 확인] — 이 wrapper의 height는 정확히 계산되고 있었지만
  // (디버그 배지로 실측: vpH/tabBarH 모두 정상), 그 height가 JS로
  // 바뀔 때 Stream의 MessageList(useScrollLocationLogic.mjs 소스 확인)는
  // 이 컨테이너 자체의 리사이즈를 감시하지 않는다 — 오직 메시지 개수가
  // 바뀌거나 과거 메시지를 불러올 때만 스크롤을 재조정한다. 그 결과
  // 키보드가 닫히며 이 컨테이너가 다시 커져도 이미 잡아둔 scrollTop은
  // 그대로 남아, 늘어난 높이만큼 메시지 리스트 하단에 빈 공간이 생겼다.
  // MessageListContext(scrollToBottom)는 MessageList 자기 자신의 자식
  // 트리에만 노출되어 쓸 수 없으므로, DOM에서 실제 스크롤 컨테이너
  // (.str-chat__message-list-scroll)를 찾아 바닥 근처였을 때만 다시
  // 맨 아래로 스크롤시킨다.
  // ⚠️ 이 훅은 아래 early return(error / loading) 앞에 있어야 한다 —
  // 뒤에 두면 로딩→완료 전환 시 훅 개수가 달라져 "Rendered more hooks
  // than during the previous render" 오류로 화면이 깨진다(실제 발생).
  // 🔧 [버그 수정, 2026-09-21 재진단] 디버그 배지 재비교 결과, 키보드를
  // 닫은 뒤 vpH가 정상(844)이 아니라 797(=844-47, 상단 안전영역만큼
  const containerRef = useRef<HTMLDivElement>(null);
  // 🔧 [버그 수정, 2026-09-23 사용자 지시: "이전 메시지 쪽으로 스크롤 한
  // 상태에서 키보드 입력을 눌렀다가 키보드를 다시 내리면 스크롤이 가장
  // 최근 쪽으로 내려가버린다. 스크롤 값이 유지되었으면 좋겠어"] — 아래
  // effect는 주석상 "바닥 근처였을 때만 다시 맨 아래로 스크롤"하려는
  // 의도였지만(1569행 옛 주석 참고), 실제 구현은 ResizeObserver 콜백이
  // 조건 없이 scrollToBottom()을 호출하고 있었다 — 그 결과 키보드가
  // 뜨거나(리사이즈) 닫힐 때(또 리사이즈)마다 사용자가 과거 메시지를
  // 보려고 올려둔 스크롤 위치를 매번 무시하고 맨 아래로 끌고 갔다.
  // 리사이즈가 "일어나기 직전"의 스크롤이 바닥 근처였는지를 ref에
  // 기록해두고, 그 값을 기준으로만 판단한다 — 리사이즈 도중/직후에
  // scrollTop을 다시 재는 방식은 이미 브라우저가 리사이즈에 맞춰
  // scrollTop을 임의로 보정한 뒤일 수 있어 신뢰할 수 없다(실측: 키보드가
  // 뜨면 컨테이너가 줄어들며 브라우저가 scrollTop을 강제로 당겨놓는 경우가
  // 있었다).
  const wasNearBottomRef = useRef(true);
  // 🔧 [버그 수정, 2026-09-23 사용자 재보고: "스크롤 위치 유지가 되긴
  // 하는데 키보드를 띄우면 메시지가 잘려버려 ... 1번 사진의 메시지 끝
  // 지점이 키보드가 올라와도 끝 지점이 되길 바라는건데 지금은 그렇지가
  // 않아"] — 바로 위 수정은 scrollTop(픽셀 절대값) 자체를 그대로
  // 두는 것이었는데, 키보드가 뜨면 컨테이너의 clientHeight 자체가
  // 줄어들어(뷰포트가 좁아짐) 같은 scrollTop이라도 "바닥까지 남은
  // 거리"가 달라진다 — 그 결과 리사이즈 전엔 화면 하단 바로 위에
  // 보이던 메시지 끝부분이, 줄어든 뷰포트 아래로 밀려나 잘려 보였다.
  // 사용자가 원한 건 "화면에 보이던 콘텐츠의 끝 지점"이 유지되는
  // 것이므로, scrollTop이 아니라 "바닥으로부터의 거리(scrollHeight -
  // scrollTop - clientHeight)"를 리사이즈 전후로 동일하게 맞춰야 한다.
  const distanceFromBottomRef = useRef(0);
  useEffect(() => {
    const containerEl = containerRef.current;
    if (!containerEl) return;
    const BOTTOM_THRESHOLD_PX = 48;
    // 이 스코프 밖(setupForScrollEl)에서 매번 새로 만들어지는 리스너들을
    // 해제하기 위한 핸들 — .str-chat__message-list가 없어지면(채널 전환
    // 등으로 언마운트) 정리하고, 다시 나타나면 새로 설치한다.
    let cleanupCurrent: (() => void) | null = null;

    // 🔧 [버그 수정, 2026-09-23 사용자 지시: "이전 메시지 쪽으로 스크롤
    // 한 상태에서 키보드 입력을 눌렀다가 키보드를 다시 내리면 스크롤이
    // 가장 최근 쪽으로 내려가버린다" → (재보고) "키보드를 띄우면 메시지가
    // 잘려버려" → (재재보고) "아예 수정 전처럼 가장 최근 메시지 쪽으로
    // 스크롤 되어버리는데"] — 이 세 번째 재보고의 진짜 원인은 앞선 두
    // 수정의 로직 자체가 아니라, 이 effect 전체가 애초에 실행되지 않고
    // 있었던 것이었다: containerRef가 걸린 요소는 AdminChatArea가 아니라
    // 최상위 ChatPage 컴포넌트에 있는데, 이 effect의 deps
    // ([viewportRect?.top, viewportRect?.height, tabBarHeight])는 채널을
    // 처음 선택하거나 전환해도 전혀 바뀌지 않는다 — 그 결과 페이지가 막
    // 열려 아직 채널을 선택하지 않은 최초 마운트 시점(.str-chat__
    // message-list가 DOM에 없음)에 effect가 실행되면 scrollEl을 못 찾아
    // 그대로 return해버렸고, 이후 채널을 선택해 MessageList가 실제로
    // DOM에 나타나도 effect가 다시 실행되지 않아 ResizeObserver도
    // focusin 리스너도 결국 한 번도 설치되지 않은 채로 남았다(로컬에서
    // console.log를 심어 직접 확인). deps에 의존하는 대신,
    // MutationObserver로 containerEl 하위에 .str-chat__message-list가
    // 나타나거나 사라지는 것 자체를 직접 감시해, 나타날 때마다 아래 로직을
    // (재)설치한다 — 채널 전환마다 이 DOM이 통째로 새로 마운트되므로
    // 이 방식이 "지금 어떤 채널이 열려 있든" 항상 정확하다.
    const setupForScrollEl = (scrollEl: HTMLElement) => {
      // 대화창을 처음 여는 시점(마운트 직후, wasNearBottomRef 초기값
      // true)엔 사용자가 아직 아무 데도 스크롤하지 않았으니 맨 아래가
      // 맞다. 이후 키보드로 인한 리사이즈에서는, "리사이즈 직전 스크롤이
      // 바닥 근처였을 때만" 다시 맨 아래로 따라간다(과거 메시지를 읽던
      // 도중이면 그 위치를 그대로 둔다) — 바닥 근처의 판정 여유(48px)는
      // 메시지 1줄 높이 정도의 오차를 흡수한다.
      //
      // scroll 이벤트로 distanceFromBottomRef를 계속 갱신하는 것만으로는
      // 부족했다 — iOS Safari가 <textarea> 포커스 시 그 입력창을 보이게
      // 하려고 스스로 스크롤을 조정하는 네이티브 동작이 우리
      // ResizeObserver보다 먼저 handleScroll을 건드려, "사용자가 실제로
      // 보던 위치"가 아니라 "브라우저가 입력창을 보이려고 이미 당겨놓은
      // 위치"를 잘못 기록할 수 있다. "포커스가 입력창으로 이동하는 바로 그
      // 순간"(리사이즈가 시작되기도 전, 캡처 단계라 브라우저 자동 스크롤
      // 보다 먼저 실행됨을 노림)에 그 시점 값을 별도로 동결해두고, 리사이즈
      // 중에는 이 동결된 값을 우선 쓴다.
      const frozenDistanceRef = { current: null as number | null };
      const freezeCurrentScroll = () => {
        const distanceFromBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
        frozenDistanceRef.current = distanceFromBottom;
        wasNearBottomRef.current = distanceFromBottom <= BOTTOM_THRESHOLD_PX;
      };
      const applyScrollForResize = () => {
        if (wasNearBottomRef.current) {
          scrollEl.scrollTop = scrollEl.scrollHeight;
          return;
        }
        // 바닥으로부터의 거리(scrollHeight - scrollTop - clientHeight)를
        // 리사이즈 전후로 동일하게 맞춘다 — scrollTop(절대 픽셀값)만
        // 고정하면 clientHeight가 줄어든 만큼 화면에 보이는 콘텐츠 끝
        // 지점이 아래로 밀려나 잘려 보인다.
        const target = frozenDistanceRef.current ?? distanceFromBottomRef.current;
        scrollEl.scrollTop = scrollEl.scrollHeight - scrollEl.clientHeight - target;
      };
      applyScrollForResize();
      const observer = new ResizeObserver(applyScrollForResize);
      observer.observe(scrollEl);
      const handleScroll = () => {
        const distanceFromBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
        wasNearBottomRef.current = distanceFromBottom <= BOTTOM_THRESHOLD_PX;
        distanceFromBottomRef.current = distanceFromBottom;
      };
      scrollEl.addEventListener("scroll", handleScroll, { passive: true });
      const handleFocusIn = (e: FocusEvent) => {
        if ((e.target as HTMLElement)?.tagName === "TEXTAREA") freezeCurrentScroll();
      };
      const handleFocusOut = (e: FocusEvent) => {
        if ((e.target as HTMLElement)?.tagName === "TEXTAREA") frozenDistanceRef.current = null;
      };
      // textarea는 메시지 목록(scrollEl) 바깥, 입력창 영역에 있으므로
      // containerEl(둘을 모두 포함하는 채팅 화면 전체 wrapper)에 건다.
      containerEl.addEventListener("focusin", handleFocusIn, true);
      containerEl.addEventListener("focusout", handleFocusOut, true);
      return () => {
        observer.disconnect();
        scrollEl.removeEventListener("scroll", handleScroll);
        containerEl.removeEventListener("focusin", handleFocusIn, true);
        containerEl.removeEventListener("focusout", handleFocusOut, true);
      };
    };

    const trySetup = () => {
      const scrollEl = containerEl.querySelector<HTMLElement>(".str-chat__message-list");
      if (scrollEl && !cleanupCurrent) {
        cleanupCurrent = setupForScrollEl(scrollEl);
      } else if (!scrollEl && cleanupCurrent) {
        cleanupCurrent();
        cleanupCurrent = null;
      }
    };
    trySetup();
    const mutationObserver = new MutationObserver(trySetup);
    mutationObserver.observe(containerEl, { childList: true, subtree: true });

    return () => {
      mutationObserver.disconnect();
      cleanupCurrent?.();
    };
    // 🔧 [버그 수정, 2026-09-23] 진짜 원인은 deps가 아니라 실행 타이밍
    // 자체였다: containerRef가 붙은 <div>는 아래 "if (loading || !client)"
    // early return보다 뒤에 있어, 페이지가 처음 열려 아직 로딩 중인 첫
    // 렌더에서는 그 div 자체가 렌더링되지 않는다(LoadingIndicator만
    // 보여줌) — 이 effect가 deps: []로 그 첫 렌더 직후 실행되면
    // containerRef.current는 항상 null이고(콘솔 로그로 직접 확인), 로딩이
    // 끝나 실제 DOM이 마운트돼도 deps가 안 바뀌니 다시 실행되지 않아
    // 영원히 무효 상태로 남았다. loading을 deps에 넣어, 로딩이 끝나 실제
    // UI가 처음 마운트되는 바로 그 렌더 직후 이 effect가 (다시) 실행되게
    // 한다.
  }, [loading]);

  if (error) {
    return (
      <InfoCard className="flex flex-col items-center gap-1.5 bg-card py-6 text-center text-muted-foreground">
        <MessageCircle className="size-5" strokeWidth={ICON_STROKE.default} />
        <span className="text-xs sm:text-sm">{error}</span>
      </InfoCard>
    );
  }

  if (loading || !client) {
    return (
      <div className="flex items-center justify-center py-10">
        <LoadingIndicator />
      </div>
    );
  }

  // 🔧 [사용자 지시] "하단 탭 메뉴에 '채팅' 탭 신설" — 다른 탭과 마찬가지로
  // visible이 false(다른 탭 보는 중)여도 언마운트하지 않고 hidden으로만
  // 감춘다(App.tsx MainViews와 동일한 전역 정책, WebSocket 연결을 계속
  // 유지해 실시간 수신을 놓치지 않기 위함).
  // 🔧 [버그 수정, 2026-09-19 사용자 지시: "채팅창 폭이 다른 메뉴보다
  // 좁다"] 다른 모든 페이지(DashboardPage/ReportPage/SettingsPage 등)는
  // 최상위 컨테이너에 "w-full page-content"를 직접 붙인다 — AppShell의
  // {children}은 그냥 items-center로 가운데 정렬만 할 뿐, 실제 반응형
  // 최대폭(page-content, index.css: 28rem→40rem→48rem)은 각 페이지가
  // 스스로 적용해야 하는 구조다. 이 클래스가 빠져 있어 콘텐츠 자체 크기
  // (Stream 기본 레이아웃의 내재적 폭)만큼만 좁게 잡혀 있었다.
  // 🔧 [버그 수정, 2026-09-19 사용자 지시: "박스에 불필요한 여백"] 실측
  // (Playwright)해보니 헤더(88px)+하단 탭바(89px)=177px인데 기존
  // 8.5rem(136px)로는 41px 부족해, 채팅 박스 하단이 탭바 밑으로 41px
  // 파고들어 메시지 입력창이 탭바에 가려 보였다 — 11.5rem(184px)으로
  // 조정해 겹침 없이 정확히 맞춘다.
  // 🔧 [사용자 지시, 2026-09-20] "채팅 화면에서는 하단 네비바를 숨김
  // 처리 할 수 있어?" — 탭바(실높이 89px)가 접히면 AppShell이 그 자리에
  // 작은 펼치기 버튼을 대신 그린다. 이 높이 계산은 그 값과 별개로
  // 고정된 매직넘버라 버튼의 실제 크기가 바뀔 때마다 재보정이 필요했다
  // (실측 기반 값). 🔧 [사용자 지시] "버튼이 커서 네비바를 숨긴 의미가
  // 퇴색된다"는 지적으로 AppShell의 펼치기 버튼을 원형 배경 없는 순수
  // ^ 문자(아이콘 20px + 여백 4px ≈ 24px)로 축소하며 7.5rem(120px)으로
  // 다시 낮췄다(실측: 축소 전 8.7rem 기준으로는 박스와 버튼 사이 27px
  // 여백이 남았음).
  // 🔧 [사용자 지시, 2026-09-20] "채팅목록, 회원목록을 박스에서 아예
  // 빼라니까? 다른 메뉴처럼" — 이전엔 AdminChatArea(Chat 안쪽) 안에서
  // ChatListHeader를 그렸는데, 그러면 이 탭 전환 UI가 채팅 박스 테두리
  // 안에 갇혀 다른 페이지(ReportPage 등)의 최상단 탭 메뉴와 시각적으로
  // 달라 보였다. ChatListHeader는 client/channel 등 Stream 컨텍스트를
  // 전혀 참조하지 않는 순수 탭 UI라 Chat 바깥으로 옮겨도 무방하다.
  // 🔧 [버그 수정] 처음엔 박스 자체에만 h-[calc(100dvh-Nrem)] 절대
  // 계산을 그대로 두고 그 위에 헤더를 얹었더니, 헤더가 차지하는 높이
  // (실측 59px+gap 8px=67px)만큼 이 계산이 반영을 안 해 박스 아래에
  // 그만큼의 빈 여백이 생겼다(실측 스크린샷으로 확인) — 헤더 높이가
  // 바뀔 때마다 이 매직넘버를 다시 재보정해야 하는 취약한 구조이기도
  // 하다. 절대 높이 계산 자체를 최상위 wrapper(헤더+박스를 합친 전체
  // 영역)로 옮기고, 안쪽 박스는 flex-1 min-h-0으로 "헤더가 쓰고 남은
  // 나머지"를 자동으로 채우게 하면 헤더 높이가 얼마든 다시 계산할
  // 필요가 없다.
  // 🔧 [버그 수정, 2026-09-20 사용자 지시: "메시지 보내기에 탭 해서
  // 입력 상태가 되면 카카오톡처럼 되면 좋겠는데 너무 여백이 많이
  // 생겨" → "여전히 아이폰에서 입력 시 공백이 생겨" → "아예 이렇게
  // 올라가 버리는데?" → "다시 이렇게 됐는데"] — 실기기(아이폰)
  // 디버그 배지로 확인한 원인: iOS Safari는 키보드가 뜰 때 100dvh나
  // 레이아웃 자체를 줄이지 않고, 대신 "카메라"(visualViewport)를 문서
  // 좌표계 안에서 키보드 높이만큼 아래로 이동(offsetTop > 0)시킨다.
  // 🔧 [버그 수정] 이 오프셋을 height calc + translateY 조합으로
  // 보정하려는 시도를 두 차례 했으나 모두 실패했다 — 박스 전체를
  // 옮기면 헤더까지 밀려났고(1차), 헤더만 이동에서 빼자 이번엔 헤더가
  // 원래 레이아웃 뷰포트 좌표(카메라가 이미 그 자리를 벗어나 실제로는
  // 화면 밖) 그대로 남아 화면 전체가 빈 채로 보였다(2차, 실측
  // 스크린샷: "다시 이렇게 됐는데"). translateY는 "레이아웃 흐름
  // 안에서 상대적으로 옮기는" 도구일 뿐이라, 애초에 좌표계 자체가
  // 어긋난 문제(카메라가 문서 전체와 다른 위치에 있음)를 부분적으로만
  // 보정하면 반드시 다른 부분이 깨졌다.
  //
  // 근본 해법(실제 모바일 채팅 웹뷰들이 쓰는 표준 패턴): 이 컨테이너
  // 자체를 position:fixed로 만들고, top/height를 useVisualViewportRect
  // (visualViewport.offsetTop/height 그대로 노출)로 매 resize마다
  // 직접 계산해 갱신한다. position:fixed는 원래 레이아웃 뷰포트
  // 기준이라 카메라 이동과 무관하지만, top 자체를 "지금 카메라가
  // 정확히 어디 있는지"로 다시 계산하면 컨테이너가 카메라를 그대로
  // 따라다니게 된다 — 내부의 헤더/메시지 리스트/입력창 사이 상대적
  // flex 레이아웃은 전혀 건드리지 않으므로 부분적 보정 문제 자체가
  // 생기지 않는다. viewportRect가 아직 없으면(SSR/구형 브라우저)
  // 기존 100dvh 기반 정적 레이아웃으로 폴백한다.
  // 🔧 [사용자 지시, 2026-09-20] "입력 상태에서는 다시 네비바를 끌어
  // 올릴 이유가 없잖아? ^ 표시가 보이지 않길 바란거고, 탭바 위의
  // 공백도 남겨두지 말고 툴바를 위로 끌어올려서 낭비하는 공간이
  // 없도록" — 키보드가 없을 때는 AppShell 표준 헤더("공부합시당
  // 캠스터디" + 제목)가 화면에 그대로 보이므로 그 아래(headerOffsetPx)
  // 부터 채팅 컨테이너가 시작해야 헤더와 안 겹친다. 키보드가 떠서
  // 카메라(visualViewport)가 아래로 이동하면 그 헤더 자체가 이미 화면
  // 밖으로 밀려나 안 보이므로, 이 오프셋을 그대로 유지하면 "헤더가
  // 있었을 자리"만큼 카메라 상단에 쓸모없는 빈 공간이 남는다 — 키보드가
  // 떴을 때는 헤더를 위한 공간 자체를 없애 채팅 목록/회원 목록 탭이
  // 카메라 맨 위(viewportRect.top)에 바로 붙게 한다.
  // 🔧 [버그 수정, 2026-09-20 사용자 지시: "채팅에서의 툴바 위치가 다른
  // 메뉴에서의 툴바 시작 높이랑 차이가 있어 ... 더 낮아서 공백이
  // 넓은걸 확인"] — 88px는 추측값이었다. ReportPage(다른 메뉴의 탭
  // 전환 UI)에서 실측한 탭 시작 y좌표는 74px였는데, 여기서는 88px를
  // 써서 그 차이(14px)만큼 채팅 탭이 더 아래에서 시작해 불필요한
  // 공백이 있었다 — 74px로 실측값에 맞춘다.
  // 🔧 [버그 수정, 2026-09-20 사용자 지시: "위쪽이 잘리는 현상이 전혀
  // 개선이 안됐어"] — 74px는 env(safe-area-inset-top)이 0으로 평가되던
  // (viewport-fit=cover 추가 전) 시절의 실측값이라, 그 값이 실제로
  // 반영된 이후(디버그 배지 실측: env-top 47px, header-pt 57px)에는
  // AppShell 헤더가 그만큼 더 커졌는데 이 오프셋은 그대로 남아 채팅
  // 컨테이너가 헤더 위로 겹쳐 올라갔다(=헤더가 잘려 보임). 74px 중
  // "safe-area가 0이었을 때의 순수 헤더 높이" 부분(74 - 이전
  // page-pt-safe 10px = 64px 근사)에 실측 safeAreaInsetTop을 그대로
  // 더해, safe-area 유무와 무관하게 항상 실제 헤더 높이를 따라가게
  // 한다.
  // 🔧 [버그 수정, 2026-09-20 사용자 재보고: "여전히 상위 쪽이 블러처럼
  // 뿌옇고"] — page-pt-safe(index.css)에 iOS 상태바 blur 존을 확실히
  // 벗어나기 위한 여유 14px를 추가로 더했다 — 그만큼 AppShell 헤더의
  // 실제 총 높이도 늘었으므로 여기도 동일하게 반영해야 채팅 컨테이너가
  // 다시 헤더 위로 겹치지 않는다.
  const HEADER_BLUR_MARGIN_PX = 14;
  const headerOffsetPx =
    viewportRect && viewportRect.top > 0 ? 0 : 74 + safeAreaInsetTop + HEADER_BLUR_MARGIN_PX;
  // 🔧 [사용자 지시] "키보드가 떴 동안 하단 탭바는 덮여도 무방(카카오톡
  // 방식)" — 키보드가 없을 때(viewportRect.top === 0)는 하단 탭바가
  // 화면에 그대로 보이므로 그 실측 높이만큼 채팅 박스 아래를 비워둬야
  // 겹치지 않는다. 키보드가 떠 있을 때(viewportRect.top > 0)는 탭바
  // 자체가 이미 카메라(visualViewport) 밖으로 밀려나 안 보이므로, 그
  // 자리까지 채팅 박스가 채워도 무방(오히려 그래야 입력창이 키보드
  // 바로 위까지 정확히 내려온다).
  // 🔧 [버그 수정, 2026-09-20 사용자 지시: "채팅에서는 여전히 네비바
  // 위치가 이상해"] — 펼침/접힘 각각의 실제 높이를 매직넘버(89, 24
  // 등)로 추측해왔는데, TabBar/AppShell 쪽 padding·env 계산이 바뀔
  // 때마다 계속 어긋났다(v버튼 튀어나온 부분, safe-area 여백 등을
  // 손으로 다시 맞춰야 했음). App.tsx가 AppShell의 onBarHeightChange로
  // 실측해 내려주는 tabBarHeight(prop)를 그대로 쓴다 — 매직넘버 자체가
  // 없으므로 앞으로 TabBar 쪽 스타일이 바뀌어도 자동으로 정합성이
  // 유지된다.
  const tabBarHeightPx = viewportRect && viewportRect.top > 0 ? 0 : (tabBarHeight ?? 0);
  return (
    <div
      ref={containerRef}
      hidden={!visible}
      className={cn(
        "w-full px-2.5 sm:px-4 flex",
        viewportRect ? "fixed left-1/2 -translate-x-1/2" : "justify-center"
      )}
      style={
        viewportRect
          ? {
              top: headerOffsetPx + viewportRect.top,
              height: viewportRect.height - headerOffsetPx - tabBarHeightPx,
            }
          : {
              height: `calc(100dvh - ${tabBarCollapsed ? "6.6rem" : "11.5rem"})`,
            }
      }
    >
      {/* 🔧 [버그 수정, 2026-09-20 사용자 지시: "채팅 쪽이 폭이 더 좁게
          되어있잖아? 이 부분을 '제보'에 맞춰서 크기를 확장해줘"] — 이
          바깥 div의 px-2.5 sm:px-4는 화면 가장자리 여백(다른 페이지의
          AppShell이 주는 것과 동일한 역할)이지, 콘텐츠 자체를 좁히려는
          의도가 아니었다. 그런데 이전엔 이 padding과 "page-content"
          (max-width 28rem→40rem→48rem)를 같은 요소에 함께 걸어서,
          ReportPage 등 다른 페이지(바깥 padding은 AppShell이 담당하고
          자기 자신은 순수 page-content만 갖는 구조)보다 탭바/채팅
          박스가 좌우로 padding만큼(sm 이상에서 32px) 더 좁게 보였다
          (실측: 640px 뷰포트에서 탭바 608px vs 제보 640px). page-content
          max-width는 이 padding 안쪽의 실제 콘텐츠 폭 요소로 옮겨,
          ReportPage와 동일하게 "바깥 여백은 이 wrapper, 실제 최대폭은
          안쪽 콘텐츠"로 역할을 분리한다. */}
      {/* 🔧 [버그 수정, 2026-09-20 사용자 지시: "여긴 또 왜 틀어진거야?"]
          — 넓은 화면(예: 880px, page-content max-width가 실제 뷰포트보다
          좁아지는 시점)에서 채팅 박스가 화면 왼쪽에 붙어버렸다. 이전
          구조는 max-width(page-content)와 "left-1/2 -translate-x-1/2로
          정중앙 배치"가 같은 요소에 함께 걸려 있어, max-width가 폭을
          줄여도 translate가 그 줄어든 폭의 절반만큼 자동으로 다시
          당겨줘 항상 중앙에 고정됐다. 방금 위에서 이 둘을 서로 다른
          요소로 분리하면서(바깥은 padding+중앙 배치, 안쪽은 순수
          max-width) 그 자동 중앙 정렬 메커니즘이 함께 끊어졌다 —
          안쪽 요소에 mx-auto를 명시해 같은 효과를 되살린다. */}
      <div className="w-full page-content min-h-0 flex-1 flex-col gap-2 flex mx-auto">
        {/* 🔧 [사용자 지시, 2026-09-24] "일반 회원 계정에서는 '채팅
            목록'과 '회원 목록'이 뜨질 않아 ... 우선은 구현 단계에서는
            보여주는 방향으로" — 원래 이 탭 자체가 isAdmin일 때만
            렌더링됐다(의도된 설계였음). 이제 관리자/회원 구분 없이 항상
            보여준다 — "채팅 목록"은 Stream이 로그인한 사용자 기준으로
            자동 필터링해 안전하고(회원 계정으로 조회해도 본인이 속한
            채널만 나옴), "회원 목록"의 실제 기능(임의 회원과 새 채팅
            시작)은 서버(requireAdmin)가 여전히 관리자만 허용하므로
            AdminMemberList가 isAdmin=false일 때 API 호출 자체를 건너뛰고
            안내 문구만 보여준다(위 AdminMemberList 참고) — "관리자에게만
            문의" 구조 자체는 그대로 유지된다(사용자 확인). */}
        <ChatListHeader view={sidebarView} onViewChange={setSidebarView} />
        <div className="flex w-full min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
      <Chat client={client} i18nInstance={chatI18n} theme={dark ? "str-chat__theme-dark" : "str-chat__theme-light"}>
        {/* 🔧 [사용자 지시] "상대방 아이콘을 사람 모양을 한 그림 형태로" —
            ChannelList(채널 목록)와 Channel(대화창) 둘 다 이 컴포넌트
            컨텍스트를 구독하므로, 이 둘을 함께 감싸는 최상위에
            ComponentProvider를 둬야 양쪽 모두에 적용된다(Channel 하나만
            감싸면 ChannelList의 아바타는 그대로 이니셜로 남는다 — Stream
            아키텍처상 ChannelList는 Channel의 자식이 아니라 형제라
            Channel이 제공하는 컨텍스트를 못 받는다). */}
        {/* 🔧 [사용자 지시, 2026-09-19] "'채팅' 텍스트를 지우고 탭 전환
            버튼으로" — ChannelList가 자체적으로 렌더링하는
            ChannelListHeader(Stream 기본, t("Chats")="채팅")를 완전히
            숨긴다. 이 자리는 이제 ChatListHeader(탭 버튼)가 대신한다. */}
        <ComponentProvider
          value={{
            Avatar: PersonAvatar,
            ChannelListHeader: () => null,
            Message: SwipeableMessage,
            AttachmentSelector: ImageOnlyAttachmentSelector,
            AttachmentSelectorInitiationButtonContents: ImagePlusButtonIcon,
            DateSeparator: ChatDateSeparator,
            QuotedMessage: ChatQuotedMessage,
            ContextMenu: ChatActionsContextMenu,
            // Stream 기본 PinIndicator는 원문 메시지 위에 노란 "내가 고정함"
            // 표시를 추가한다. 이 앱은 ChannelHeader 아래의
            // PinnedMessageBanner가 고정 메시지의 안내·이동·해제를 전담하므로,
            // 중복 표시와 그 레이아웃을 아예 렌더링하지 않는다.
            PinIndicator: () => null,
            MessageReactions: BottomMessageReactions,
          }}
        >
        {/* 🔧 [2026-09-20] "'채팅 목록'/'회원 목록' 토글을 다른 메뉴들처럼
            상단에 올려줘" — 예전엔 좌측 사이드바 안에 있어(ChatListHeader)
            사이드바를 접으면 토글 자체도 함께 사라졌다. ReportPage(화각
            불량 제보/PUSH 알림 전송/내 제보 확인)처럼 페이지 최상단에
            항상 보이는 위치로 옮긴다 — 이제 사이드바 접힘 여부와 무관하게
            뷰 전환이 가능하다. 실제 2단 레이아웃(목록/대화창 스플릿,
            활성 채널 여부에 따른 자동 전환)은 AdminChatArea(<Chat> 자식,
            useChatContext로 활성 채널을 구독해야 해서 별도 컴포넌트로
            분리)가 담당한다.
            🔧 [사용자 지시, 2026-09-24] 원래 여기서 isAdmin 여부로
            AdminChatArea(목록+대화창)와 회원 전용 단일 채널 뷰를 분기했다
            — 이제 관리자/회원 구분 없이 항상 AdminChatArea를 쓴다("채팅
            목록"에 회원 본인의 관리자 문의 채널이 그대로 나타난다).
            "회원 목록"의 새 채팅 시작 기능은 AdminMemberList 내부에서
            isAdmin에 따라 여전히 관리자로 제한된다. */}
        <AdminChatArea call={call} sidebarView={sidebarView} onSidebarViewChange={setSidebarView} isAdmin={isAdmin} />
        </ComponentProvider>
      </Chat>
        </div>
      </div>
    </div>
  );
}
