const menuToggle = document.querySelector('.admin-menu-toggle');
const menuBackdrop = document.querySelector('.admin-menu-backdrop');
const adminNavigation = document.querySelector('#admin-navigation');
const adminSidebar = document.querySelector('.admin-sidebar');

function isMobileAdminMenu() {
  return window.matchMedia('(max-width: 780px)').matches;
}

if (menuToggle && adminNavigation) {
  menuToggle.setAttribute('aria-controls', 'admin-navigation');
}

function setMenuOpen(isOpen, returnFocus = true) {
  if (!isMobileAdminMenu()) {
    document.body.classList.remove('admin-menu-open');
    if (menuToggle) {
      menuToggle.setAttribute('aria-expanded', 'false');
      menuToggle.setAttribute('aria-label', 'Open admin menu');
    }
    if (menuBackdrop) menuBackdrop.hidden = true;
    if (adminSidebar) {
      adminSidebar.inert = false;
      adminSidebar.setAttribute('aria-hidden', 'false');
    }
    return;
  }

  document.body.classList.toggle('admin-menu-open', isOpen);
  if (menuToggle) {
    menuToggle.setAttribute('aria-expanded', String(isOpen));
    menuToggle.setAttribute('aria-label', isOpen ? 'Close admin menu' : 'Open admin menu');
  }
  if (menuBackdrop) menuBackdrop.hidden = !isOpen;
  if (adminSidebar) {
    adminSidebar.inert = !isOpen;
    adminSidebar.setAttribute('aria-hidden', String(!isOpen));
  }
  if (isOpen) {
    adminNavigation?.querySelector('a[aria-current="page"]')?.focus();
  } else if (returnFocus) {
    menuToggle?.focus();
  }
}

setMenuOpen(false, false);
window.addEventListener('resize', () => setMenuOpen(false, false));

menuToggle?.addEventListener('click', () => {
  setMenuOpen(menuToggle.getAttribute('aria-expanded') !== 'true');
});

menuBackdrop?.addEventListener('click', () => setMenuOpen(false));

adminNavigation?.addEventListener('click', event => {
  if (event.target.closest('a')) setMenuOpen(false);
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.body.classList.contains('admin-menu-open')) {
    setMenuOpen(false);
  }
});
