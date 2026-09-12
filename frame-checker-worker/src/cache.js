// 🔧 [구조 개선, 2026-09-13] 캐시 인프라(index.js:659-1053 부근)를
// index.js에서 분리했다 — 외부에서는 _cachedCompute/invalidateMemberCache/
// invalidateMemberSlotCache 3개 wrapper로만 접근되고, 이 파일 밖의 어떤
// 함수도 _sheetCache/_inFlight/_memberCacheGeneration을 직접 참조하지
// 않는다(docs/TESTING.md 참고). leave-history 함수 3개(_readLeaveQueueIndex/
// _appendLeaveHistory/_readLeaveHistory)는 캐시 상태와 무관해(getLeaveQueueStub/
// formatYYMMDD에만 의존) 이 블록 중간에 물리적으로 끼어 있었지만 index.js에
// 그대로 남겨뒀다.


// 🔧 [429 방지 — 2계층 캐시] Sheets API 읽기 쿼터(분당 60회/사용자)를 아낀다.
// 인메모리(모듈 스코프 Map)만으로는 불충분하다는 걸 실측으로 확인했다
// (2026-08): Cloudflare Workers는 요청을 여러 독립된 isolate로 분산하고,
// 각 isolate가 자기만의 모듈 스코프를 갖기 때문에 — 브라우저 하나가 같은
// TCP 연결을 재사용하며 연달아 조회할 때만 인메모리 캐시가 히트하고,
// 서로 다른 사용자(또는 새 연결)가 요청하면 사실상 매번 캐시 미스가 나서
// 15명이 각자 접속하는 정상적인 사용 패턴에서도 분당 60회를 순식간에
// 넘겨 429가 재현됐다. 그래서 캐시를 KV(REPORTS_KV, 계정 전체에서 전역
// 공유됨)에도 함께 저장한다 — 인메모리는 "같은 isolate 안에서 즉시 재사용"
// 용도로 그대로 남기고(레이턴시 이득), KV는 "다른 isolate/사용자끼리도
// 공유" 용도로 추가한다. KV 쓰기는 하루 1,000회로 Sheets 읽기(분당 60)
// 보다 훨씬 빡빡하므로, _cacheSet은 캐시 미스가 났을 때만(=TTL 동안
// 최초 1회만) 호출되는 지금 구조를 그대로 유지해 쓰기 폭주를 피한다.
const _sheetCache = new Map(); // key -> { value, expiresAt } (인메모리, 1차)
const KV_CACHE_PREFIX = "sheetCache:";

function _cacheGet(key) {
  const entry = _sheetCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    _sheetCache.delete(key);
    return undefined;
  }
  return entry.value;
}

// KV(2차, isolate 경계를 넘어 공유됨)까지 확인하는 비동기 버전. 히트하면
// 인메모리에도 채워 같은 isolate의 다음 요청은 KV 왕복 없이 즉시 반환한다.
async function _cacheGetAsync(env, key) {
  const local = _cacheGet(key);
  if (local !== undefined) return local;
  try {
    const raw = await env.REPORTS_KV.get(`${KV_CACHE_PREFIX}${key}`);
    if (!raw) return undefined;
    const entry = JSON.parse(raw);
    if (Date.now() > entry.expiresAt) return undefined;
    _sheetCache.set(key, entry);
    return entry.value;
  } catch {
    return undefined;
  }
}

function _cacheSet(key, value, ttlMs) {
  _sheetCache.set(key, { value, expiresAt: Date.now() + ttlMs });
  // _bumpUsageCounter와 동일한 저비용 방어책 — _sheetCache는 만료된 항목을
  // "다시 읽힐 때만" 지우는 지연삭제뿐이라, 한 번 쓰고 다시 안 읽는 키는
  // isolate가 오래 살아있으면 계속 쌓일 수 있다(실무 위험은 낮지만 공짜로
  // 막을 수 있어 추가). 항목이 많아지면 이미 만료된 것들만 훑어 지운다.
  if (_sheetCache.size > 300) {
    const now = Date.now();
    for (const [k, entry] of _sheetCache) {
      if (now > entry.expiresAt) _sheetCache.delete(k);
    }
  }
}

