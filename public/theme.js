// The appearance picked on this device, on the page before the first paint: no flash of the other. Kept in its own
// file so the app's Content-Security-Policy can stay script-src 'self' (no unsafe-inline). src/theme.ts keeps it in
// step after the first paint.
;(function () {
  var a = null
  try { a = localStorage.getItem('shepherdr.appearance') } catch (e) {}
  var dark = a === 'dark' || (a !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.querySelector('meta[name=theme-color]').content = dark ? '#0b0b0d' : '#ffffff'
})()
