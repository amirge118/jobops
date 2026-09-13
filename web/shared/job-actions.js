import { validJobUrl } from './formatters.js';

export async function openAndArchiveJob(job, archive, openWindow = window.open.bind(window)) {
  const targetUrl = validJobUrl(job?.applyUrl);
  if (!targetUrl) throw new Error('קישור המשרה אינו תקין; המשרה לא הועברה לארכיון.');

  const tab = openWindow('about:blank', '_blank');
  if (!tab) throw new Error('Chrome חסם חלון חדש; המשרה לא הועברה לארכיון.');
  tab.opener = null;
  try {
    await archive(job.jobKey);
    tab.location.replace(targetUrl);
  } catch (error) {
    tab.close();
    throw error;
  }
}