// 인메모리 + KV 양쪽에 쓴다. KV expirationTtl은 최소 60초라는 제약이 있어,
// 그보다 짧은 ttlMs를 그대로 넘기면 Cloudflare가 에러를 낸다 — KV의 만료는
// 넉넉히(ttl의 4배 또는 최소 60초) 잡고, 실제 "몇 초짜리 캐시인지" 판단은
// 우리가 저장한 expiresAt 값으로 한다(만료된 값은 위 _cacheGetAsync가 걸러냄).
async function _cacheSetAsync(env, key, value, ttlMs) {
  _cacheSet(key, value, ttlMs);
  try {
    const expiresAt = Date.now() + ttlMs;
    await env.REPORTS_KV.put(`${KV_CACHE_PREFIX}${key}`, JSON.stringify({ value, expiresAt }), {
      expirationTtl: Math.max(60, Math.ceil((ttlMs * 4) / 1000)),
    });
  } catch {
    // KV 저장 실패해도 인메모리 캐시는 이미 세팅됐으니 이번 요청은 정상 진행한다.
  }
}

// 캐시가 비어있는 순간(콜드 상태 직후, 또는 TTL 만료 직후) 같은 isolate로
// 여러 요청이 거의 동시에 몰리면, 다들 "캐시에 없네"를 보고 각자 compute()를
// 처음부터 실행해 시트를 중복으로 읽는다(cache stampede) — 실측: 관리자
// 페이지 하나에 여러 섹션이 동시에 마운트되며 겪음(2026-08). 이미 같은
// 키를 계산 중인 Promise가 있으면 새로 계산하지 않고 그 결과를 나눠 쓰게
// 해서, 동시 요청이 몇 개든 실제 compute()는 1회만 실행되게 한다. 계산이
// 끝나면(성공/실패 무관) in-flight 등록을 지운다 — 실패를 캐시하지 않아
// 다음 요청이 재시도할 수 있게 하기 위함이다.
const _inFlight = new Map(); // key -> Promise<value>

// invalidateMemberCache/writeSheetValues의 무효화는 _inFlight를 전혀 모른다
// — 계산이 이미 진행 중일 때 무효화가 일어나면, 그 계산은 "무효화 이전
// 시점"의 낡은 데이터를 읽고 있는 셈인데 끝나고 나서 그 낡은 값을 새
// TTL로 다시 캐시에 써버려 방금 한 무효화를 무의미하게 만든다(실측 아님,
// 코드 검토로 확인된 경쟁 조건 — 2026-08). 세대 번호를 두고, 계산 시작
// 시점의 세대를 기억해뒀다가 끝난 뒤 세대가 그대로일 때만 캐시에 쓴다 —
// 계산 도중 무효화가 끼어들었으면 이번 결과는 호출자에게만 돌려주고
// 캐시는 건드리지 않아, 다음 요청이 진짜 최신 값을 다시 읽게 한다.
//
// invalidateMemberCache는 9개 prefix(members:/meta:/exitStatus:/memberRows:/
// reportScore:/outputPenSlots:/penSlotGrid:/weeklyPaidFine:/rosterStatus:)를
// 항상 통째로(부분적으로가 아니라) 무효화하므로, 이 그룹 전체에 대해 키
// 하나짜리 전역 카운터만 두면 충분하다 — 회원별로 갈라지는 outputPenSlots:/
// reportScore:는 아직 계산 중이라 특정 회원 키가 _sheetCache에 존재하지도
// 않는 시점에 무효화가 끼어들 수 있어(그래서 키별 Map으로는 놓칠 수 있음),
// "이 그룹에 속하는 키인지"만 판별해 그룹 공통 카운터를 쓰는 편이 더
// 정확하다. personalStatusBundle:(writeSheetValues가 개별 무효화)처럼
// 정확히 어떤 키를 지우는지 아는 경우는 키별 Map으로 정밀하게 추적한다.
// 🔧 [중복 캐시 통합, 2026-09-10] meritRank: 캐시 키는 폐지됐다 —
// getMeritRank가 rosterStatus:(buildRosterStatus)를 그대로 재사용하도록
// 바뀌었다(§16 참고). 이 목록에서도 제거.
// 🔧 [캐싱 통합, 2026-09] reportScore:/outputPenSlots: 캐시 키는 폐지됐다 —
// personalStatusBundle:(§getPersonalStatusBundle)이 셋(개인 탭 원본 포함)을
// 하나로 합쳐 캐싱한다. 이 목록에서도 제거(personalStatusBundle:은 회원별
// 키라 fileId당 1개를 전제하는 이 prefix 목록·MEMBER_CACHE_UNCONDITIONAL_KEYS
// 방식으로는 지울 수 없고, invalidateMemberSlotCache/invalidatePersonalStatusCache
// 가 회원 번호를 알 때 개별적으로 지운다 — 기존 personalStatus:도 항상 이
// 방식이었다).
const MEMBER_CACHE_PREFIXES = [
  "members:",
  "meta:",
  "exitStatus:",
  "memberRows:",
  "penSlotGrid:",
  "weeklyPaidFine:",
  "rosterStatus:",
  "adminMemberList:",
  "dataSheetRows:",
  "coReviewers:",
];
let _memberCacheGeneration = 0;
const _cacheGeneration = new Map(); // key -> generation number (member-cache 그룹 외의 개별 키용)

