// 공유 네비게이션 — 페이지는 <div id="navSlot" data-active="checker"></div> 하나만 두면 된다.
// 로그인 전에는 nav 자체를 렌더링하지 않는다(요구사항: 첫 진입 시 메뉴바 없이 프레임 체커/로그인만 노출).
// 로그인 후에는 관리자 여부에 따라 "관리자" 링크도 자동으로 붙는다.

(function renderNav() {
  const slot = document.getElementById('navSlot');
  if (!slot) return;

  const active = slot.dataset.active || '';
  const session = Auth.getSession();

  if (!session) {
    slot.remove();
    return;
  }

  const admin = Auth.isAdmin(session);

  const links = [
    { key: 'home', href: 'index.html', label: '홈' },
    { key: 'checker', href: 'checker.html', label: '프레임 체커' },
    { key: 'report', href: 'report.html', label: '제보하기' },
    { key: 'status', href: 'status.html', label: '내 상태' },
    { key: 'admin', href: 'admin.html', label: '관리자', adminOnly: true },
  ];

  const nav = document.createElement('nav');
  nav.className = 'sitenav';

  for (const link of links) {
    if (link.adminOnly && !admin) continue;

    const a = document.createElement('a');
    a.href = link.href;
    a.textContent = link.label;
    if (link.key === active) a.classList.add('active');
    nav.appendChild(a);
  }

  slot.replaceWith(nav);
})();
