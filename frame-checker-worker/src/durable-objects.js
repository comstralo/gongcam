// 🔧 [구조 개선, 2026-09-13] Durable Object 클래스 8개를 index.js에서
// 분리했다 — 각 클래스는 this.state/this.state.storage와 JS 내장 객체만
// 사용하고 index.js의 다른 헬퍼(getSheetValues, _cachedCompute,
// verifySession 등)를 전혀 호출하지 않아, 완전히 독립적으로 옮길 수
// 있었다(docs/TESTING.md "향후 구조 개선과의 관계" 참고). stub 헬퍼
// (getUsageStatsStub 등, env.BINDING.get(id)만 하는 함수)는 136개
// handle* 함수 전역에서 호출되므로 이동 범위를 최소화하기 위해
// index.js에 그대로 남겨뒀다 — getLeaveQueueStub만 사이클 판정 로직
// (resolveExitSourceFileId)이 직접 참조해 여기서 함께 export한다.

// --- 실시간 참여자 명단: 로컬 봇이 PUT으로 갱신, 제보 페이지가 GET으로 조회 ---
// KV는 쓰기 횟수가 하루 1,000회로 제한되어 수 초 간격 갱신에 부적합하므로
// 쓰기 제한이 없는 Durable Object(단일 인스턴스, 메모리 상주)를 사용한다.

const PARTICIPANTS_STALE_MS = 60 * 1000;

// 슬롯 배정 락(아래 ParticipantsRoster의 /lock/acquire)에서 한 대기자가
// 최대 기다릴 시간 — 이보다 오래 걸리면 락을 쥔 요청이 죽었거나 비정상적으로
// 지연되는 것으로 보고 대기를 포기시켜, 영구 데드락으로 이어지지 않게 한다.
// applyOutputPenalty/applyReportMerit 한 번의 실행 시간(Sheets API 호출
// 몇 번, 수백ms~수 초)보다 넉넉히 길게 잡는다.
const LOCK_WAIT_TIMEOUT_MS = 15000;