function _isMemberCacheKey(key) {
  return MEMBER_CACHE_PREFIXES.some((p) => key.startsWith(p));
}

function _currentGeneration(key) {
  return _isMemberCacheKey(key) ? _memberCacheGeneration : _cacheGeneration.get(key) || 0;
}

function _bumpCacheGeneration(key) {
  if (_isMemberCacheKey(key)) {
    _memberCacheGeneration += 1;
  } else {
    _cacheGeneration.set(key, (_cacheGeneration.get(key) || 0) + 1);
  }
}

function _bumpMemberCacheGeneration() {
  _memberCacheGeneration += 1;
}

export async function _cachedCompute(env, key, ttlMs, compute) {
  const cached = await _cacheGetAsync(env, key);
  if (cached !== undefined) return cached;

  const existing = _inFlight.get(key);
  if (existing) return existing;

  const generationAtStart = _currentGeneration(key);
  const promise = (async () => {
    try {
      const value = await compute();
      if (_currentGeneration(key) === generationAtStart) {
        await _cacheSetAsync(env, key, value, ttlMs);
      }
      return value;
    } finally {
      _inFlight.delete(key);
    }
  })();
  _inFlight.set(key, promise);
  return promise;
}

// fileId당 키가 하나뿐이라 무조건 KV .delete() 대상이 되는 종류(회원별로
// 갈라지는 outputPenSlots:/reportScore:는 별도 처리 — 아래 함수의 prefix
// 루프에서 인메모리에 존재하는 것만 지운다).
//
// 🔧 [사용자 지시, 2026-09] penCycle 추가 — 매주 앱스크립트 sheet_reset()이
// 시트에 직접 쓰는 값(집계!D25)이라 Worker 쪽 쓰기 경로가 없어 원래
// 무효화 그룹 밖이었다. 그러다 보니 "일주일에 한 번만 바뀌는 값"인데도
// TTL(5분)만큼 자주 재확인·재기록됐다 — 앱스크립트가 리셋 직후
// `_notifyWorkerCacheInvalidate({groups:["cycle"]})`로 즉시 알려주도록
// 바꾸고(study_sw/assets/appscript.js), 그 대신 TTL을 2시간으로 크게
// 늘렸다(getCurrentPenCycle). 알림이 실패해도(네트워크 오류 등) 최악의
// 경우 2시간 안에는 자연 TTL 만료로 스스로 정정된다 — 제보 승인 시
// 이 값을 슬롯에 그대로 기록하므로(applyOutputPenalty 등), 리셋 직후
// 오래 낡아있으면 잘못된 사이클 번호가 슬롯에 찍힐 위험이 있어 하루
// 종일 같은 긴 TTL 대신 2시간으로 절충했다.
const MEMBER_CACHE_UNCONDITIONAL_KEYS = ["members", "meta", "exitStatus", "memberRows", "penSlotGrid", "weeklyPaidFine", "penCycle", "rosterStatus", "adminMemberList", "dataSheetRows", "coReviewers"];

