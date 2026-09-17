// 🔧 [wrangler dev 로컬 실행 우회, 2026-09-17] 이 환경의 wrangler dev(및
// 로컬 workerd)는 진입 모듈(wrangler.toml의 main)이 "일반" named export를
// 하나라도 가지면 "Incorrect type for map entry '<이름>': the provided
// value is not of type 'function or ExportedHandler'"로 즉시 죽는 버그가
// 있다(wrangler 4.109.0~4.133.0, workerd 2026-07~2026-09 빌드 전부 재현
// 확인 — 버전 문제가 아니라 이 환경 자체의 결함). src/index.js는 다른
// 도메인 파일들이 import해 쓰는 공용 유틸을 100개 이상 export하고 있어
// 이 버그를 그대로 트리거한다.
//
// 이 얇은 파일을 wrangler.toml의 main으로 대신 지정하면(index.js는 그대로
// 두고 여기서 필요한 것만 재노출) 로컬 dev 서버가 정상 기동된다 — 실측
// 결과 Durable Object 클래스(함수/클래스 타입 export)는 이 버그를 트리거
// 하지 않고, wrangler.toml의 durable_objects.bindings가 어차피 main
// 파일에서 이들을 찾으므로 반드시 여기서도 재노출해야 한다(index.js
// 15번째 줄 주석과 동일한 이유). wrangler deploy/npm test는 이 파일과
// 무관하게 그대로 동작한다(배포는 default export만 보고, 테스트는 각
// 테스트 파일이 index.js를 직접 import하므로 main 경로를 타지 않음).
export {
  default,
  ParticipantsRoster,
  UsageStats,
  ReportQueue,
  LeaveQueue,
  ReportVote,
  MemberSettingsDO,
  PushSubscriptionsDO,
  BotAdminConfigDO,
} from "./index.js";
