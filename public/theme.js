// Applies the saved theme before first paint. A separate file, because the shell's CSP allows no inline script.
try {
  const t = localStorage.getItem("binder.theme");
  if (t) document.documentElement.dataset.theme = t;
} catch {}