// 🔧 [불필요한 KV 삭제 절감, 2026-09] 호출부가 실제로 건드린 시트 범위에
// 맞는 그룹만 넘기면, 무관한 캐시까지 매번 함께 지우는 낭비를 피할 수 있다
// — 특히 가장 빈번한 제보 처리(penalty)가 회원 명단/시트 메타/상점 순위/
// 개인 탭 배치처럼 무관한 4종까지 매번 함께 지우고 있었다
// (docs/CACHING_POLICY.md §11 실측 근거).
const MEMBER_CACHE_GROUPS = {
  // 회원 명단/시트 구조 자체가 바뀌는 저빈도 조작(신규등록/퇴실/번호이동)
  // 전용 — 9종 전부와 관련 있으므로 groups를 생략(=전체)했을 때와 동일하다.
  // 🔧 [캐싱 통합, 2026-09] reportScore/outputPenSlots는 personalStatusBundle
  // 로 흡수됐다 — 이 그룹이 실제로 회원별 캐시까지 지우는 경로는 여전히
  // invalidateMemberSlotCache(각 호출부가 번호를 알 때 명시 호출)가 담당한다.
  roster: [...MEMBER_CACHE_UNCONDITIONAL_KEYS], // penCycle/rosterStatus/adminMemberList 포함 9종 전부
  // 제보 승인/취소/반려·유예 — 벌점(outputPenSlots)·제보상점(reportScore)
  // 슬롯만 바뀐다. 다음 슬롯 미리보기(penSlotGrid)와 퇴실 후보 판정
  // (exitStatus)도 이 슬롯을 입력으로 쓰므로 함께 포함한다.
  //
  // 🔧 [의도적 방치, 2026-09-10] rosterStatus(RANK/MY 탭이 함께 쓰는 상점·
  // 순위 캐시, §16)는 실제로 이 그룹의 변경에 영향받지만(집계 F열 수식이
  // 페널티 유무를 조건으로 삼음), 표시만 최대 30분 지연될 뿐 다른 데이터
  // 정합성엔 영향이 없다고 판단해 이 그룹에서 의도적으로 뺐다(사용자 확인,
  // 원래는 meritRank: 캐시 단독 논의였으나 §16에서 getMeritRank가
  // rosterStatus를 재사용하도록 통합되며 이 판단도 함께 적용된다).
  // 🔧 [캐싱 통합, 2026-09] outputPenSlots/reportScore가 personalStatusBundle
  // 로 흡수되며 이 그룹에서도 빠졌다 — 제보 처리 호출부는 이미 전부
  // invalidateMemberSlotCache(대상자·제보자 번호)를 함께 호출해 그 회원의
  // personalStatusBundle을 명시적으로 지운다(§invalidateMemberSlotCache 참고).
  penalty: ["exitStatus", "penSlotGrid"],
  // 벌금 납부 상태 변경 — 개인 탭 31행(납부확인)만 바뀐다.
  fine: ["exitStatus", "memberRows", "weeklyPaidFine"],
  // 퇴실 신청/동의/취소(LeaveQueue DO) — exitStatus 계산의 입력값만 바뀐다.
  exitRequest: ["exitStatus"],
  // 참여상태(부스터디장 임명 등, 개인 탭 L3) 변경. coReviewers는 이 값을
  // 그대로 캐싱한 것이라 함께 무효화해야 임명/해제가 "송출 P 대상 처리"에
  // 즉시 반영된다(§getCurrentCoReviewers 참고).
  partiStatus: ["exitStatus", "coReviewers"],
  // 앱스크립트 sheet_reset()이 매주 집계!D25(페널티 사이클)를 갱신한
  // 직후 호출하는 전용 그룹 — penCycle 하나만 좁게 지운다.
  cycle: ["penCycle"],
  // 🔧 [RANK 탭 캐싱 추가, 2026-09-10] "상금 정산 집행" 마킹(집계!P6)처럼
  // rosterStatus(buildRosterStatus 결과)에만 영향을 주는 저빈도 조작 전용.
  rosterOnly: ["rosterStatus"],
  // 🔧 [members: TTL 상향 대응, 2026-09-11] members:가 10분→2시간으로 늘면서,
  // 제보 승인(applyOutputPenalty)/제보상점 지급(applyReportMerit)이 "이
  // 닉네임/이메일이 몇 번 회원인지"를 낡은 명단으로 잘못 확정해 벌점을
  // 엉뚱한 회원(번호 재사용 시)에게 적을 위험이 생긴다 — 하루 10건 미만인
  // 저빈도 액션이라, listAllMembers 호출 직전에 이 좁은 그룹만 무효화해
  // 그 즉시 최신 명단으로 다시 계산되게 한다(§members 참고). members는
  // dataSheetRows에서 파생되므로 dataSheetRows도 함께 지워야 "새로
  // 계산하지만 재료는 낡은" 상태를 피할 수 있다. exitStatus/penSlotGrid
  // 등 무관한 캐시까지 지우는 기본 roster 그룹보다 좁게 잡아 불필요한
  // KV 삭제를 아낀다.
  memberIdentity: ["members", "dataSheetRows"],
  // 🔧 [사용자 지시, 2026-09-11] "신규 등록이 왜 벌점/벌금/사이클 캐시까지
  // 매번 지우나" — handleAdminCreateMember가 실제로 쓰는 셀은 개인탭
  // B2/I2/L3/O3와 데이터!D/E열뿐이라(시트 생성·삭제 없음), 그 범위와
  // 무관한 meta:(탭 구조)/penSlotGrid:(데이터!F~K)/weeklyPaidFine:
  // (집계!D22)/penCycle:(집계!D25, 앱스크립트 전용)은 낡지 않는다 —
  // roster 그룹(9종 전부)보다 좁혀 이 4종의 불필요한 KV 삭제를 아낀다.
  // members/dataSheetRows(이메일 D/E열)·exitStatus·memberRows(참여상태
  // L3 등)·rosterStatus(집계 수식이 B2/L3를 즉시 반영)·adminMemberList
  // (members 경유)·coReviewers(members 의존, 보수적으로 포함)는 실제로
  // 낡으므로 그대로 남긴다. 번호 재사용 시 잔존 개인별 캐시는 이 그룹과
  // 별개로 invalidateMemberSlotCache가 이미 방어한다(handleAdminCreateMember
  // 호출부 참고).
  newMember: ["members", "dataSheetRows", "exitStatus", "memberRows", "rosterStatus", "adminMemberList", "coReviewers"],
};

