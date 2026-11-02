// The page's tabs; a tab can be opened directly with /page#tab.
export function initTabs() {
  const tabs = [...document.querySelectorAll('.profile-tabs [role="tab"]')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      for (const other of tabs) {
        const active = other === tab;
        other.setAttribute('aria-selected', String(active));
        document.querySelector(`#tab-${other.dataset.tab}`).hidden = !active;
      }
    });
  }
  const openFromHash = () => tabs.find((tab) => tab.dataset.tab === window.location.hash.slice(1))?.click();
  window.addEventListener('hashchange', openFromHash);
  openFromHash();
}
