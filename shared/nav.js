// 공유 네비게이션 — 페이지는 <div id="navSlot" data-active="checker"></div> 하나만 두면 된다.
// 로그인 여부/관리자 여부에 따라 "제보하기"/"내 상태"/"관리자" 링크를 자동으로 보이거나 숨긴다.

(function renderNav() {
  const slot = document.getElementById('navSlot');
  if (!slot) return;

  const active = slot.dataset.active || '';
  const session = Auth.getSession();
  const loggedIn = !!session;
  const admin = Auth.isAdmin(session);

  const links = [
    { key: 'home', href: 'index.html', label: '홈', gate: 'public' },
    { key: 'checker', href: 'checker.html', label: '프레임 체커', gate: 'public' },
    { key: 'report', href: 'report.html', label: '제보하기', gate: 'auth' },
    { key: 'status', href: 'status.html', label: '내 상태', gate: 'auth' },
    { key: 'admin', href: 'admin.html', label: '관리자', gate: 'admin' },
  ];

  const nav = document.createElement('nav');
  nav.className = 'sitenav';

  for (const link of links) {
    if (link.gate === 'auth' && !loggedIn) continue;
    if (link.gate === 'admin' && !admin) continue;

    const a = document.createElement('a');
    a.href = link.href;
    a.textContent = link.label;
    if (link.key === active) a.classList.add('active');
    nav.appendChild(a);
  }

  slot.replaceWith(nav);
})();