// 시트 구조(권한관리·데이터 D~V 등)를 바꾸는 쓰기 작업 뒤에 호출해 캐시가
// 오래된 명단/메타를 계속 돌려주지 않게 한다. 인메모리는 즉시 지우고,
// KV는 비동기로 지운다(호출부가 await하지 않아도 되도록 fire-and-forget).
// groups를 생략하면 기존과 동일하게 9종 전부를 무효화한다(안전한 기본값) —
// 호출부가 실제로 어떤 시트 범위를 바꿨는지 확실할 때만 좁은 그룹을 넘겨
// 무관한 KV 삭제를 줄인다(docs/CACHING_POLICY.md §11).
//
// 🔧 [사용자 지시, 2026-09-10] "예치금 재납/벌금 납부는 지난주 시트에도
// 쓸 수 있어야 한다" — 이 함수는 원래 KV 쪽 무조건 삭제 대상(9종 중 7종)의
// 파일 구분을 env.GOOGLE_SHEET_FILE_ID로 하드코딩하고 있었다. 벌금 처리가
// 이제 과거 사이클(백업 fileId)에도 쓸 수 있게 되면서, 그 경우 무효화도
// 같은 백업 fileId를 대상으로 해야 한다 — 기본값은 그대로 현재 시트라
// 기존 호출부(전부 세 번째 인자를 안 넘김)는 동작이 전혀 바뀌지 않는다.
export function invalidateMemberCache(env, groups, fileId) {
  const targetFileId = fileId || (env && env.GOOGLE_SHEET_FILE_ID);
  const activeKeys = groups ? [...new Set(groups.flatMap((g) => MEMBER_CACHE_GROUPS[g]))] : MEMBER_CACHE_GROUPS.roster;
  const activePrefixes = activeKeys.map((name) => `${name}:`);
  // 인메모리는 그룹 전체를 늘 세대 카운터 하나로 무효화한다(공짜 — 좁혀도
  // KV 삭제 횟수가 줄지 않으므로 아낄 이유가 없고, 좁히면 오히려 "이번엔
  // 무효화 안 된 인메모리 키가 남아있는" gap이 생길 위험만 커진다).
  // 🔧 [경쟁 조건 수정] 지금 진행 중인 계산(_inFlight, 아직 _sheetCache에
  // 없어 아래 루프에 안 걸리는 것들 포함)이 있다면, 그 계산이 끝나도
  // _cachedCompute가 세대 불일치를 감지해 캐시에 쓰지 않는다.
  _bumpMemberCacheGeneration();
  const kvDeletes = [];
  for (const key of _sheetCache.keys()) {
    if (activePrefixes.some((p) => key.startsWith(p))) {
      _sheetCache.delete(key);
      if (env) kvDeletes.push(env.REPORTS_KV.delete(`${KV_CACHE_PREFIX}${key}`).catch(() => {}));
    }
  }
  // exitStatus/memberRows/members/meta/penSlotGrid/weeklyPaidFine/rosterStatus는
  // fileId별로 키가 하나뿐이라 인메모리에 아직 없어도(다른 isolate가 채운
  // KV 항목일 수 있음) KV 쪽은 무조건 지운다 — 이번 호출이 실제로 건드린
  // 그룹에 속하는 것만.
  if (env) {
    for (const name of MEMBER_CACHE_UNCONDITIONAL_KEYS) {
      if (activeKeys.includes(name)) {
        kvDeletes.push(env.REPORTS_KV.delete(`${KV_CACHE_PREFIX}${name}:${targetFileId}`).catch(() => {}));
      }
    }
  }
  return Promise.all(kvDeletes);
}