// 🔧 [버그 수정] applyOutputPenalty/applyReportMerit는 "빈 슬롯 찾기 →
// 쓰기"가 락 없는 read-modify-write라, 같은 대상자(또는 같은 제보자)에게
// 밀린 제보 여러 건을 관리자가 빠르게 연속 승인하면(백로그 정리 시 흔한
// 패턴) 둘 다 같은 빈 슬롯을 읽어 하나가 조용히 덮어써지는 레이스가 있었다.
// 이 Durable Object는 이미 단일 인스턴스로 모든 요청을 순차(직렬) 처리하는
// 성질을 그대로 이용해, 키(닉네임/제보자 이메일)별 순번 대기열을 메모리에
// 두는 최소한의 뮤텍스로 쓴다 — Sheets API 호출 자체는 여전히 Worker에서
// 하되, "acquire"(내 차례가 될 때까지 대기 후 티켓 발급)와 "release"(다음
// 대기자에게 순번 넘기기) 두 요청으로 임계구역을 감싼다.
export class ParticipantsRoster {
  constructor(state) {
    this.state = state;
    this.members = [];
    this.updatedAt = 0;
    // 🔧 [버그 수정, 2026-09-11] "교시 제한 시간도 아닌데 도움봇이 꺼져있다고
    // 뜬다"는 제보 — this.updatedAt은 순수 인메모리 필드라, Cloudflare가
    // 이 DO를 유휴 시 자동 종료했다가 다음 요청에서 새 인스턴스로 재시작시키면
    // (트래픽에 따라 수시로 일어남, 이 앱이 제어할 수 없는 플랫폼 동작)
    // updatedAt이 다시 0으로 리셋됐다 — 재시작 직후 봇은 실제로 멀쩡히
    // 동작 중인데도 "Date.now() - 0"이 항상 PARTICIPANTS_STALE_MS(60초)를
    // 넘어 stale:true를 잘못 반환하고, 다음 봇 PUT(최대 약 10~15초 이내)이
    // 오면 다시 정상화되는 패턴이었다(간헐적으로 "잠깐" 뜨는 증상과 일치).
    // DO의 영구 저장소(this.state.storage)에 매 PUT마다 updatedAt을 함께
    // 저장해두고, 재시작 시 blockConcurrencyWhile로 그 값을 복구해 재시작
    // 여부와 무관하게 "마지막으로 실제 갱신된 시각"을 정확히 유지한다 —
    // 첫 구동(진짜 아무도 PUT한 적 없음)이면 저장된 값이 없어 0 그대로
    // 유지되므로 stale:true가 맞게 나온다.
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get("updatedAt");
      if (typeof stored === "number") this.updatedAt = stored;
    });
    this.locks = new Map(); // key -> { holding: bool, queue: [resolve, ...] }
    // 🔧 [KV list() 제거, 2026-09-11] "PUSH 알림 전송"의 쿨다운(닉네임별
    // 재전송 제한)·"최근 전송된 알림" 목록을 원래 KV(notice-cooldown:/
    // noticeIndex:current)에 뒀었는데, 이 DO가 이미 "전 세계에 단 하나뿐인
    // 인스턴스"라 같은 목적(참여자 명단)에 더해 이 상태도 얹을 수 있다 —
    // KV처럼 하루 쓰기 한도(1,000회)에 걸리지 않고, get→put 사이 경합도
    // 없이(요청이 이 인스턴스로 직렬 처리됨) 원자적으로 처리된다. 만료
    // 판정용 expiresAt만 함께 저장해 매 조회 시 걸러낸다 — KV의
    // _appendToLiveIndex/_readLiveIndex와 같은 원리지만 DO 안에서는 CAS
    // 재시도 로직 자체가 필요 없다(단일 인스턴스가 이미 직렬화해주므로).
    this.notices = []; // { nickname, message, senderName, ts, expiresAt }
    // 🔧 [KV list() 무관, KV 쓰기 한도 제거, 2026-09-11] "진행 중인 제보"
    // (ActiveReportsSection, 15초 폴링)도 notices와 같은 이유로 여기로
    // 옮긴다 — cooldownKey(코드상 `cooldown:{nickname}`/
    // `selfcheck-cooldown:{email}`와 동일한 문자열을 그대로 재사용, 두
    // 종류가 섞이지 않도록) 존재 여부로 429 차단을 판정하고, 같은 배열을
    // "최근 진행된 제보" 표시에도 그대로 쓴다 — KV 시절엔 이 둘(차단 판정용
    // cooldown: 키, 표시용 COOLDOWN_INDEX_KEY 인덱스)이 서로 다른 저장소라
    // 수동으로 동기화해야 했는데(_markCaptureDoneInLiveIndex가 인덱스
    // expiresAt과 cooldown: TTL 둘 다 갱신), 여기선 한 배열이 둘 다 겸해
    // 그 동기화 자체가 필요 없어졌다.
    this.reportCooldowns = []; // { cooldownKey, id, nickname, mode, startedAt, capturedAt, expiresAt, selfCheck, reporterEmail }
    // 🔧 [KV → DO 이전, 2026-09-12] 반휴 신청 레이트리밋(leaveApplyRate:,
    // 60초 창에 최대 2회)도 notices/reportCooldowns와 동일한 이유로 이
    // DO로 옮긴다(§47) — "지금 이 순간의 상태, 없어져도 그만"이라 순수
    // 메모리로 충분하다(state.storage 영속화 불필요).
    this.leaveApplyRates = []; // { memberNumber, windowStart, count, expiresAt }
  }

  async fetch(req) {
    if (req.method === "PUT") {
      const { members } = await req.json();
      this.members = Array.isArray(members) ? members.slice(0, 200) : [];
      this.updatedAt = Date.now();
      // 이 DO가 나중에 재시작돼도 "마지막으로 실제 갱신된 시각"을 이어받을
      // 수 있도록 영구 저장소에도 함께 남긴다(위 생성자 주석 참고). 실패해도
      // 조용히 넘어간다 — 최악의 경우 다음 재시작 때만 이 문제가 재발할
      // 뿐, 이번 요청의 본 응답(멤버 목록 갱신)을 막을 이유는 아니다.
      this.state.storage.put("updatedAt", this.updatedAt).catch((e) => console.error("[ParticipantsRoster] updatedAt 영구 저장 실패:", e));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (req.method === "GET") {
      const url = new URL(req.url);
      if (url.pathname === "/notice/list") {
        const now = Date.now();
        this.notices = this.notices.filter((n) => n.expiresAt > now);
        return new Response(JSON.stringify({ items: this.notices }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/report-cooldown/list") {
        const now = Date.now();
        this.reportCooldowns = this.reportCooldowns.filter((c) => c.expiresAt > now);
        return new Response(JSON.stringify({ items: this.reportCooldowns }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      const stale = Date.now() - this.updatedAt > PARTICIPANTS_STALE_MS;
      return new Response(
        JSON.stringify({ members: this.members, updatedAt: this.updatedAt, stale }),
        { headers: { "Content-Type": "application/json" } }
      );
    }
    if (req.method === "POST") {
      const url = new URL(req.url);
      if (url.pathname === "/notice/check") {
        const { nickname } = await req.json();
        const now = Date.now();
        this.notices = this.notices.filter((n) => n.expiresAt > now);
        const onCooldown = this.notices.some((n) => n.nickname === nickname);
        return new Response(JSON.stringify({ onCooldown }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/notice/record") {
        const { nickname, message, senderName, cooldownSec } = await req.json();
        const now = Date.now();
        this.notices = this.notices.filter((n) => n.expiresAt > now);
        this.notices.push({ nickname, message, senderName, ts: now, expiresAt: now + cooldownSec * 1000 });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/leave-rate/check") {
        // 🔧 [KV → DO 이전, 2026-09-12] checkAndRecordLeaveApplyRate와
        // 동일한 고정 60초 창 로직 — true면 이번 요청 진행 가능(카운트
        // 기록 완료), false면 이번 창에서 한도(2회)를 이미 다 쓴 것(거부된
        // 시도는 카운트하지 않음).
        const { memberNumber } = await req.json();
        const now = Date.now();
        const windowMs = 60 * 1000;
        const maxCount = 2;
        this.leaveApplyRates = this.leaveApplyRates.filter((r) => r.expiresAt > now);
        const entry = this.leaveApplyRates.find((r) => r.memberNumber === memberNumber);
        if (entry) {
          if (entry.count >= maxCount) {
            return new Response(JSON.stringify({ allowed: false }), { headers: { "Content-Type": "application/json" } });
          }
          entry.count += 1;
          entry.expiresAt = entry.windowStart + windowMs;
        } else {
          this.leaveApplyRates.push({ memberNumber, windowStart: now, count: 1, expiresAt: now + windowMs });
        }
        return new Response(JSON.stringify({ allowed: true }), { headers: { "Content-Type": "application/json" } });
      }
      if (url.pathname === "/report-cooldown/check") {
        const { cooldownKey } = await req.json();
        const now = Date.now();
        this.reportCooldowns = this.reportCooldowns.filter((c) => c.expiresAt > now);
        const onCooldown = this.reportCooldowns.some((c) => c.cooldownKey === cooldownKey);
        return new Response(JSON.stringify({ onCooldown }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/report-cooldown/record") {
        const { cooldownKey, id, nickname, mode, selfCheck, reporterEmail, cooldownSec } = await req.json();
        const now = Date.now();
        this.reportCooldowns = this.reportCooldowns.filter((c) => c.expiresAt > now);
        this.reportCooldowns.push({
          cooldownKey,
          id,
          nickname,
          mode,
          startedAt: now,
          capturedAt: null,
          expiresAt: now + cooldownSec * 1000,
          selfCheck: !!selfCheck,
          reporterEmail,
        });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/report-cooldown/capture-done") {
        // 🔧 [촬영 완료 후 20분 재시작] KV 시절 _markCaptureDoneInLiveIndex와
        // 동일한 로직 — capturedAt부터 원래 쿨다운 길이(expiresAt-startedAt)
        // 만큼 다시 카운트한다. 여긴 배열 하나가 차단 판정과 표시를 겸하므로
        // KV처럼 cooldown: 키를 별도로 재기입할 필요가 없다.
        const { id, capturedAt } = await req.json();
        const now = Date.now();
        this.reportCooldowns = this.reportCooldowns.filter((c) => c.expiresAt > now || c.id === id);
        const item = this.reportCooldowns.find((c) => c.id === id);
        if (item && !item.capturedAt) {
          const cooldownSec = Math.round((item.expiresAt - item.startedAt) / 1000);
          item.capturedAt = capturedAt;
          item.expiresAt = capturedAt + cooldownSec * 1000;
        }
        this.reportCooldowns = this.reportCooldowns.filter((c) => c.expiresAt > now);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      const key = url.searchParams.get("key");
      if (!key) return new Response(JSON.stringify({ error: "key required" }), { status: 400 });
      if (url.pathname === "/lock/acquire") {
        let entry = this.locks.get(key);
        if (!entry) {
          entry = { holding: false, queue: [] };
          this.locks.set(key, entry);
        }
        if (!entry.holding) {
          entry.holding = true;
        } else {
          // 🔧 [버그 수정] 원래는 타임아웃 없이 무기한 대기했다 — 락을 쥔
          // 요청이 release 없이 죽으면(Worker 강제종료 등, 드물지만 가능)
          // entry.holding이 영원히 true로 남아 이후 같은 key의 모든 acquire가
          // 무한 대기하는 영구 데드락이 됐다. 게다가 대기자가 존재하는 것
          // 자체가 DO를 "처리 중인 요청이 남아있다"로 보이게 해, 유휴 시
          // 자연 evict(재시작으로 this.locks가 초기화되는 자가치유)조차
          // 막을 수 있었다. LOCK_WAIT_TIMEOUT_MS 안에 못 받으면 큐에서
          // 자기 항목을 직접 제거하고 "실패"로 응답해, 상위(withMemberLock)가
          // 락 없이 진행하도록 한다 — 죽은 락 보유자로 인한 무한 대기 사슬을
          // 끊는다. release가 나중에 이 항목을 next()로 깨우는 레이스를
          // 막기 위해, 깨워진 콜백이 "이미 시간초과로 빠졌는지"를 own 배열
          // 참조로 직접 확인해 제거한다(splice는 항등 비교라 안전).
          const waiter = { resolve: null };
          const waitPromise = new Promise((resolve) => {
            waiter.resolve = resolve;
            entry.queue.push(waiter);
          });
          const acquiredInTime = await Promise.race([
            waitPromise.then(() => true),
            new Promise((resolve) => setTimeout(() => resolve(false), LOCK_WAIT_TIMEOUT_MS)),
          ]);
          if (!acquiredInTime) {
            const idx = entry.queue.indexOf(waiter);
            if (idx !== -1) entry.queue.splice(idx, 1); // 아직 안 깨워졌으면 큐에서 제거.
            return new Response(JSON.stringify({ ok: false, timedOut: true }), {
              status: 503,
              headers: { "Content-Type": "application/json" },
            });
          }
        }
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      }
      if (url.pathname === "/lock/release") {
        const entry = this.locks.get(key);
        if (entry) {
          const next = entry.queue.shift();
          if (next) {
            next.resolve(); // 다음 대기자가 락을 이어받는다(holding은 계속 true).
          } else {
            entry.holding = false;
            this.locks.delete(key);
          }
        }
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      }
    }
    return new Response("method not allowed", { status: 405 });
  }
}

const KV_USAGE_WINDOW_MIN = 30; // index.js의 usage 계측 대시보드와 동일한 창 길이(index.js:324)

// 🔧 [사용량 모니터링 고도화, 2026-09-11] "하루 동안, 어느 메뉴에서, 어느
// 사용자에 의해 KV 쓰기·삭제·목록조회가 발생했는지"를 재시작에도 유지되게
// 기록하는 전용 DO. ParticipantsRoster(참여자 명단/락/공지/쿨다운)와는
// 책임이 달라 별도 클래스로 뒀다 — 이 DO는 SQL API 없이
// ParticipantsRoster의 updatedAt과 동일한 단순 key-value 패턴만 쓴다
// (회원 15명·관리자 3명 규모에서 SQL은 과함). 키는
// "{date}|{path}|{email}|{op}"(date는 todayUTCDateString과 동일한 UTC
// YYYY-MM-DD — 🔧 [사용자 지시] "UTC 기준으로 해줘야지. 결국 한도에
// 따른 사용치를 보고 싶은건데": 같은 화면 위쪽 Cloudflare 실측 게이지가
// 실제 한도 리셋 시점인 UTC 자정 기준이라 여기도 맞춤), 값은 누적 카운트
// 정수. 매 KV 호출마다 이 DO에 실시간 fetch하지 않고(오버헤드 + "감시가
// 감시 대상을 갉아먹는" 역설 방지), index.js의 _dailyUsageBuffer가 5분
// cron에서 배치로 /flush를 호출한다.
export class UsageStats {
  constructor(state) {
    this.state = state;
    this.counts = new Map(); // "{date}|{path}|{email}|{op}" -> count
    // 🔧 [사용자 지시] "이메일 말고 사용자 이름을 적고" — 처음엔
    // _emailNameMap(index.js 상단, isolate 로컬 메모리)만으로 치환했는데,
    // "이 요청을 처리한 isolate가 그 사용자를 아직 한 번도 못 봤으면"
    // 이메일이 그대로 보이는 문제가 있었다(Cloudflare가 요청을 여러
    // 서버로 분산 처리하는 한, isolate 로컬 매핑은 "일일"/"30분" 집계와
    // 똑같은 구조적 한계를 겪는다). email→name 매핑도 여기 DO에 영구
    // 저장해 isolate 무관하게 항상 알 수 있게 한다.
    this.names = new Map(); // email -> memberName
    // ParticipantsRoster의 updatedAt 복구 패턴과 동일 — 재시작 시 영구
    // 저장소에서 전량 복원한다. 항목 수가 (보관 정책상 최대 7일)×(경로
    // 수십 개)×(사용자 15명 안팎)×(연산 3종) 수준이라 전량 로드에 무리가
    // 없다.
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.list();
      for (const [key, value] of stored) {
        if (typeof value === "number") this.counts.set(key, value);
        else if (typeof value === "string" && key.startsWith("n|")) this.names.set(key.slice(2), value);
      }
    });
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/flush") {
      const { entries, today, names } = await req.json();
      const puts = [];
      for (const { date, kind, path, email, op, count } of entries || []) {
        const key = `${date}|${kind}|${path}|${email}|${op}`;
        const next = (this.counts.get(key) || 0) + count;
        this.counts.set(key, next);
        puts.push(this.state.storage.put(key, next));
      }
      for (const [email, name] of Object.entries(names || {})) {
        if (this.names.get(email) === name) continue;
        this.names.set(email, name);
        puts.push(this.state.storage.put(`n|${email}`, name));
      }
      // 보관 정책: 오늘(today, 호출부가 todayUTCDateString()로 계산해
      // 넘김) 기준 7일보다 오래된 키는 함께 정리한다 — DO 저장 공간이
      // 무한정 쌓이지 않게 하는 목적. 문자열 YYYY-MM-DD는 사전순 비교가
      // 날짜순 비교와 일치해 Date 파싱 없이 바로 비교 가능하다.
      if (today) {
        const cutoffDate = new Date(today);
        cutoffDate.setDate(cutoffDate.getDate() - 7);
        const cutoff = cutoffDate.toISOString().slice(0, 10);
        for (const key of this.counts.keys()) {
          if (key.startsWith("m|")) continue; // 분단위 키는 아래 /flush-recent가 별도 정리
          const keyDate = key.slice(0, key.indexOf("|"));
          if (keyDate < cutoff) {
            this.counts.delete(key);
            puts.push(this.state.storage.delete(key));
          }
        }
      }
      await Promise.all(puts);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    // 🔧 [사용자 지시] "일일 중에서 30분내로 발생한것만 추려서 보여주면
    // 되잖아" — /flush와 별개 엔드포인트로 분단위(m|{minuteKey}|...) 키를
    // 반영하고, 30분보다 오래된 분단위 키는 여기서 함께 정리한다(daily
    // 키와 달리 자정 넘어가는 걸 기다릴 필요 없이 즉시 정리 가능).
    if (req.method === "POST" && url.pathname === "/flush-recent") {
      const { entries } = await req.json();
      const puts = [];
      for (const { minuteKey, kind, path, email, op, count } of entries || []) {
        const key = `m|${minuteKey}|${kind}|${path}|${email}|${op}`;
        const next = (this.counts.get(key) || 0) + count;
        this.counts.set(key, next);
        puts.push(this.state.storage.put(key, next));
      }
      const cutoff = Date.now() - KV_USAGE_WINDOW_MIN * 60_000;
      for (const key of this.counts.keys()) {
        if (!key.startsWith("m|")) continue;
        const minuteKey = key.slice(2, 18); // "m|" 제거 후 "YYYY-MM-DDTHH:MM"(16자)
        if (new Date(minuteKey + ":00Z").getTime() < cutoff) {
          this.counts.delete(key);
          puts.push(this.state.storage.delete(key));
        }
      }
      await Promise.all(puts);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "GET" && url.pathname === "/today") {
      const date = url.searchParams.get("date") || "";
      const prefix = `${date}|`;
      const items = [];
      for (const [key, count] of this.counts) {
        if (key.startsWith("m|") || !key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const parts = rest.split("|");
        const op = parts.pop();
        const email = parts.pop();
        // 🔧 [사용자 지시] "일일에서도 - 뒤에 캐시 유발 지점을 출력해줘" —
        // kind를 daily 키에 추가하기 전(구버전)엔 세그먼트가 4개
        // (path|email|op는 이미 pop됨 → path만 남음)였고, 이후(신버전)엔
        // kind가 맨 앞에 하나 더 있다(5개: kind|path|email|op). 남은
        // parts 길이로 구분해 과도기의 구버전 키도 깨지지 않게 읽는다
        // (최대 7일 뒤 자연 소멸).
        const kind = parts.length > 1 ? parts.shift() : "";
        const path = parts.join("|");
        items.push({ kind, path, email, op, count });
      }
      // 🔧 [사용자 지시] "이메일 말고 사용자 이름을 적고" — names(email->name
      // 전체 매핑)도 함께 내려줘 호출부가 isolate 로컬 매핑 없이 치환할
      // 수 있게 한다.
      return new Response(JSON.stringify({ items, names: Object.fromEntries(this.names) }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    // 🔧 최근 30분(KV_USAGE_WINDOW_MIN) 이내 분단위 키만 (path·email·op)로
    // 합산해 반환한다 — isolate 로컬이던 기존 "30분" 뷰와 달리 모든
    // isolate의 기록을 DO 하나로 모은 뒤 필터링하므로 항상 완전한 값이다.
    if (req.method === "GET" && url.pathname === "/recent") {
      const cutoff = Date.now() - KV_USAGE_WINDOW_MIN * 60_000;
      const totals = new Map(); // "{kind}|{path}|{email}|{op}" -> count
      for (const [key, count] of this.counts) {
        if (!key.startsWith("m|")) continue;
        const minuteKey = key.slice(2, 18);
        const ts = Date.parse(minuteKey + ":00Z");
        if (Number.isNaN(ts) || ts < cutoff) continue;
        const groupKey = key.slice(19); // "m|" + minuteKey(16) + "|" 제거
        totals.set(groupKey, (totals.get(groupKey) || 0) + count);
      }
      const items = [...totals.entries()].map(([groupKey, count]) => {
        const parts = groupKey.split("|");
        const op = parts.pop();
        const email = parts.pop();
        const kind = parts.shift();
        const path = parts.join("|");
        return { kind, path, email, op, count };
      });
      return new Response(JSON.stringify({ items, names: Object.fromEntries(this.names) }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("method not allowed", { status: 405 });
  }
}


// 🔧 [사용자 지시, 2026-09-12] "list 말고 다른 방식으로 구현은 어려운
// 구조야 현재?" → "그럼 옮겨버려" — handleListReports(GET /reports, 10분
// 안전망 폴링)가 REPORTS_KV.list({prefix:"report:"})로 하루 대부분의
// KV list() 호출(약 144회/일)을 차지했다. 이 큐를 KV에서 이 DO로
// 옮겨 put/delete/list 세 연산 모두 KV 할당량에서 뺀다.
// docs/CACHING_POLICY.md §24.3은 "report:{id}는 DO로 옮기면 안 된다"고
// 적어뒀지만, 그 결론은 순수 메모리 DO(재시작 시 빈 상태로 리셋)에만
// 해당한다 — 여기는 UsageStats와 동일하게 state.storage를 실제로 써서
// 재시작해도 blockConcurrencyWhile로 전량 복원되므로, §24.3이 우려한
// "봇이 몇 시간 꺼져 있는 동안 안전망 큐가 소실될 위험"이 발생하지
// 않는다(사용자 확인: 기능면에서 차이 없음).
export class ReportQueue {
  constructor(state) {
    this.state = state;
    this.entries = new Map(); // id -> entry(JSON 객체, expiresAt 필드 포함)
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.list();
      for (const [id, entry] of stored) this.entries.set(id, entry);
    });
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/put") {
      const { entry, ttlSec } = await req.json();
      const expiresAt = Date.now() + ttlSec * 1000;
      const stored = { ...entry, expiresAt };
      this.entries.set(entry.id, stored);
      await this.state.storage.put(entry.id, stored);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "POST" && url.pathname === "/delete") {
      const { id } = await req.json();
      this.entries.delete(id);
      await this.state.storage.delete(id);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    // handleListReports가 하던 "list + 각 get + 각 delete + 정렬해 반환"
    // 전부를 한 번의 DO fetch로 대체한다 — 만료 안 된 항목만 반환하고
    // (KV 시절과 동일하게 "조회 즉시 소비"), 이미 만료된 항목은 반환
    // 없이 조용히 지운다(KV expirationTtl 자동 만료 대신 여기서 직접
    // 판정).
    if (req.method === "POST" && url.pathname === "/drain") {
      const now = Date.now();
      const items = [];
      const puts = [];
      for (const [id, entry] of this.entries) {
        if (entry.expiresAt > now) items.push(entry);
        this.entries.delete(id);
        puts.push(this.state.storage.delete(id));
      }
      await Promise.all(puts);
      items.sort((a, b) => a.ts - b.ts);
      return new Response(JSON.stringify({ items }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("method not allowed", { status: 405 });
  }
}


// 🔧 [사용자 지시, 2026-09-12] "전환 가능한 것들은 지금 전환하도록 하자"
// — leaveq:(사유반휴 봇 오프라인 대기열)+leaveqIndex:current, exitRequest:
// (퇴실 신청)+exitRequestIndex:current, leaveHistory:(사유반휴 처리 이력)
// 세 KV 자료구조를 한 DO로 통합 이전한다. 셋 다 "사유반휴·퇴실 처리"라는
// 같은 도메인이고 트래픽이 낮아(회원 15명, 생애주기당 수 회) 인스턴스를
// 나눌 실익이 없다 — storage 키 prefix(leaveq:/exit:/history:)로만
// 구분한다. ReportQueue와 동일하게 state.storage 기반 영속 DO라 §24.3이
// 우려한 "재시작 시 소실" 위험이 없다(§46/§47 참고).
export class LeaveQueue {
  constructor(state) {
    this.state = state;
    this.leaveq = new Map(); // id -> entry(memberNumber, memberName, day, reason, requesterEmail, imageBase64, imageExt, count, ts)
    this.exitRequests = new Map(); // memberNumber -> {exitDate, ts, agreedAt}
    this.history = new Map(); // weekOf -> array
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.list();
      for (const [key, value] of stored) {
        if (key.startsWith("leaveq:")) this.leaveq.set(key.slice(7), value);
        else if (key.startsWith("exit:")) this.exitRequests.set(key.slice(5), value);
        else if (key.startsWith("history:")) this.history.set(key.slice(8), value);
      }
    });
  }

  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/leaveq/put") {
      const { id, entry } = await req.json();
      this.leaveq.set(id, entry);
      await this.state.storage.put(`leaveq:${id}`, entry);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "POST" && url.pathname === "/leaveq/delete") {
      const { id } = await req.json();
      const existed = this.leaveq.delete(id);
      await this.state.storage.delete(`leaveq:${id}`);
      return new Response(JSON.stringify({ ok: true, existed }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "GET" && url.pathname === "/leaveq/get") {
      const id = url.searchParams.get("id") || "";
      const entry = this.leaveq.get(id);
      if (!entry) return new Response(JSON.stringify({ entry: null }), { status: 404, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ entry }), { headers: { "Content-Type": "application/json" } });
    }
    // 🔧 [응답 크기 절감] leaveq 항목은 imageBase64(증빙 사진)를 포함해
    // 최대 수 MB에 달할 수 있다 — 목록(요약)이 필요한 호출부
    // (listQueuedReasonLeaveDays/listQueuedReasonLeaveItems/취소 매칭)는
    // 이미지를 뺀 요약만 받고, 실제로 전체 데이터가 필요한
    // flushQueuedReasonLeaveProofs(봇에 그대로 전달)만 /leaveq/list-full로
    // 구분한다.
    if (req.method === "GET" && url.pathname === "/leaveq/list") {
      const items = [...this.leaveq.entries()].map(([id, entry]) => ({
        id,
        memberNumber: entry.memberNumber,
        memberName: entry.memberName,
        day: entry.day,
        reason: entry.reason,
        requesterEmail: entry.requesterEmail,
        count: entry.count || 1,
        ts: entry.ts || 0,
      }));
      return new Response(JSON.stringify({ items }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "GET" && url.pathname === "/leaveq/list-full") {
      const items = [...this.leaveq.entries()].map(([id, entry]) => ({ id, ...entry }));
      return new Response(JSON.stringify({ items }), { headers: { "Content-Type": "application/json" } });
    }

    if (req.method === "POST" && url.pathname === "/exit/put") {
      const { memberNumber, exitDate, ts, agreedAt } = await req.json();
      const entry = { exitDate: exitDate || null, ts: ts || null, agreedAt: agreedAt ?? null };
      this.exitRequests.set(memberNumber, entry);
      await this.state.storage.put(`exit:${memberNumber}`, entry);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "POST" && url.pathname === "/exit/delete") {
      const { memberNumber } = await req.json();
      this.exitRequests.delete(memberNumber);
      await this.state.storage.delete(`exit:${memberNumber}`);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "GET" && url.pathname === "/exit/get") {
      const memberNumber = url.searchParams.get("memberNumber") || "";
      const entry = this.exitRequests.get(memberNumber) || null;
      return new Response(JSON.stringify({ entry }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "GET" && url.pathname === "/exit/list") {
      const items = Object.fromEntries(this.exitRequests);
      return new Response(JSON.stringify({ items }), { headers: { "Content-Type": "application/json" } });
    }

    if (req.method === "POST" && url.pathname === "/history/append") {
      const { weekOf, entry } = await req.json();
      const arr = this.history.get(weekOf) || [];
      arr.push(entry);
      this.history.set(weekOf, arr);
      await this.state.storage.put(`history:${weekOf}`, arr);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "GET" && url.pathname === "/history/get") {
      const weekOf = url.searchParams.get("weekOf") || "";
      const items = this.history.get(weekOf) || [];
      return new Response(JSON.stringify({ items }), { headers: { "Content-Type": "application/json" } });
    }

    return new Response("method not allowed", { status: 405 });
  }
}

export function getLeaveQueueStub(env) {
  const id = env.LEAVE_QUEUE_DO.idFromName("leave-queue");
  return env.LEAVE_QUEUE_DO.get(id);
}

// 🔧 [사용자 지시, 2026-09-12] 제보 심각도 투표(부스터디장 최대 2명,
// TTL 7일) — reportVote:{id}:{num}을 이 DO로 이전. LeaveQueue와 도메인이
// 달라 별도 클래스로 분리했다.
export class ReportVote {
  constructor(state) {
    this.state = state;
    this.votes = new Map(); // "id:number" -> {name, severity, votedAt, expiresAt}
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.list();
      for (const [key, value] of stored) this.votes.set(key, value);
    });
  }

  async fetch(req) {
    const url = new URL(req.url);
    const REPORT_VOTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

    if (req.method === "POST" && url.pathname === "/vote/put") {
      const { id, number, name, severity } = await req.json();
      const key = `${id}:${number}`;
      const value = { name, severity, votedAt: Date.now(), expiresAt: Date.now() + REPORT_VOTE_TTL_MS };
      this.votes.set(key, value);
      const puts = [this.state.storage.put(key, value)];
      // 기회주의적 정리 — 이 id에 딸린 다른 투표 중 만료된 것도 함께 지운다.
      const now = Date.now();
      for (const [k, v] of this.votes) {
        if (k.startsWith(`${id}:`) && v.expiresAt <= now) {
          this.votes.delete(k);
          puts.push(this.state.storage.delete(k));
        }
      }
      await Promise.all(puts);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "POST" && url.pathname === "/vote/get-batch") {
      const { id, numbers } = await req.json();
      const now = Date.now();
      const votes = {};
      for (const number of numbers || []) {
        const v = this.votes.get(`${id}:${number}`);
        if (v && v.expiresAt > now) votes[number] = { name: v.name, severity: v.severity, votedAt: v.votedAt };
      }
      return new Response(JSON.stringify({ votes }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("method not allowed", { status: 405 });
  }
}


// 🔧 [사용자 지시, 2026-09-12] "실익이 없더라도 기능적으로 차이 없이
// 변환 가능한 구조라면 모두 변경하도록 해" — 회원 개인화 설정 3종
// (notifyPref:/statusMessage:/exitResult:)을 한 DO로 통합 이전한다.
// 셋 다 "회원 개인 데이터, 키가 회원번호/이름, TTL 없음, 트래픽 낮음
// (회원 15명 규모)"이라는 동일 프로필이라 인스턴스를 나눌 실익이 없다.
// 🔧 [사용자 지시] "기존 값이 있어도 모두 날려버려. 상관없어" — 기존
// KV 데이터는 백필하지 않는다(배포 후 초기화됨).
export class MemberSettingsDO {
  constructor(state) {
    this.state = state;
    this.prefs = new Map(); // memberNumber -> {category: boolean}
    this.statusMsgs = new Map(); // memberNumber -> string
    this.exitResults = new Map(); // "{이름} (퇴실)" -> object
    this.lastLogins = new Map(); // memberNumber -> {ts, ip}
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.list();
      for (const [key, value] of stored) {
        if (key.startsWith("pref:")) this.prefs.set(key.slice(5), value);
        else if (key.startsWith("status:")) this.statusMsgs.set(key.slice(7), value);
        else if (key.startsWith("exit:")) this.exitResults.set(key.slice(5), value);
        else if (key.startsWith("login:")) this.lastLogins.set(key.slice(6), value);
      }
    });
  }

  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/pref") {
      const memberNumber = url.searchParams.get("memberNumber") || "";
      const prefs = this.prefs.get(memberNumber) || null;
      return new Response(JSON.stringify({ prefs }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "POST" && url.pathname === "/pref") {
      const { memberNumber, prefs } = await req.json();
      this.prefs.set(memberNumber, prefs);
      await this.state.storage.put(`pref:${memberNumber}`, prefs);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    if (req.method === "GET" && url.pathname === "/status") {
      const memberNumber = url.searchParams.get("memberNumber") || "";
      const message = this.statusMsgs.get(memberNumber) || "";
      return new Response(JSON.stringify({ message }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "POST" && url.pathname === "/status") {
      const { memberNumber, message } = await req.json();
      this.statusMsgs.set(memberNumber, message);
      await this.state.storage.put(`status:${memberNumber}`, message);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "DELETE" && url.pathname === "/status") {
      const memberNumber = url.searchParams.get("memberNumber") || "";
      this.statusMsgs.delete(memberNumber);
      await this.state.storage.delete(`status:${memberNumber}`);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    if (req.method === "GET" && url.pathname === "/exit") {
      const name = url.searchParams.get("name") || "";
      const entry = this.exitResults.get(name) || null;
      return new Response(JSON.stringify({ entry }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "POST" && url.pathname === "/exit") {
      const { name, entry } = await req.json();
      this.exitResults.set(name, entry);
      await this.state.storage.put(`exit:${name}`, entry);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    // 🔧 [원자적 patch] handleAdminExitBlacklist는 기존 레코드의 blacklist
    // 필드만 뒤늦게 덮어쓴다 — DO 안에서 get+merge+put을 한 번에 처리해
    // Worker에서 get→put 사이에 다른 요청이 끼어들 여지를 없앤다(DO가
    // 요청을 직렬 처리하므로 자동으로 원자적).
    if (req.method === "POST" && url.pathname === "/exit/patch") {
      const { name, patch } = await req.json();
      const existing = this.exitResults.get(name);
      if (!existing) return new Response(JSON.stringify({ ok: false, notFound: true }), { status: 404, headers: { "Content-Type": "application/json" } });
      const updated = { ...existing, ...patch };
      this.exitResults.set(name, updated);
      await this.state.storage.put(`exit:${name}`, updated);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    // 🔧 [순회 조회 최적화] 퇴실자 전원에 대해 개별 get을 병렬 호출하던
    // 3곳(handleAdminExitedMemberList/handleAdminFinesAdminForcedCount/
    // handleAdminBlacklist)을 이 엔드포인트 1회 호출로 대체한다.
    if (req.method === "GET" && url.pathname === "/exit/list") {
      const items = Object.fromEntries(this.exitResults);
      return new Response(JSON.stringify({ items }), { headers: { "Content-Type": "application/json" } });
    }

    // 🔧 [KV → DO 이전, 2026-09-12] lastLogin:{번호}를 이 DO로 이전 —
    // "최근 접속일자·IP" 기록(로그인마다 1회 put)과 조회(관리자 "참여
    // 스터디원 목록"이 회원 전원을 병렬 get 하던 것)를 함께 옮긴다.
    if (req.method === "POST" && url.pathname === "/last-login") {
      const { memberNumber, ts, ip } = await req.json();
      const value = { ts, ip };
      this.lastLogins.set(memberNumber, value);
      await this.state.storage.put(`login:${memberNumber}`, value);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    // 🔧 [순회 조회 최적화] 회원 전원에 대해 개별 get을 병렬 호출하던
    // handleAdminMembersRoster를 이 엔드포인트 1회 호출로 대체한다.
    if (req.method === "GET" && url.pathname === "/last-login/list") {
      const items = Object.fromEntries(this.lastLogins);
      return new Response(JSON.stringify({ items }), { headers: { "Content-Type": "application/json" } });
    }

    return new Response("method not allowed", { status: 405 });
  }
}


// 🔧 [사용자 지시, 2026-09-12] PUSH_SUBS_KV 전체(구독 원본 sub:{email}:
// {hash} + 인덱스 subIndex:{email})를 이 DO로 이전한다. 도메인이
// 명확히 분리되고(웹 푸시) 항목이 상대적으로 크므로(endpoint+keys)
// 단독 DO로 둔다. 회원 15명×기기 2~3대 규모면 전체가 수십 KB 수준이라
// DO storage에 전혀 무리 없다.
export class PushSubscriptionsDO {
  constructor(state) {
    this.state = state;
    this.subs = new Map(); // "sub:{email}:{hash}" -> {email, subscription, savedAt, deviceLabel, enabled}
    this.index = new Map(); // email -> [{id, deviceLabel, enabled, savedAt}, ...]
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.list();
      for (const [key, value] of stored) {
        if (key.startsWith("sub:")) this.subs.set(key, value);
        else if (key.startsWith("idx:")) this.index.set(key.slice(4), value);
      }
    });
  }

  async fetch(req) {
    const url = new URL(req.url);

    // 🔧 [원자적 구독] 원본 put과 인덱스 갱신을 하나의 DO 호출로 합쳐
    // Worker의 withMemberLock(env, `push:${email}`, ...)을 대체한다 —
    // DO가 요청을 직렬 처리해 같은 이메일의 동시 구독 요청도 레이스
    // 없이 순서대로 처리된다.
    if (req.method === "POST" && url.pathname === "/subscribe") {
      const { email, id, deviceLabel, savedAt, subscription } = await req.json();
      const subValue = { email, subscription, savedAt, deviceLabel, enabled: true };
      this.subs.set(id, subValue);
      const devices = this.index.get(email) || [];
      const idx = devices.findIndex((d) => d.id === id);
      const entry = { id, deviceLabel, enabled: true, savedAt };
      if (idx >= 0) devices[idx] = entry;
      else devices.push(entry);
      this.index.set(email, devices);
      await Promise.all([this.state.storage.put(id, subValue), this.state.storage.put(`idx:${email}`, devices)]);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    if (req.method === "GET" && url.pathname === "/index") {
      const email = url.searchParams.get("email") || "";
      const devices = this.index.get(email) || [];
      return new Response(JSON.stringify({ devices }), { headers: { "Content-Type": "application/json" } });
    }

    if (req.method === "GET" && url.pathname === "/sub") {
      const id = url.searchParams.get("id") || "";
      const entry = this.subs.get(id) || null;
      return new Response(JSON.stringify({ entry }), { headers: { "Content-Type": "application/json" } });
    }

    if (req.method === "POST" && url.pathname === "/device/toggle") {
      const { id, enabled } = await req.json();
      const sub = this.subs.get(id);
      if (!sub) return new Response(JSON.stringify({ ok: false, notFound: true }), { status: 404, headers: { "Content-Type": "application/json" } });
      sub.enabled = !!enabled;
      const devices = this.index.get(sub.email) || [];
      const entry = devices.find((d) => d.id === id);
      if (entry) entry.enabled = !!enabled;
      await Promise.all([this.state.storage.put(id, sub), this.state.storage.put(`idx:${sub.email}`, devices)]);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    if (req.method === "POST" && url.pathname === "/device/rename") {
      const { id, deviceLabel } = await req.json();
      const sub = this.subs.get(id);
      if (!sub) return new Response(JSON.stringify({ ok: false, notFound: true }), { status: 404, headers: { "Content-Type": "application/json" } });
      sub.deviceLabel = deviceLabel;
      const devices = this.index.get(sub.email) || [];
      const entry = devices.find((d) => d.id === id);
      if (entry) entry.deviceLabel = deviceLabel;
      await Promise.all([this.state.storage.put(id, sub), this.state.storage.put(`idx:${sub.email}`, devices)]);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    if (req.method === "POST" && url.pathname === "/device/remove") {
      const { id } = await req.json();
      const sub = this.subs.get(id);
      this.subs.delete(id);
      const puts = [this.state.storage.delete(id)];
      if (sub) {
        const devices = (this.index.get(sub.email) || []).filter((d) => d.id !== id);
        this.index.set(sub.email, devices);
        puts.push(this.state.storage.put(`idx:${sub.email}`, devices));
      }
      await Promise.all(puts);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    // 🔧 [배치 정리] 발송 실패(404/410)로 죽은 구독을 정리할 때, 기존엔
    // 실패마다 개별 delete+개별 인덱스 put이었던 것을 배열로 한 번에
    // 처리한다 — email별로 인덱스 put을 한 번만 하도록 묶는다.
    if (req.method === "POST" && url.pathname === "/device/prune") {
      const { ids } = await req.json();
      const affectedEmails = new Set();
      const puts = [];
      for (const id of ids || []) {
        const sub = this.subs.get(id);
        this.subs.delete(id);
        puts.push(this.state.storage.delete(id));
        if (sub) affectedEmails.add(sub.email);
      }
      for (const email of affectedEmails) {
        const devices = (this.index.get(email) || []).filter((d) => !(ids || []).includes(d.id));
        this.index.set(email, devices);
        puts.push(this.state.storage.put(`idx:${email}`, devices));
      }
      await Promise.all(puts);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    return new Response("method not allowed", { status: 405 });
  }
}


// 🔧 [사용자 지시, 2026-09-12] 봇 터널 URL(bot:dashboard_url)과 관리자
// Google OAuth 리프레시 토큰(admin_oauth:refresh_token) — 둘 다 "설정값
// 하나, 쓰기 극히 드묾"이라는 동일 프로필. botUrl은 읽기가 매우 잦지만
// (거의 모든 봇 프록시 호출) 실측상 DO fetch(수 ms) 지연은
// proxyToBotDashboard 자체(봇 서버까지 수백ms~수초)에 비해 무시할
// 수준이라 일관성을 위해 함께 옮긴다(사용자 확인).
export class BotAdminConfigDO {
  constructor(state) {
    this.state = state;
    this.config = new Map(); // "botUrl" | "adminOAuthRefreshToken" -> string
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.list();
      for (const [key, value] of stored) this.config.set(key, value);
    });
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/config") {
      const key = url.searchParams.get("key") || "";
      const value = this.config.get(key) || null;
      return new Response(JSON.stringify({ value }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "POST" && url.pathname === "/config") {
      const { key, value } = await req.json();
      this.config.set(key, value);
      await this.state.storage.put(key, value);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("method not allowed", { status: 405 });
  }
}
