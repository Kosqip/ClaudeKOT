// installDiagnosticsLogCapture: called once by server/index.ts at startup so
// the report can include the server's recent console lines.
export { installDiagnosticsLogCapture } from '@/modules/diagnostics/services/diagnostics-report.service.js';

// Mounted at /api/diagnostics in server/index.ts, behind authenticateToken.
export { createDiagnosticsRouter } from '@/modules/diagnostics/diagnostics.routes.js';
