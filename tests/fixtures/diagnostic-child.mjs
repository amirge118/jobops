import { createJobStore } from '../../scripts/jobs/store.mjs';
import { createRunLifecycle } from '../../scripts/jobs/diagnostics.mjs';

const store = createJobStore(process.argv[2]);
const id = store.startRun({ fromTs: 1, toTs: 2, sources: ['ats', 'whatsapp'], ownerPid: process.pid });
const lifecycle = createRunLifecycle(store, id, { registerProcessHandlers: true });
store.touchRun(id, { details: { ats: { found: 42 } } });
lifecycle.stage('whatsapp-connect', 'whatsapp');
process.send({ id });
process.on('message', () => { throw Object.assign(new Error('private-body-DO-NOT-STORE'), { code: 'EACCES' }); });
setInterval(() => {}, 1_000);
