import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  RotateCcw,
  RotateCw,
  Download,
  Camera,
  FlipHorizontal2,
  ScanLine,
  RotateCcwSquare,
  TriangleAlert,
  X,
} from "lucide-react";
import { cn, ICON_STROKE } from "@/lib/utils";
import { useCamera } from "@/hooks/useCamera";
import { useFrameCapture } from "@/hooks/useFrameCapture";
import { useFitViewfinder } from "@/hooks/useFitViewfinder";
import { InfoCard } from "@/components/dashboard/shared";

// "화각 불량 제보"/"PUSH 알림 전송"의 주의사항과 동일한 패턴 — 배열이라
// 문구가 늘어나도 목록에 항목만 추가하면 된다.
const CHECKER_CAUTIONS = [
  "촬영이 시작되면 화면 앞에서 벗어나지 말고 평소 화각을 유지해 주세요.",
  "손이나 물건이 격자 밖으로 나가면 화각 불량으로 판정될 수 있습니다.",
];

export function CheckerPage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const liveCanvasRef = useRef<HTMLCanvasElement>(null);
  const resultCanvasRef = useRef<HTMLCanvasElement>(null);
  const { containerRef, size } = useFitViewfinder();

  const camera = useCamera();
  const capture = useFrameCapture({
    videoRef: camera.videoRef,
    liveCanvasRef,
    resultCanvasRef,
    stageRef,
    mirrored: camera.mirrored,
  });

  // 🔧 [사용자 지시] "모바일이나 태블릿으로 참여한 경우 뷰파인더에서
  // '기기를 가로로 눕혀주세요.' 화면을 띄워줘" — 뷰파인더는 항상 16:9라
  // 세로로 든 화면에서는 격자 칸이 비좁아져 화각 점검이 정확하지 않다.
  // 기기 회전을 유도하되, "세로 모드로 촬영할게요" 버튼으로 계속 진행할
  // 길은 열어둔다(회전이 불가능한 상황 등). 한 번 눌러 닫으면 그 세션
  // 동안은 다시 뜨지 않는다 — 회전 후 되돌아와도 안내가 반복되지 않도록.
  const [portraitWarningDismissed, setPortraitWarningDismissed] = useState(false);
  const showPortraitWarning = !portraitWarningDismissed;

  // 🔧 [사용자 지시] "주의사항을 그냥 촬영 시작 아래에 버튼으로 만들어서
  // 누르면 반투명 오버레이 형식으로 모달이 뜨도록 하자" — 세로모드는
  // 콘텐츠가 길어지면 스크롤로 대응하지만, 가로모드는 화면 높이를 고정하고
  // 스크롤을 안 쓸 계획이라 주의사항을 상시 노출하는 고정 영역으로 두면
  // 안 된다. 버튼+모달로 바꿔 필요할 때만 펼쳐 보이게 한다.
  const [cautionOpen, setCautionOpen] = useState(false);

  const isCountingDown = capture.startCountdown !== null;

  // 상호배제 규칙을 한 곳에서 파생 상태로 계산 — 산발적 disabled 토글 버그를 막기 위함
  const canSwitchCamera = !capture.isCapturing && !isCountingDown;
  const canStartSequence = camera.isReady && !isCountingDown;

  return (
    <div className="flex min-h-0 w-full flex-col items-center justify-start gap-3 mobile-portrait:min-h-[calc(100dvh-0.625rem-env(safe-area-inset-top,0px)-var(--shell-pb-portrait,96px))] mobile-landscape:min-h-0 mobile-landscape:flex-1 mobile-landscape:gap-1.5">
      {/* 🔧 [사용자 지시] "가로모드에선 화각 체커 제목을 빼자" — 가로모드는
          화면 높이가 고정이고 세로 공간이 빠듯해, 얇게 줄인 헤더도 결국
          뷰파인더/버튼 영역과 높이가 안 맞는 원인 중 하나였다. 제목은
          세로모드에서만 보이고 가로모드에서는 아예 렌더링하지 않는다. */}
      <header className="flex w-full shrink-0 page-content items-baseline justify-between gap-3 mobile-landscape:hidden">
        <div className="flex flex-col gap-0.5">
          <Link to="/" className="text-xs font-semibold tracking-tight text-primary sm:text-sm">
            공부합시당 캠스터디
          </Link>
          <h1 className="flex items-center gap-2 text-xl font-bold sm:text-2xl">
            <ScanLine className="size-5 text-primary sm:size-6" strokeWidth={ICON_STROKE.default} />
            화각 체커
          </h1>
        </div>
      </header>

      {/* 🔧 뷰파인더+썸네일+버튼을 가로모드에서 나란히 배치하기 위한 행.
          🔧 [사용자 지시] "썸네일이 버튼영역 위에 생기고 있잖아? 뷰파인더랑
          버튼 영역 사이에 세로로 쌓이게 해줘" — 썸네일 그리드를 사이드바
          (버튼 카드) 내부에서 꺼내 이 행의 독립된 형제 컬럼으로 만든다.
          items-stretch로 세 컬럼(뷰파인더/썸네일/버튼)이 항상 같은 높이를
          갖게 해 세로 정렬도 맞춘다. */}
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-3 mobile-landscape:min-w-0 mobile-landscape:flex-row mobile-landscape:items-stretch mobile-landscape:justify-center mobile-landscape:gap-2">
        {/* 뷰파인더가 차지할 수 있는 남는 공간 — ResizeObserver가 이 크기를 측정해
            16:9를 유지한 채 정확히 안에 맞는 px 크기를 계산한다. page-content로
            폭 상한을 둬 나머지 페이지 요소(헤더/컨트롤)와 폭을 맞춘다.
            🔧 [사용자 지적] "여백이 너무 커" — 세로모드는 화면이 세로로 훨씬
            길어 flex-1로 남는 세로 공간을 다 차지하면, 16:9(가로형)로 계산된
            실제 뷰파인더 박스가 그 안에서 훨씬 작게 중앙 정렬되며 위아래로
            큰 빈 공간이 생겼다 — flex-1을 빼 컨테이너가 내용물(뷰파인더 박스)
            높이만큼만 차지하게 한다. 가로모드는 반대로 남는 폭을 다 채워야
            하므로 계속 flex-1/h-full을 쓴다.
            🔧 [사용자 지적] "창을 늘려도 뷰파인더가 안 커진다" — shrink-0인
            이 컨테이너는 세로모드에서 자기 높이를 안쪽 뷰파인더 박스(아래
            div, useFitViewfinder가 계산한 size)의 현재 렌더 높이에서 그대로
            물려받는 순환 구조였다. useFitViewfinder는 "컨테이너 높이가
            부족하면 그 높이에 맞춰 축소"하는 로직인데, 컨테이너 높이 자체가
            "이전에 계산된 뷰파인더 높이"를 따라가다 보니 한 번 작은 값으로
            정착하면 창을 아무리 넓혀도 그 값에 갇혀 다시는 안 커졌다.
            aspect-video(16/9)를 컨테이너 자체에 고정해, 컨테이너 높이가
            "이 컨테이너의 폭" 기준으로만 정해지도록 순환을 끊는다 — 가로모드는
            반대로 이 컨테이너가 남는 폭을 다 채워야 하므로 aspect-ratio를
            끄고 기존 h-full/useFitViewfinder(높이 제약) 계산을 그대로 쓴다. */}
        <div
          ref={containerRef}
          className="flex min-h-0 w-full shrink-0 aspect-video page-content items-center justify-center overflow-hidden mobile-landscape:aspect-auto mobile-landscape:h-full mobile-landscape:w-0 mobile-landscape:max-w-none mobile-landscape:flex-1"
        >
          <div
            className="relative overflow-hidden rounded-lg bg-[#1b1d19] p-3.5 mobile-landscape:p-2"
            style={
              size
                ? { width: size.width, height: size.height }
                : { width: "100%", aspectRatio: "16/9" }
            }
          >
            <div ref={stageRef} className="relative size-full overflow-hidden rounded-sm bg-black">
              <video ref={camera.videoRef} autoPlay playsInline muted className="absolute inset-0 size-full object-cover" />
              <canvas
                ref={liveCanvasRef}
                className={cn("absolute inset-0 size-full object-cover pointer-events-none", capture.isFinished && "hidden")}
              />
              <canvas
                ref={resultCanvasRef}
                className={cn("absolute inset-0 size-full bg-black object-cover", !capture.isFinished && "hidden")}
              />

              {/* HUD: 촬영 시작 전 카운트다운 오버레이 — 🔧 [사용자 지시]
                  숫자만 덩그러니 있으면 무슨 카운트다운인지 맥락이 없어
                  "N초 후 촬영 시작" 문구로 보여준다(숫자를 문구 안에만
                  담아 중복 표시하지 않는다). 노란색으로 눈에 띄게 강조. */}
              {isCountingDown && (
                <div className="absolute inset-0 z-7 flex items-center justify-center bg-black/40">
                  <span
                    className="font-mono text-2xl font-bold tabular-nums text-yellow-400 sm:text-3xl"
                    style={{ textShadow: "0 2px 8px rgba(0,0,0,0.8)" }}
                  >
                    {capture.startCountdown}초 후 촬영 시작
                  </span>
                </div>
              )}

              {/* HUD: 세로 방향(휴대폰/태블릿 공통) 회전 유도 오버레이 —
                  가로모드(mobile-landscape)나 데스크탑에서는 애초에 뜨지 않고,
                  "세로 모드로 촬영할게요"를 누르면 이 세션 동안 다시 안 뜬다. */}
              {showPortraitWarning && (
                <div className="absolute inset-0 z-8 hidden portrait-any:flex flex-col items-center justify-center gap-3 bg-black/85 px-6 text-center">
                  <RotateCcwSquare className="size-8 shrink-0 text-[#eef0ea] sm:size-10" strokeWidth={ICON_STROKE.default} />
                  <span className="text-sm font-semibold text-[#eef0ea] sm:text-base">기기를 가로로 눕혀주세요.</span>
                  <button
                    type="button"
                    onClick={() => setPortraitWarningDismissed(true)}
                    className="rounded-full border border-[#eef0ea]/40 px-3.5 py-1.5 text-xs font-medium text-[#eef0ea] transition-colors hover:bg-[#eef0ea]/10 sm:text-sm"
                  >
                    세로 모드로 촬영할게요.
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 🔧 [사용자 지시] "썸네일이 버튼영역 위에 생기고 있잖아? 뷰파인더랑
            버튼 영역 사이에 세로로 쌓이게 해줘" — 세로모드는 기존처럼 사이드바
            (버튼 카드) 위에 얹혀 자연스럽게 세로로 쌓이고, 가로모드에서만
            독립된 컬럼으로 분리해 뷰파인더-썸네일-버튼 순서로 나란히 둔다.
            🔧 [사용자 지시] "썸네일도 박스를 만들어서 쌓이도록. 지금처럼
            하면 뭔가 그냥 비어있는 것 같잖아" — 뷰파인더/버튼 카드와 같은
            border+bg-card 카드로 감싸 빈 상태에서도 "여기 쌓일 자리"임이
            드러나게 한다. h-full로 다른 두 컬럼과 세로 높이를 맞춘다. */}
        {/* 🔧 [사용자 지시] "썸네일 쌓이는 순서가 위에서부터 쌓이니까 6장이
            모여도 아래에 공백이 많이 생기잖아" — 각 썸네일이 aspect-video로
            고정 높이라, 6장 미만일 때 컬럼 하단에 빈 공간이 남았다.
            grid-rows-6으로 항상 6칸을 만들어 그 칸들이 컬럼 전체 높이를
            균등하게 나눠 채우게 한다 — 몇 장을 찍었든 칸 자체가 남는
            세로 공간을 다 채우므로 하단 공백이 없다. 아직 안 찍힌 칸은
            점선 테두리의 빈 자리로 표시해 "총 6장 중 몇 번째"인지 계속
            드러난다. */}
        <div className="hidden mobile-landscape:grid mobile-landscape:h-full mobile-landscape:w-17 mobile-landscape:grid-rows-6 mobile-landscape:gap-1.5 mobile-landscape:rounded-lg mobile-landscape:border mobile-landscape:bg-card mobile-landscape:p-1.5">
          {Array.from({ length: 6 }).map((_, i) => {
            const src = capture.thumbs[i];
            return (
              <div key={i} className="relative min-h-0">
                {src ? (
                  <>
                    <img src={src} className="size-full rounded-sm border object-cover" alt={`촬영 ${i + 1}`} />
                    <span className="absolute inset-0 flex items-center justify-center rounded-sm bg-black/45">
                      <span
                        className="font-mono text-base font-bold text-white"
                        style={{ textShadow: "0 1px 4px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,0.9)" }}
                      >
                        {i + 1}
                      </span>
                    </span>
                  </>
                ) : (
                  <div className="flex size-full items-center justify-center rounded-sm border border-dashed border-border/60">
                    <span className="font-mono text-xs text-muted-foreground/60">{i + 1}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex w-full shrink-0 page-content flex-col gap-3 mobile-landscape:h-full mobile-landscape:w-auto mobile-landscape:gap-2.5">
          {/* 🔧 [사용자 지시] "즉, 지금의 버튼 박스가 차지하는 쓸데없는
              공간을 최소화 해서 썸네일 영역을 확보해야해" — 세로모드용
              썸네일 그리드는 그대로 유지(사이드바 위에 얹힘), 가로모드는
              위 독립 컬럼에서 보여주므로 여기서는 숨긴다. */}
          {capture.thumbs.length > 0 && (
            <div className="grid w-full grid-cols-6 gap-1.5 p-0.5 sm:gap-2 mobile-landscape:hidden">
              {capture.thumbs.map((src, i) => (
                <div key={i} className="relative">
                  <img src={src} className="aspect-video w-full rounded-sm border object-cover" alt={`촬영 ${i + 1}`} />
                  <span className="absolute inset-0 flex items-center justify-center rounded-sm bg-black/45">
                    <span
                      className="font-mono text-2xl font-bold text-white sm:text-3xl"
                      style={{ textShadow: "0 1px 4px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,0.9)" }}
                    >
                      {i + 1}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* 🔧 [사용자 지시] "여전히 박스 영역이랑 뷰파인더 영역 세로
              길이가 안맞잖아" — 카드가 shrink-0(암묵)인 채 부모의 h-full을
              안 받고 내용물 높이만큼만 차지해, 부모가 justify-center로
              세로 중앙에 띄워도 카드 "배경" 자체는 뷰파인더보다 짧았다.
              카드 자체에 h-full을 줘 부모 컬럼 전체 높이를 차지하게 하고,
              내부 버튼 그룹은 justify-center로 그 안에서 세로 중앙 정렬한다
              — 이제 카드 배경 테두리가 뷰파인더와 정확히 같은 높이가 된다. */}
          <div className="flex flex-col gap-3 rounded-lg border bg-card p-3.5 sm:p-5 mobile-landscape:h-full mobile-landscape:justify-center mobile-landscape:gap-2.5 mobile-landscape:overflow-y-auto mobile-landscape:px-2 mobile-landscape:py-3">
            {/* 주 액션 4버튼: 카메라 전환 / 좌우 반전 / 스크린샷 촬영 / 영상 녹화 — 항상 동일 규격 */}
            <div className="flex flex-wrap items-start justify-center gap-3 sm:gap-4 mobile-landscape:flex-col mobile-landscape:flex-nowrap mobile-landscape:items-center mobile-landscape:gap-2.5">
              <div className="flex shrink-0 flex-col items-center gap-1">
                <button
                  type="button"
                  title="카메라 전환"
                  aria-label="카메라 전환"
                  disabled={!canSwitchCamera}
                  onClick={camera.switchFacing}
                  className="flex size-9.5 shrink-0 items-center justify-center rounded-full border bg-card text-foreground disabled:opacity-40 sm:size-11"
                >
                  <RotateCw className="size-3.5 sm:size-4" />
                </button>
                <span className="text-micro-lg text-muted-foreground sm:text-xs">전면 / 후면</span>
              </div>

              <div className="flex shrink-0 flex-col items-center gap-1">
                <button
                  type="button"
                  title="좌우 반전"
                  aria-label="좌우 반전"
                  aria-pressed={camera.mirrored}
                  onClick={camera.toggleMirror}
                  className="flex size-9.5 shrink-0 items-center justify-center rounded-full border bg-card text-foreground sm:size-11"
                >
                  <FlipHorizontal2 className="size-3.5 sm:size-4" />
                </button>
                <span className="text-micro-lg text-muted-foreground sm:text-xs">거울모드</span>
              </div>

              {/* 🔧 [사용자 지시] "가로모드에서 파일 생성이 완료되면 '촬영
                  시작' 버튼을 '파일 저장' 버튼으로 재활용" — 가로모드는
                  화면 높이가 고정이라 보조 버튼 행(다시 촬영/이미지 저장)을
                  그대로 추가하면 공간을 더 차지한다. 가로모드에서만 촬영
                  완료 시 이 버튼 자리를 "파일 저장"으로 재사용하고(아래
                  mobile-landscape:flex 블록), 세로모드는 기존처럼 "촬영
                  시작" 버튼을 그대로 두고 보조 버튼 행(다시 촬영/이미지
                  저장)을 따로 쓴다(스크롤 가능해 공간 제약이 없으므로) —
                  같은 상태를 모드별로 다르게 보여줘야 해서 세로/가로용
                  버튼을 각각 렌더링하고 하나만 보이도록 hidden으로 나눈다. */}
              <div className="flex shrink-0 flex-col items-center gap-1 mobile-landscape:hidden">
                {!capture.isCapturing && !isCountingDown ? (
                  <button
                    type="button"
                    title="스크린샷 촬영 (10초 후 시작)"
                    aria-label="스크린샷 촬영"
                    disabled={!canStartSequence}
                    onClick={capture.startSequence}
                    className="flex size-9.5 shrink-0 items-center justify-center rounded-full border-2 border-primary bg-card text-primary disabled:opacity-40 sm:size-11"
                  >
                    <Camera className="size-3.5 sm:size-4" />
                  </button>
                ) : (
                  <button
                    type="button"
                    title="초기화 (촬영을 중지하고 지금까지 찍은 사진을 모두 지웁니다)"
                    aria-label="초기화"
                    onClick={capture.stopSequence}
                    className="flex size-9.5 shrink-0 items-center justify-center rounded-full border-2 border-destructive bg-card text-destructive sm:size-11"
                  >
                    <RotateCcw className="size-3.5 sm:size-4" />
                  </button>
                )}
                <span className="text-micro-lg text-muted-foreground sm:text-xs">
                  {!capture.isCapturing && !isCountingDown ? "촬영 시작" : "초기화"}
                </span>
              </div>

              <div className="hidden shrink-0 flex-col items-center gap-1 mobile-landscape:flex">
                {capture.isFinished ? (
                  <button
                    type="button"
                    title="파일 저장"
                    aria-label="파일 저장"
                    onClick={capture.downloadResult}
                    className="flex size-9.5 shrink-0 items-center justify-center rounded-full border-2 border-primary bg-card text-primary sm:size-11"
                  >
                    <Download className="size-3.5 sm:size-4" />
                  </button>
                ) : !capture.isCapturing && !isCountingDown ? (
                  <button
                    type="button"
                    title="스크린샷 촬영 (10초 후 시작)"
                    aria-label="스크린샷 촬영"
                    disabled={!canStartSequence}
                    onClick={capture.startSequence}
                    className="flex size-9.5 shrink-0 items-center justify-center rounded-full border-2 border-primary bg-card text-primary disabled:opacity-40 sm:size-11"
                  >
                    <Camera className="size-3.5 sm:size-4" />
                  </button>
                ) : (
                  <button
                    type="button"
                    title="초기화 (촬영을 중지하고 지금까지 찍은 사진을 모두 지웁니다)"
                    aria-label="초기화"
                    onClick={capture.stopSequence}
                    className="flex size-9.5 shrink-0 items-center justify-center rounded-full border-2 border-destructive bg-card text-destructive sm:size-11"
                  >
                    <RotateCcw className="size-3.5 sm:size-4" />
                  </button>
                )}
                <span className="text-micro-lg text-muted-foreground sm:text-xs">
                  {capture.isFinished
                    ? "파일 저장"
                    : !capture.isCapturing && !isCountingDown
                      ? "촬영 시작"
                      : "초기화"}
                </span>
              </div>
            </div>

            {/* 🔧 [사용자 지시] "세로모드에서는 주의사항 버튼 누르지 않아도
                아까 구현했던것처럼 표시되게 해" — 세로모드는 콘텐츠가 길어져도
                스크롤로 대응하니 주의사항을 상시 노출하는 InfoCard 그대로
                둔다. 가로모드만 화면 높이를 고정하고 스크롤을 안 쓰므로
                버튼을 눌러야 뜨는 모달로 축소한다(mobile-landscape에서만
                버튼 노출, 세로모드에서는 hidden).
                🔧 [사용자 지적] "버튼 폭이 넓어" — w-full로 사이드바
                (w-56) 폭을 그대로 채워 위 4개 원형 버튼과 비례가 안 맞았다.
                같은 사이즈의 원형 아이콘 버튼으로 통일한다. */}
            <div className="hidden shrink-0 flex-col items-center gap-1 mobile-landscape:flex">
              <button
                type="button"
                title="주의사항"
                aria-label="주의사항"
                onClick={() => setCautionOpen(true)}
                className="flex size-9.5 shrink-0 items-center justify-center rounded-full border border-amber-600/30 bg-amber-600/5 text-amber-600 transition-colors hover:bg-amber-600/10 sm:size-11 dark:border-amber-400/30 dark:bg-amber-400/5 dark:text-amber-400 dark:hover:bg-amber-400/10"
              >
                <TriangleAlert className="size-3.5 sm:size-4" />
              </button>
              <span className="text-micro-lg text-amber-600 dark:text-amber-400">주의사항</span>
            </div>

            {/* 보조 버튼: 결과물이 있을 때만 표시 — 🔧 [사용자 지시]
                가로모드는 "촬영 시작" 자리가 이미 "파일 저장"으로 바뀌므로
                여기 "이미지 저장"은 중복이라 숨긴다("다시 촬영"은 가로
                모드에도 별도 대체 수단이 없어 그대로 둔다). */}
            {capture.isFinished && (
              <div className="flex items-center justify-center gap-2.5 border-t pt-3 sm:gap-3.5 mobile-landscape:flex-col mobile-landscape:gap-2">
                <button
                  type="button"
                  title="다시 촬영"
                  aria-label="다시 촬영"
                  onClick={capture.resetSequence}
                  className="flex size-7 shrink-0 items-center justify-center rounded-full border bg-card sm:size-7.5"
                >
                  <RotateCcw className="size-3 sm:size-3.5" />
                </button>
                <button
                  type="button"
                  title="이미지 저장"
                  aria-label="이미지 저장"
                  onClick={capture.downloadResult}
                  className="flex size-7 shrink-0 items-center justify-center rounded-full border bg-card sm:size-7.5 mobile-landscape:hidden"
                >
                  <Download className="size-3 sm:size-3.5" />
                </button>
              </div>
            )}
          </div>

          {/* 🔧 [사용자 지시] "버튼 박스 내에 들어가면 안되지. 버튼 박스
              아래에 박스가 들어가야지" — 컨트롤 카드(위, border bg-card)와
              형제 레벨로, 그 카드 바로 아래에 독립된 InfoCard로 배치한다
              (세로모드 전용, 가로모드는 위 버튼+모달로 대체). */}
          <InfoCard className="flex flex-col gap-1 border-amber-600/30 bg-amber-600/5 mobile-landscape:hidden dark:border-amber-400/30 dark:bg-amber-400/5">
            <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
              <TriangleAlert className="size-3.5 shrink-0 sm:size-4" />
              <span className="text-sm font-bold sm:text-base">주의사항</span>
            </div>
            <ul className="flex flex-col gap-0.5">
              {CHECKER_CAUTIONS.map((text) => (
                <li
                  key={text}
                  className="text-xs leading-relaxed text-muted-foreground before:mr-1 before:content-['·'] sm:text-sm"
                >
                  {text}
                </li>
              ))}
            </ul>
          </InfoCard>
        </div>
      </div>

      {/* 주의사항 모달 — 반투명 오버레이, 배경 클릭 또는 X로 닫기 */}
      {cautionOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setCautionOpen(false)}
        >
          <div
            className="flex w-full max-w-sm flex-col gap-2 rounded-lg border border-amber-600/30 bg-card p-4 shadow-lg dark:border-amber-400/30"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                <TriangleAlert className="size-4 shrink-0" />
                <span className="text-base font-bold">주의사항</span>
              </div>
              <button
                type="button"
                aria-label="닫기"
                onClick={() => setCautionOpen(false)}
                className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
              >
                <X className="size-4" />
              </button>
            </div>
            <ul className="flex flex-col gap-1">
              {CHECKER_CAUTIONS.map((text) => (
                <li
                  key={text}
                  className="text-sm leading-relaxed text-muted-foreground before:mr-1 before:content-['·']"
                >
                  {text}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
