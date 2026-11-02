// welcome.html shell: mount the first-run setup into the page.
(function () {
  'use strict';
  document.addEventListener('DOMContentLoaded', () => {
    window.OneClickUI.onboarding.mount(document.getElementById('onb-root'))
      .catch((e) => console.error('Setup failed to load:', e));
  });
})();