// outputPenSlots:/reportScore:는 회원별 키라 invalidateMemberCache가 KV를
// 콕 집어 못 지운다(위 주석 참고) — 원래는 performExitReset/moveMemberSlot/
// handleAdminCreateMember(번호 재사용 대비, 2026-09)처럼 "번호 1개당 1회"만
// 실행되는 저빈도 관리자 조작에서만 호출해, 그 번호에 한해 KV까지 명시적으로
// 지웠다.
//
// 🔧 [사용자 지시, 2026-09] "제보 승인/취소 후 최대 5분/30분 지연도 즉시
// 삭제로 바꿔라" — 하루 제보 처리 건수가 많아야 10건 내외임을 확인해(건당
// 최대 2명 × 2개 캐시 = 하루 40회 미만 추가 삭제, KV 예산에 무시할 수준),
// applyOutputPenalty/applyReportMerit/cancelOutputPenalty/cancelReportMerit
// 호출부(handleAdminCaptureCancel/CancelMerit/Decide/Delete/Revert 등
// invalidateMemberCache(env, ["penalty"]) 호출 6곳)에서도 그 액션이 실제로
// 건드린 회원 번호(대상자·제보자, 최대 2명)에 한해 이 함수를 함께 호출한다
// — "번호 재사용" 대비용으로 좁게 쓰이던 함수가 이제 일반적인 제보 처리
// 경로에서도 쓰인다.
// 🔧 [사용자 지시, 2026-09-12 재점검] "벌점·상점을 제보 발생 사이클에
// 기록"으로 바뀌면서, 이 6곳 모두 fileId 인자(sourceFileId — 원본이
// 아닐 수 있음)를 반드시 함께 넘겨야 한다. 인자를 생략하면
// invalidateMemberCache/invalidateMemberSlotCache는 항상
// env.GOOGLE_SHEET_FILE_ID로 기본값이 잡히는데, 시트 쓰기는 이미
// sourceFileId(지난 사이클 백업일 수 있음)에서 이뤄진 뒤라 — 캐시만
// 엉뚱한(원본) 파일 걸 지우고 실제로 바뀐 파일의 캐시는 그대로 남아
// 최대 TTL만큼 갱신되지 않는 불일치가 있었다(실제 발견된 버그, 수정
// 완료).
// 🔧 [캐싱 통합, 2026-09] outputPenSlots/reportScore가 personalStatusBundle:
// 하나로 합쳐지면서(§getPersonalStatusBundle), 이 둘을 개별적으로 지우던
// 과거 키(outputPenSlots:/reportScore:)는 더 이상 존재하지 않는다 —
// personalStatusBundle: 하나만 지우면 셋(개인 탭 원본 포함) 다 함께
// 재계산된다.
// fileId를 생략하면 항상 "지금 진행 중인" 현재 시트(env.GOOGLE_SHEET_FILE_ID)
// 기준으로 지운다 — 기존 호출부(벌점/상점 처리 등)는 전부 현재 시트만
// 다루므로 이 기본값으로 충분하다. 과거 백업 파일도 다룰 수 있는 호출부
// (computeExitResult 등)는 실제로 조회한 sourceFileId를 명시해야 그 파일의
// 캐시가 정확히 지워진다.
export function invalidateMemberSlotCache(env, memberNumber, fileId) {
  if (!env) return Promise.resolve();
  const targetFileId = fileId || env.GOOGLE_SHEET_FILE_ID;
  const cacheKey = `personalStatusBundle:${targetFileId}:${memberNumber}`;
  _sheetCache.delete(cacheKey);
  return env.REPORTS_KV.delete(`${KV_CACHE_PREFIX}${cacheKey}`).catch(() => {});
}
