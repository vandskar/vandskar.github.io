'use strict';

// Shared site navigation. Keep the wordmark and links in one place.
(() => {
  const header = document.querySelector('header.site-header[data-shared-header]');
  if (!header) return;

  header.innerHTML = `
    <a class="wordmark" href="/" aria-label="Vandskar Advanced Systems home">
      <strong>Vandskar</strong><span>Advanced Systems</span>
    </a>
    <nav class="site-nav" aria-label="Main navigation">
      <a href="/">Home</a>
      <a href="/bifrost/">Bifrost</a>
      <a href="/about/">About</a>
      <a href="/contact/">Contact</a>
    </nav>
  `;

  const pathname = (window.location.pathname.replace(/\/+$/, '') || '/');
  for (const link of header.querySelectorAll('.site-nav a')) {
    const linkPath = new URL(link.href, window.location.href).pathname.replace(/\/+$/, '') || '/';
    if (linkPath === pathname) link.setAttribute('aria-current', 'page');
  }
})();
