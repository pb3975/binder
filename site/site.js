// Binder landing page. The page reads fully without this script; it adds copy buttons,
// the version switcher in the history model, and the current-section index tab.

// Copy buttons. Each copies its block's text exactly as shown, then says "Copied" for 1.5 s.
for (const button of document.querySelectorAll(".copy")) {
  const code = button.closest(".code").querySelector("pre");
  let timer;
  button.hidden = false;
  button.addEventListener("click", async () => {
    let ok = true;
    try {
      await navigator.clipboard.writeText(code.textContent);
    } catch {
      ok = false;
      getSelection().selectAllChildren(code); // the reader can still copy it by hand
    }
    button.dataset.state = ok ? "copied" : "failed";
    button.textContent = ok ? "Copied" : "Selected";
    clearTimeout(timer);
    timer = setTimeout(() => { button.textContent = "Copy"; delete button.dataset.state; }, 1500);
  });
}

// History model. The tiles of each version of the demo artifact "How the Job Queue Retries"
// (scripts/demo.ts). The HTML already shows the latest one.
const VERSIONS = {
  1: [["5", "max attempts"], ["2s", "base backoff"], ["1h", "dead letter after"]],
  2: [["5", "max attempts"], ["2s ± 30%", "backoff with jitter"], ["1h", "dead letter after"], ["manual", "replays"]],
  3: [["6", "max attempts"], ["1s ± 30%", "backoff with jitter"], ["2h", "dead letter after"], ["manual", "replays"]],
};
const LATEST = 3;
const viewer = document.querySelector("#viewer-mock");
if (viewer) {
  const tiles = viewer.querySelector("#vm-tiles");
  const banner = viewer.querySelector("#vm-banner");
  const status = viewer.querySelector("#vm-status");
  const rows = [...viewer.querySelectorAll(".vm-history button")];

  const show = (n) => {
    tiles.replaceChildren(...VERSIONS[n].map(([value, label]) => {
      const li = document.createElement("li");
      const b = document.createElement("b");
      b.textContent = value;
      li.append(b, label);
      return li;
    }));
    for (const row of rows) row.setAttribute("aria-pressed", String(Number(row.dataset.ver) === n));
    const text = `Viewing version ${n} of ${LATEST}, published Nov 21, 2026 by alice.`;
    banner.hidden = n === LATEST;
    viewer.querySelector("#vm-banner-text").textContent = text;
    status.textContent = n === LATEST ? `Showing the latest version, ${LATEST} of ${LATEST}.` : text;
  };

  for (const row of rows) row.addEventListener("click", () => show(Number(row.dataset.ver)));
  viewer.querySelector("#vm-latest").addEventListener("click", () => {
    show(LATEST);
    rows.find((row) => Number(row.dataset.ver) === LATEST).focus(); // the banner and its button are gone
  });
}

// Index tabs: mark the tab of the section that crosses the middle of the viewport.
const tabs = new Map([...document.querySelectorAll(".index-tabs a")].map((a) => [a.hash.slice(1), a]));
if (tabs.size && "IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const tab = tabs.get(entry.target.id);
      if (entry.isIntersecting) tab.setAttribute("aria-current", "true");
      else tab.removeAttribute("aria-current");
    }
  }, { rootMargin: "-45% 0px -54% 0px" });
  for (const id of tabs.keys()) observer.observe(document.getElementById(id));
}
