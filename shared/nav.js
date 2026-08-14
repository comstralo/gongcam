// 공유 네비게이션 — 페이지는 <div id="navSlot" data-active="checker"></div> 하나만 두면 된다.
// 로그인 전에는 렌더링하지 않는다(첫 진입 시 메뉴 없이 프레임 체커/로그인만 노출).
// 로그인 후에는 화면 하단 고정 탭바로 표시되며, 관리자 계정에만 "관리자" 탭이 추가로 붙는다.
// "홈" 탭은 별도 랜딩 페이지가 아니라 status.html(대시보드)을 가리킨다.

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

  const tabs = [
    { key: 'home', href: 'status.html', label: '대시보드', icon: '🏠' },
    { key: 'report', href: 'report.html', label: '제보', icon: '🚩' },
    { key: 'checker', href: 'checker.html', label: '체커', icon: '📐' },
    { key: 'settings', href: 'settings.html', label: '설정', icon: '⚙️' },
    { key: 'admin', href: 'admin.html', label: '관리자', icon: '🛠️', adminOnly: true },
  ];

  const nav = document.createElement('nav');
  nav.className = 'tabbar';

  for (const tab of tabs) {
    if (tab.adminOnly && !admin) continue;

    const a = document.createElement('a');
    a.href = tab.href;
    if (tab.key === active) a.classList.add('active');

    const icon = document.createElement('span');
    icon.className = 'tab-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = tab.icon;

    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = tab.label;

    a.appendChild(icon);
    a.appendChild(label);
    nav.appendChild(a);
  }

  slot.replaceWith(nav);
})();
