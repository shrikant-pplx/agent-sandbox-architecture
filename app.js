// === Theme Toggle ===
(function () {
  const toggle = document.querySelector('[data-theme-toggle]');
  const root = document.documentElement;
  let theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  root.setAttribute('data-theme', theme);

  if (toggle) {
    toggle.addEventListener('click', () => {
      theme = theme === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', theme);
    });
  }
})();

// === Navigation ===
(function () {
  const links = document.querySelectorAll('.nav-link');
  const sections = document.querySelectorAll('.section');
  const sidebar = document.getElementById('sidebar');
  const navToggle = document.getElementById('navToggle');

  function showSection(id) {
    sections.forEach(s => s.classList.remove('active'));
    links.forEach(l => l.classList.remove('active'));

    const target = document.getElementById(id);
    if (target) {
      target.classList.add('active');
      // Scroll content to top
      target.scrollIntoView({ behavior: 'instant', block: 'start' });
      window.scrollTo(0, 0);
    }

    const activeLink = document.querySelector(`.nav-link[data-section="${id}"]`);
    if (activeLink) activeLink.classList.add('active');

    // Close mobile nav
    if (window.innerWidth <= 860) {
      sidebar.classList.remove('open');
    }

    // Update URL hash without scrolling
    history.replaceState(null, '', `#${id}`);
  }

  links.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const sectionId = link.getAttribute('data-section');
      showSection(sectionId);
    });
  });

  // Mobile toggle
  if (navToggle) {
    navToggle.addEventListener('click', () => {
      sidebar.classList.toggle('open');
    });
  }

  // Close sidebar on outside click (mobile)
  document.addEventListener('click', (e) => {
    if (window.innerWidth <= 860 && sidebar.classList.contains('open')) {
      if (!sidebar.contains(e.target) && !navToggle.contains(e.target)) {
        sidebar.classList.remove('open');
      }
    }
  });

  // Handle initial hash
  const hash = window.location.hash.replace('#', '');
  if (hash && document.getElementById(hash)) {
    showSection(hash);
  }

  // Handle keyboard navigation
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && window.innerWidth <= 860) {
      sidebar.classList.remove('open');
    }
  });
})();
