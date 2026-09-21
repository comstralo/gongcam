// 🔧 [2026-09-22 사용자 지시: "프론트엔드 테스트 도구도 정비해"] —
// 이 프로젝트 첫 vitest 단위 테스트. session.ts는 React에 의존하지 않는
// 순수 로직(파일 상단 주석)이고, localStorage/sessionStorage 우선순위
// 로직(saveSession의 mode 분기, getSession의 fallback 순서)이 실수하기
// 쉬운 지점이라 첫 대상으로 골랐다 — AuthContext의 "비로그인 대시보드
// 순간 노출 버그" 등 이 세션 전체가 세션 검증을 여러 번 다뤘던 만큼,
// 그 토대가 되는 저장 로직 자체는 지금까지 한 번도 직접 테스트되지
// 않았다.
import { afterEach, describe, expect, it } from "vitest";
import { clearSession, getSession, isAdmin, saveSession, type Session } from "./session";

const SESSION_KEY = "frameCheckerSession";

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("saveSession/getSession", () => {
  const session: Session = { token: "tok-1", email: "user@example.com", name: "홍길동" };

  it("mode가 persist면 localStorage에 저장하고 sessionStorage는 비운다", () => {
    saveSession(session, "persist");
    expect(localStorage.getItem(SESSION_KEY)).toBe(JSON.stringify(session));
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it("mode가 once면 sessionStorage에 저장하고 localStorage는 비운다", () => {
    saveSession(session, "once");
    expect(sessionStorage.getItem(SESSION_KEY)).toBe(JSON.stringify(session));
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it("getSession은 sessionStorage를 localStorage보다 우선한다", () => {
    // 🔧 두 저장소에 서로 다른 세션이 동시에 있는 상황(예: "1회성
    // 로그인"으로 들어온 뒤 이전 "로그인 상태 유지" 세션이 아직
    // localStorage에 남아있는 경우)을 재현 — session.ts 15행의
    // "sessionStorage || localStorage" 순서가 실제로 지켜지는지 확인.
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token: "old", email: "old@example.com" }));
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    expect(getSession()).toEqual(session);
  });

  it("아무 저장소에도 없으면 null을 반환한다", () => {
    expect(getSession()).toBeNull();
  });

  it("저장된 값이 JSON으로 파싱 불가능하면 null을 반환한다(예외를 던지지 않음)", () => {
    localStorage.setItem(SESSION_KEY, "not-json{");
    expect(getSession()).toBeNull();
  });

  it("token 또는 email이 빠진 값은 무효로 취급해 null을 반환한다", () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token: "tok-1" })); // email 없음
    expect(getSession()).toBeNull();
  });

  it("saveSession(once) 이후 getSession으로 다시 읽으면 저장한 값과 정확히 일치한다(왕복 검증)", () => {
    saveSession(session, "once");
    expect(getSession()).toEqual(session);
  });
});

describe("clearSession", () => {
  it("두 저장소 모두에서 세션을 제거한다", () => {
    localStorage.setItem(SESSION_KEY, "a");
    sessionStorage.setItem(SESSION_KEY, "b");
    clearSession();
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });
});

describe("isAdmin", () => {
  it("세션이 null이면 false다", () => {
    expect(isAdmin(null)).toBe(false);
  });

  it("관리자 이메일과 정확히 일치하면 true다", () => {
    expect(isAdmin({ token: "t", email: "comstralo@gmail.com" })).toBe(true);
  });

  it("이메일 대소문자가 달라도 true다(대소문자 무시 비교)", () => {
    expect(isAdmin({ token: "t", email: "COMSTRALO@GMAIL.COM" })).toBe(true);
  });

  it("다른 이메일이면 false다", () => {
    expect(isAdmin({ token: "t", email: "user@example.com" })).toBe(false);
  });
});
