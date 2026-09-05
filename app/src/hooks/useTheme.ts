import { useEffect, useState } from "react";

const THEME_STORAGE_KEY = "theme";

// index.html의 <meta name="theme-color">(주소창/상태바 색) 기본값과 동일한
// 라이트 primary. 다크 모드일 때는 index.css .dark의 --background(카드가
// 아니라 배경색을 써야 상태바가 튀지 않는다)로 맞춘다.
const THEME_COLOR_LIGHT = "#ff5a36";
const THEME_COLOR_DARK = "#1c1917";

function applyTheme(dark: boolean) {
  document.documentElement.classList.toggle("dark", dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? THEME_COLOR_DARK : THEME_COLOR_LIGHT);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, dark ? "dark" : "light");
  } catch {
    // 시크릿 모드 등 localStorage 접근이 막힌 환경 — 이번 세션 동안만
    // 적용되고 새로고침 시 되돌아가는 것으로 감수한다.
  }
}

// index.html의 인라인 스크립트가 마운트 전에 이미 .dark 클래스를 반영해
// 두므로, 여기서는 그 결과(document.documentElement)를 초기값으로 그대로
// 읽어와 첫 렌더부터 실제 DOM 상태와 어긋나지 않게 한다.
export function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));

  useEffect(() => {
    applyTheme(dark);
  }, [dark]);

  return { dark, setDark };
}
