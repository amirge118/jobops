import { postJson, requestJson } from '../shared/api-client.js';

const formatTokens = (tokens) => new Intl.NumberFormat('he-IL').format(Math.round(tokens / 1000) * 1000);

// Shown when verdicts were made under earlier preferences. Nothing is re-scored
// until the person sees the cost here and confirms.
export function createRescoreBanner({ root, feedback }) {
  let estimate = null;

  function describe(includeRejected) {
    const tokens = estimate.estimatedTokens;
    const jobs = estimate.active + (includeRejected ? estimate.rejected : 0);
    if (!tokens) return `${jobs} משרות יקבלו ציון חדש.`;
    return `${jobs} משרות יקבלו ציון חדש, בעלות משוערת של כ-${formatTokens(tokens.active + (includeRejected ? tokens.rejected : 0))} טוקנים ממכסת ה-AI שלך.`;
  }

  function render() {
    root.replaceChildren();
    root.hidden = !estimate || (!estimate.active && !estimate.rejected && !estimate.requested);
    if (root.hidden) return;
    if (estimate.requested) {
      root.append(Object.assign(document.createElement('p'), { textContent: `${estimate.requested} משרות ממתינות לניקוד מחדש בסריקה הקרובה.` }));
    }
    if (!estimate.active && !estimate.rejected) return;
    const intro = Object.assign(document.createElement('p'), { textContent: 'המידע שעליו מבוסס הציון השתנה, והציונים הקיימים נשארים כמו שהם עד שתאשר. משרות חדשות כבר מנוקדות לפי המידע החדש.' });
    const cost = Object.assign(document.createElement('p'), { textContent: describe(false) });
    const includeRejected = Object.assign(document.createElement('input'), { type: 'checkbox', id: 'rescore-rejected' });
    const rejectedLabel = Object.assign(document.createElement('label'), { htmlFor: includeRejected.id, textContent: ` לכלול ${estimate.rejected} משרות שנדחו ב-${estimate.rejectedWindowDays} הימים האחרונים. הן ייקראו שוב מהמקור, וזה חשוב כשמרחיבים את החיפוש.` });
    includeRejected.addEventListener('change', () => { cost.textContent = describe(includeRejected.checked); });
    const confirm = Object.assign(document.createElement('button'), { type: 'button', className: 'button button-small button-primary', textContent: 'ניקוד מחדש' });
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      try {
        const { marked, started } = await postJson('/api/profile/rescore', { includeRejected: includeRejected.checked });
        feedback(started ? `הניקוד מחדש של ${marked} משרות התחיל.` : `${marked} משרות ינוקדו מחדש בסריקה הקרובה.`);
        await refresh();
      } catch (error) {
        feedback(error.message, true);
        confirm.disabled = false;
      }
    });
    root.append(intro, cost);
    if (estimate.rejected) {
      const line = document.createElement('p');
      line.append(includeRejected, rejectedLabel);
      root.append(line);
    }
    root.append(confirm);
  }

  async function refresh() {
    estimate = await requestJson('/api/profile/rescore');
    render();
  }

  return { refresh };
}
