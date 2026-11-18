if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('sw.js', document.baseURI), { scope: './' }).then(async () => {
      await navigator.serviceWorker.ready;
      window.dispatchEvent(new Event('local-translator:offline-ready'));
    }).catch(() => {
      window.dispatchEvent(new CustomEvent('offline-shell-error'));
    });
  });
}
