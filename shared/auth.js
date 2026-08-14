// 공유 인증 모듈 — 세션 저장/조회/삭제, 로그인 페이지로 리다이렉트, 로그인 상태 UI 바인딩
// 로그인(Google Identity Services)은 index.html 전용이라 이 파일에 포함하지 않는다.

const Auth = (() => {
  const WORKER_BASE = 'https://frame-checker-worker.comstralo.workers.dev';
  const SESSION_KEY = 'frameCheckerSession';
  const ADMIN_EMAIL = 'comstralo@gmail.com';

  function getSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed.token || !parsed.email) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function saveSession(session, mode) {
    const serialized = JSON.stringify(session);
    if (mode === 'once') {
      sessionStorage.setItem(SESSION_KEY, serialized);
      localStorage.removeItem(SESSION_KEY);
    } else {
      localStorage.setItem(SESSION_KEY, serialized);
      sessionStorage.removeItem(SESSION_KEY);
    }
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_KEY);
  }

  function isAdmin(session) {
    return !!session && (session.email || '').toLowerCase() === ADMIN_EMAIL;
  }

  function redirectToLogin() {
    window.location.href = 'index.html';
  }

  // 세션이 없으면 즉시 로그인 페이지로 보내고, 있으면 세션을 콜백에 넘겨준다.
  // report.html/status.html/admin.html처럼 "로그인 필수" 페이지의 진입점에서 사용.
  function requireSession(onReady) {
    const session = getSession();
    if (!session) {
      redirectToLogin();
      return null;
    }
    onReady(session);
    return session;
  }

  // #sessionName, #sessionEmail, #logoutBtn 이 있는 페이지에서 세션 정보를 채우고
  // 로그아웃 버튼에 핸들러를 건다. 요소가 없는 페이지에서는 조용히 무시.
  function bindSessionUI(session, onLogout) {
    const nameEl = document.getElementById('sessionName');
    const emailEl = document.getElementById('sessionEmail');
    const logoutBtn = document.getElementById('logoutBtn');
    if (nameEl) nameEl.textContent = session.name || session.email;
    if (emailEl) emailEl.textContent = session.email;
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        clearSession();
        if (onLogout) onLogout();
        redirectToLogin();
      });
    }
  }

  function setMsg(el, text, type) {
    if (!el) return;
    el.textContent = text || '';
    el.className = 'msg' + (type ? ' ' + type : '');
  }

  return {
    WORKER_BASE,
    ADMIN_EMAIL,
    getSession,
    saveSession,
    clearSession,
    isAdmin,
    redirectToLogin,
    requireSession,
    bindSessionUI,
    setMsg,
  };
})();
