/* AccessibleName Inspector — popup script.
 *
 * Shows what's currently inspecting on the page (if anything), and lets the
 * user pick a check to run. The toolbar click is the only entry point;
 * the manifest's `commands` section is intentionally empty because Chrome
 * enforces a four-shortcut limit and the inspector has more than that.
 */

const api = typeof browser !== "undefined" ? browser : chrome;

const CHECK_LABELS = {
  names: "Accessible Names",
  headings: "Headings",
  landmarks: "Landmarks",
  images: "Images",
  links: "Link Text",
  aria: "ARIA Validation",
  contrast: "Colour Contrast",
  document: "Title & Language",
  tabindex: "Tabindex & Focus Order",
  forms: "Forms",
  tables: "Tables",
  iframes: "Iframes"
};

async function getActiveTab() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function refreshStatus() {
  const tab = await getActiveTab();
  const statusEl = document.getElementById("status");
  if (!tab || !tab.id) {
    statusEl.innerHTML = '<span class="nothing">No active tab.</span>';
    return;
  }
  try {
    const resp = await api.runtime.sendMessage({ type: "status", tabId: tab.id });
    if (resp && resp.active) {
      const label = CHECK_LABELS[resp.active] || resp.active;
      statusEl.innerHTML =
        '<span class="active">Showing: ' + escapeHtml(label) + '</span>' +
        ' <button id="close-btn">Close</button>';
      document.getElementById("close-btn").addEventListener("click", async () => {
        await api.runtime.sendMessage({ type: "close", tabId: tab.id });
        window.close();
      });
    } else {
      statusEl.innerHTML = '<span class="nothing">No inspection running.</span>';
    }
  } catch (e) {
    statusEl.innerHTML = '<span class="nothing">No inspection running.</span>';
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  await refreshStatus();
  document.querySelectorAll(".check").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const checkId = btn.dataset.check;
      const tab = await getActiveTab();
      if (!tab || !tab.id) return;
      await api.runtime.sendMessage({ type: "run", tabId: tab.id, checkId: checkId });
      window.close();
    });
  });
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}
