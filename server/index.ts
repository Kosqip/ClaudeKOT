#!/usr/bin/env node
// Load environment variables before other imports execute.
import './load-env.js';
import fs, { promises as fsPromises } from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';

import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';

import { AppError, findApplicationRoot, getModuleDirectory, IS_PLATFORM, terminalTextStyles } from '@/shared/utils.js';
import type { LLMProvider, ProviderLimitReason, RateLimitStatus } from '@/shared/types.js';
import {
    closeSessionsWatcher,
    initializeSessionsWatcher,
    providerLimitsStore,
    providerRuntimeService,
    providerTokenUsageService,
    reapOrphanedOpenCodeServers,
} from '@/modules/providers/index.js';
import { broadcastToConnectedClients, chatRunRegistry, createWebSocketServer, onRunSettled, setDefaultChatRunHooks } from '@/modules/websocket/index.js';
import {
    decideHandoffForRunFailure,
    DEFAULT_HANDOFF_THRESHOLD_PERCENT,
    handoffSessionOnLimit,
    readStoredFallbackOrder,
    releaseHandoffClaim,
    shouldHandoffForRateLimitStatus,
    suggestHandoff,
    tryClaimHandoff,
    recordSessionProviderLimit,
} from '@/modules/handoff/index.js';

import { getConnectableHost } from '../shared/networkHosts.js';

import { createGitModule } from './modules/git/index.js';
import {
    authenticateToken,
    authenticateWebSocket,
    authRoutes,
    validateApiKey,
} from './modules/auth/index.js';
import { taskmasterRoutes } from './modules/taskmaster/index.js';
import { commandsRoutes } from './modules/commands/index.js';
import { settingsRoutes } from './modules/settings/index.js';
import { createSystemModule } from './modules/system/index.js';
import { createAgentModule } from './modules/agent/index.js';
import projectModuleRoutes from './modules/projects/projects.routes.js';
import notificationRoutes from './modules/notifications/notifications.routes.js';
import { userRoutes } from './modules/user/index.js';
import {
    getPluginPort,
    pluginsRoutes,
    startEnabledPluginServers,
    stopAllPlugins,
} from './modules/plugins/index.js';
import providerRoutes from './modules/providers/provider.routes.js';
import { mixRoutes } from './modules/mix/index.js';
import { handoffRoutes } from './modules/handoff/index.js';
import {
    createOrchestratorRunDependencies,
    isOrchestratorManagedSession,
    orchestratorRoutes,
    restoreOrchestratorRuns,
} from './modules/orchestrator/index.js';
import { taskRouterRoutes } from './modules/task-router/index.js';
import { createDiagnosticsRouter, installDiagnosticsLogCapture } from './modules/diagnostics/index.js';
import { voiceRoutes } from './modules/voice/index.js';
import {
    closeScheduledMessageDispatcher,
    initializeScheduledMessageDispatcher,
    scheduledMessagesRoutes,
} from './modules/scheduled-messages/index.js';
import browserUseRoutes from './modules/browser-use/browser-use.routes.js';
import { assetsRoutes } from './modules/assets/index.js';
import { fileTreeRoutes } from './modules/file-tree/index.js';
import { worktreesRoutes } from './modules/worktrees/index.js';
import browserUseMcpRoutes from './modules/browser-use/browser-use-mcp.routes.js';
import { browserUseService } from './modules/browser-use/browser-use.service.js';
import { initializeDatabase, sessionsDb, userPreferencesDb } from './modules/database/index.js';
import { configureWebPush } from './modules/notifications/index.js';

const __dirname = getModuleDirectory(import.meta.url);
// The server source runs from /server, while the compiled output runs from /dist-server/server.
// Resolving the app root once keeps every repo-level lookup below aligned across both layouts.
const APP_ROOT = findApplicationRoot(__dirname);
const installMode = fs.existsSync(path.join(APP_ROOT, '.git')) ? 'git' : 'npm';
// Version of the code that is actually running, captured once at process
// startup. This intentionally does NOT re-read package.json per request: after
// an update replaces the files on disk, package.json reflects the NEW version
// while this long-lived process still runs the OLD code. The frontend bundle is
// rebuilt on update, so a mismatch between this value and the frontend's
// build-time version means the server was updated but not restarted.
const RUNNING_VERSION = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || null;
    } catch {
        return null;
    }
})();
const systemRoutes = createSystemModule({
    appRoot: APP_ROOT,
    installMode,
    isPlatform: IS_PLATFORM,
});
// From here on the console's recent lines are kept for the diagnostics report.
installDiagnosticsLogCapture();
console.log('SERVER_PORT from env:', process.env.SERVER_PORT);

const app = express();
const server = http.createServer(app);
const queryClaude = providerRuntimeService.getRunner('claude');
const queryCursor = providerRuntimeService.getRunner('cursor');
const queryCodex = providerRuntimeService.getRunner('codex');
const queryOpenCode = providerRuntimeService.getRunner('opencode');
const gitRoutes = createGitModule({
    queryClaude,
    queryCursor,
});
const agentRoutes = createAgentModule({
    queryClaude,
    queryCursor,
    queryCodex,
    queryOpenCode,
});

// Single WebSocket server that handles chat, shell, and plugin proxy paths.
// A completed run stays subscribable while its session's background work
// (agents, workflows, backgrounded commands) is still reporting through it.
chatRunRegistry.setRetentionGuard((sessionId) => providerRuntimeService.hasBackgroundWork(sessionId));

type AutoHandoffRequest = {
    sessionId: string;
    userId: number;
    reason: ProviderLimitReason;
    resetsAt?: string;
};

type PendingHandoffSuggestion = {
    sessionId: string;
    userId: number;
    reason: ProviderLimitReason;
    utilizationPercent?: number;
};

/**
 * Sessions whose provider crossed the user's threshold while a turn was
 * running. The offer to switch is made when that turn settles
 * (`onRunSettled` below): accepting it mid-turn would put two agents to work
 * on the same task in the same folder.
 */
const pendingHandoffSuggestions = new Map<string, PendingHandoffSuggestion>();

/**
 * Moves a session whose provider refused a request to a fallback backend,
 * which continues the interrupted work. The handoff and websocket modules
 * cannot import each other (handoff needs the websocket module to start a
 * turn), so this composition root is where a limit signal from a running
 * chat turn is turned into a `handoffSessionOnLimit` call. A session is
 * claimed first, so a limit reported several times opens one fallback
 * session, not several; a failure is logged and the claim given back, never
 * surfaced as a second error on top of the turn that already failed.
 */
function startAutoHandoff(request: AutoHandoffRequest): void {
    // A session an orchestrated task works in is not moved: the limit is
    // noted and the task itself passes the work along its role chain.
    if (isOrchestratorManagedSession(request.sessionId)) {
        recordSessionProviderLimit(request.sessionId, request.resetsAt);
        return;
    }
    if (!tryClaimHandoff(request.sessionId, 'continue')) {
        return;
    }
    pendingHandoffSuggestions.delete(request.sessionId);

    handoffSessionOnLimit(
        {
            fromSessionId: request.sessionId,
            userId: request.userId,
            reason: request.reason,
            mode: 'continue',
            resetsAt: request.resetsAt,
            fallbackOrder: readStoredFallbackOrder(request.userId),
        },
        providerRuntimeService,
    )
        .then((result) => {
            console.log('[Handoff] Session moved to a fallback backend', result);
        })
        .catch((error) => {
            releaseHandoffClaim(request.sessionId);
            console.error('[Handoff] Auto-handoff failed', { sessionId: request.sessionId, error });
        });
}

/** Reads a run's user id as the number the handoff needs; null for an unauthenticated or system-triggered run. */
function readHandoffUserId(userId: string | number | null): number | null {
    const parsed = Number(userId);
    return userId !== null && Number.isInteger(parsed) ? parsed : null;
}

/**
 * A run's error — thrown, or sent by the runtime as an `error` message, with
 * the provider's structured code when it has one — classified by
 * `decideHandoffForRunFailure`. A limit moves the session; a failure no
 * backend can fix (CLI missing, sign-in missing/expired, unknown model)
 * fails fast: no relay is started, so no fallback's limit is spent on it,
 * and the chat already shows the error labelled with its cause. Codex and
 * the API provider report limits only this way; Claude's also arrives as
 * `rate_limit_status`.
 */
function handleRunFailureForAutoHandoff(input: { provider: LLMProvider; sessionId: string; userId: string | number | null; message: string; errorCode?: string }): void {
    const decision = decideHandoffForRunFailure(input.provider, { message: input.message, errorCode: input.errorCode });
    if (decision.action === 'fail_fast') {
        pendingHandoffSuggestions.delete(input.sessionId);
        console.warn('[Handoff] Not relaying a failure no backend can fix', { sessionId: input.sessionId, provider: input.provider, cause: decision.cause });
        return;
    }
    const userId = readHandoffUserId(input.userId);
    if (decision.action !== 'handoff' || userId === null) {
        return;
    }
    startAutoHandoff({ sessionId: input.sessionId, userId, reason: decision.reason });
}

/**
 * Claude's SDK pushes a `rate_limit_status` message whenever claude.ai's
 * utilization changes, including `allowed_warning` well before any request
 * is rejected. A rejection moves the session at once and has the fallback
 * continue the interrupted work. Reaching the user's threshold
 * (`handoffThresholdPercent`, default `DEFAULT_HANDOFF_THRESHOLD_PERCENT`;
 * 100 turns this off) without a rejection starts nothing: once the running
 * turn ends the user is offered the switch, one time per session.
 */
function handleRateLimitStatusForAutoHandoff(input: { provider: LLMProvider; sessionId: string; userId: string | number | null; status: RateLimitStatus }): void {
    // Kept for Settings → Agents → Subscription limits, whoever's turn it was.
    providerLimitsStore.record(input.provider, input.status);
    const userId = readHandoffUserId(input.userId);
    if (userId === null) {
        return;
    }

    const storedThreshold = userPreferencesDb.getPreferences(userId).handoffThresholdPercent;
    const thresholdPercent = typeof storedThreshold === 'number' ? storedThreshold : DEFAULT_HANDOFF_THRESHOLD_PERCENT;

    const decision = shouldHandoffForRateLimitStatus(input.status, thresholdPercent);
    if (!decision.handoff) {
        return;
    }

    if (input.status.status === 'rejected') {
        startAutoHandoff({ sessionId: input.sessionId, userId, reason: decision.reason, resetsAt: input.status.resetsAt });
        return;
    }
    pendingHandoffSuggestions.set(input.sessionId, {
        sessionId: input.sessionId,
        userId,
        reason: decision.reason,
        utilizationPercent: typeof input.status.utilization === 'number'
            ? Math.round(input.status.utilization * 100)
            : undefined,
    });
}

/**
 * Offers the switch for a session whose turn is over, once per session
 * (`standby` is the marker; a session already moved on a refusal is not
 * offered anything). With no fallback ready the marker is given back, so a
 * later turn can offer again.
 */
function offerHandoff(pending: PendingHandoffSuggestion): void {
    if (isOrchestratorManagedSession(pending.sessionId)) {
        return;
    }
    if (!tryClaimHandoff(pending.sessionId, 'standby')) {
        return;
    }
    suggestHandoff(
        {
            fromSessionId: pending.sessionId,
            reason: pending.reason,
            utilizationPercent: pending.utilizationPercent,
            fallbackOrder: readStoredFallbackOrder(pending.userId),
        },
        providerRuntimeService,
    )
        .then((suggestion) => {
            if (!suggestion) {
                releaseHandoffClaim(pending.sessionId);
            }
        })
        .catch((error) => {
            releaseHandoffClaim(pending.sessionId);
            console.error('[Handoff] Could not offer a switch', { sessionId: pending.sessionId, error });
        });
}

onRunSettled((sessionId) => {
    const pending = pendingHandoffSuggestions.get(sessionId);
    if (pending) {
        pendingHandoffSuggestions.delete(sessionId);
        offerHandoff(pending);
    }
});

/**
 * Codex does not push its plan usage the way Claude does: it writes the
 * reading into the session's own file after each model call. When a Codex
 * turn ends that reading is read back, shown to the user like Claude's, and
 * checked against the same threshold — the turn is already over, so the
 * offer to switch can be made at once.
 */
function handleRunCompletedForUsage(input: { provider: LLMProvider; sessionId: string; userId: string | number | null }): void {
    if (input.provider !== 'codex') {
        return;
    }
    // Both windows go to the limits store; the fuller one drives the display
    // and the threshold below, as before.
    void providerTokenUsageService.getCodexRateLimitWindows(input.sessionId).then((windows) => {
        for (const window of windows) {
            providerLimitsStore.record('codex', window);
        }
    });
    void providerTokenUsageService.getCodexRateLimitStatus(input.sessionId).then((status) => {
        if (!status) {
            return;
        }
        broadcastToConnectedClients(JSON.stringify({
            kind: 'rate_limit_status',
            sessionId: input.sessionId,
            provider: 'codex',
            rateLimitStatus: status,
        }));

        const userId = readHandoffUserId(input.userId);
        if (userId === null) {
            return;
        }
        const storedThreshold = userPreferencesDb.getPreferences(userId).handoffThresholdPercent;
        const decision = shouldHandoffForRateLimitStatus(
            status,
            typeof storedThreshold === 'number' ? storedThreshold : DEFAULT_HANDOFF_THRESHOLD_PERCENT,
        );
        if (decision.handoff) {
            offerHandoff({
                sessionId: input.sessionId,
                userId,
                reason: decision.reason,
                utilizationPercent: typeof status.utilization === 'number' ? Math.round(status.utilization * 100) : undefined,
            });
        }
    });
}

// Turns the app starts itself (task router, orchestrator, mix, handoff,
// scheduled messages) report limits the same way typed ones do.
setDefaultChatRunHooks({
    onRunFailed: handleRunFailureForAutoHandoff,
    onRateLimitStatus: handleRateLimitStatusForAutoHandoff,
    onRunCompleted: handleRunCompletedForUsage,
});

createWebSocketServer(server, {
    verifyClient: {
        isPlatform: IS_PLATFORM,
        authenticateWebSocket,
    },
    chat: {
        runtime: providerRuntimeService,
        onRunFailed: handleRunFailureForAutoHandoff,
        onRateLimitStatus: handleRateLimitStatusForAutoHandoff,
        onRunCompleted: handleRunCompletedForUsage,
    },
    shell: {
        resolveProviderSessionId: (sessionId, provider) => {
            const dbSession = sessionsDb.getSessionById(sessionId);
            if (dbSession) {
                return dbSession.provider_session_id ?? null;
            }

            return null;
        },
    },
    getPluginPort,
});

app.use(cors({ exposedHeaders: ['X-Refreshed-Token', 'X-Auth-Error'] }));
app.use(express.json({
    limit: '50mb',
    type: (req) => {
        // Skip multipart/form-data requests (for file uploads like images)
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('multipart/form-data')) {
            return false;
        }
        return contentType.includes('json');
    }
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Public health check endpoint (no authentication required)
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        installMode,
        version: RUNNING_VERSION
    });
});

// Optional API key validation (if configured)
app.use('/api', validateApiKey);

// Authentication routes (public)
app.use('/api/auth', authRoutes);

// File Tree API Routes (protected)
app.use('/api/file-tree', authenticateToken, fileTreeRoutes);

// Projects API Routes (protected)
app.use('/api/projects', authenticateToken, projectModuleRoutes);

// Chat attachment upload/serving (global ~/.cloudcli/assets store, protected)
app.use('/api/assets', authenticateToken, assetsRoutes);

// Git API Routes (protected)
app.use('/api/git', authenticateToken, gitRoutes);

// Git worktree management (protected)
app.use('/api/worktrees', authenticateToken, worktreesRoutes);

// TaskMaster API Routes (protected)
app.use('/api/taskmaster', authenticateToken, taskmasterRoutes);

// Commands API Routes (protected)
app.use('/api/commands', authenticateToken, commandsRoutes);

// Settings API Routes (protected)
app.use('/api/settings', authenticateToken, settingsRoutes);

app.use('/api/system', authenticateToken, systemRoutes);

app.use('/api/notifications', authenticateToken, notificationRoutes);

// User API Routes (protected)
app.use('/api/user', authenticateToken, userRoutes);

// Plugins API Routes (protected)
app.use('/api/plugins', authenticateToken, pluginsRoutes);

// Browser MCP bridge API (local token protected)
app.use('/api/browser-use-mcp', browserUseMcpRoutes);

// Browser API Routes (protected)
app.use('/api/browser-use', authenticateToken, browserUseRoutes);

// Unified provider MCP routes (protected)
app.use('/api/providers', authenticateToken, providerRoutes);
app.use('/api/mix', authenticateToken, mixRoutes);
app.use('/api/handoff', authenticateToken, handoffRoutes);
app.use('/api/orchestrator', authenticateToken, orchestratorRoutes);
app.use('/api/task-router', authenticateToken, taskRouterRoutes);
app.use('/api/diagnostics', authenticateToken, createDiagnosticsRouter({ getVersion: () => RUNNING_VERSION, installMode }));
app.use('/api/scheduled-messages', authenticateToken, scheduledMessagesRoutes);

// Agent API Routes (uses API key authentication)
app.use('/api/agent', agentRoutes);

app.use('/api/voice', authenticateToken, voiceRoutes);

// Serve public files (like api-docs.html)
app.use(express.static(path.join(APP_ROOT, 'public')));

// Static files served after API routes
// Add cache control: HTML files should not be cached, but assets can be cached
app.use(express.static(path.join(APP_ROOT, 'dist'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            // Prevent HTML caching to avoid service worker issues after builds
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        } else if (filePath.match(/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico)$/)) {
            // Cache static assets for 1 year (they have hashed names)
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    }
}));

// API Routes (protected)
// /api/config endpoint removed - no longer needed
// Frontend now uses window.location for WebSocket URLs

// Chat uploads live under /api/assets (server/modules/assets), which stores
// images and general files in the global ~/.cloudcli/assets folder.

// Serve React app for all other routes (excluding static files)
app.get('*', (req, res) => {
    // Skip requests for static assets (files with extensions)
    if (path.extname(req.path)) {
        return res.status(404).send('Not found');
    }

    // Only serve index.html for HTML routes, not for static assets
    // Static assets should already be handled by express.static middleware above
    const indexPath = path.join(APP_ROOT, 'dist', 'index.html');

    // Check if dist/index.html exists (production build available)
    if (fs.existsSync(indexPath)) {
        // Set no-cache headers for HTML to prevent service worker issues
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.sendFile(indexPath);
    } else {
        // In development, redirect to Vite dev server only if dist doesn't exist
        const redirectHost = getConnectableHost(req.hostname);
        res.redirect(`${req.protocol}://${redirectHost}:${VITE_PORT}`);
    }
});

// global error middleware must be last
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  console.error(err);

  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  });
});

const SERVER_PORT = Number.parseInt(process.env.SERVER_PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DISPLAY_HOST = getConnectableHost(HOST);
const VITE_PORT = process.env.VITE_PORT || 5173;
const LOCAL_SERVER_MARKER_PATH = path.join(os.homedir(), '.cloudcli', 'local-server.json');

function getErrorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
        return undefined;
    }
    return String(error.code);
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function writeLocalServerMarker() {
    const marker = {
        pid: process.pid,
        host: HOST,
        port: Number.parseInt(String(SERVER_PORT), 10),
        url: `http://${DISPLAY_HOST}:${SERVER_PORT}`,
        installMode,
        appRoot: APP_ROOT,
        updatedAt: new Date().toISOString(),
    };

    await fsPromises.mkdir(path.dirname(LOCAL_SERVER_MARKER_PATH), { recursive: true });
    await fsPromises.writeFile(LOCAL_SERVER_MARKER_PATH, JSON.stringify(marker, null, 2), 'utf8');
}

async function removeLocalServerMarker() {
    try {
        const raw = await fsPromises.readFile(LOCAL_SERVER_MARKER_PATH, 'utf8');
        const marker = JSON.parse(raw);
        if (marker.pid && marker.pid !== process.pid) return;
    } catch (error) {
        if (getErrorCode(error) === 'ENOENT') return;
    }

    try {
        await fsPromises.unlink(LOCAL_SERVER_MARKER_PATH);
    } catch (error) {
        if (getErrorCode(error) !== 'ENOENT') {
            console.warn('[WARN] Could not remove local server marker:', getErrorMessage(error));
        }
    }
}

// Initialize database and start server
async function startServer() {
    try {
        // Initialize authentication database
        await initializeDatabase();

        // Configure Web Push (VAPID keys)
        configureWebPush();

        // Check if running in production mode (dist folder exists)
        const distIndexPath = path.join(APP_ROOT, 'dist', 'index.html');
        const isProduction = fs.existsSync(distIndexPath);

        // Log Claude implementation mode
        console.log(`${terminalTextStyles.info('[INFO]')} Using Claude Agents SDK for Claude integration`);
        console.log('');

        if (isProduction) {
            console.log(`${terminalTextStyles.info('[INFO]')} To run in production mode, go to http://${DISPLAY_HOST}:${SERVER_PORT}`);
        }

        console.log(`${terminalTextStyles.info('[INFO]')} To run in development mode with hot-module replacement, go to http://${DISPLAY_HOST}:${VITE_PORT}`);
   
        server.listen(SERVER_PORT, HOST, async () => {
            const appInstallPath = APP_ROOT;
            await writeLocalServerMarker().catch((error) => {
                console.warn('[WARN] Could not write local server marker:', error.message);
            });

            console.log('');
            console.log(terminalTextStyles.dim('═'.repeat(63)));
            console.log(`  ${terminalTextStyles.bright('CloudCLI Server - Ready')}`);
            console.log(terminalTextStyles.dim('═'.repeat(63)));
            console.log('');
            console.log(`${terminalTextStyles.info('[INFO]')} Server URL:  ${terminalTextStyles.bright('http://' + DISPLAY_HOST + ':' + SERVER_PORT)}`);
            console.log(`${terminalTextStyles.info('[INFO]')} Installed at: ${terminalTextStyles.dim(appInstallPath)}`);
            console.log(`${terminalTextStyles.tip('[TIP]')}  Run "cloudcli status" for full configuration details`);
            console.log('');

            // OpenCode turn servers a killed CloudCLI process left behind keep
            // running until stopped; this is the first chance to do so.
            void reapOrphanedOpenCodeServers()
                .then((count) => {
                    if (count > 0) {
                        console.log(`${terminalTextStyles.info('[INFO]')} Stopped ${count} OpenCode server(s) left running by an earlier CloudCLI process`);
                    }
                })
                .catch((error) => {
                    console.warn('[WARN] Could not check for leftover OpenCode servers:', getErrorMessage(error));
                });

            // Start watching the projects folder for changes
            await initializeSessionsWatcher();
            // Sends anything that came due while the server was not running,
            // then keeps polling.
            initializeScheduledMessageDispatcher(providerRuntimeService);
            // Orchestrated tasks that were waiting for a usage limit go back to waiting.
            restoreOrchestratorRuns(createOrchestratorRunDependencies(providerRuntimeService));

            // Start server-side plugin processes for enabled plugins
            startEnabledPluginServers().catch(err => {
                console.error('[Plugins] Error during startup:', err.message);
            });
        });

        await closeSessionsWatcher();
        closeScheduledMessageDispatcher();
        // Clean up plugin processes on shutdown
        const shutdownRuntimeServices = async () => {
            try {
                await browserUseService.stopAllSessions();
            } catch (err) {
                console.error('[Browser] Error stopping sessions during shutdown:', getErrorMessage(err));
            }
            try {
                await stopAllPlugins();
            } catch (err) {
                console.error('[Plugins] Error stopping plugins during shutdown:', getErrorMessage(err));
            }
            try {
                await removeLocalServerMarker();
            } catch (err) {
                console.error('[Local Server] Error removing server marker during shutdown:', getErrorMessage(err));
            }
            process.exit(0);
        };
        process.on('SIGTERM', () => void shutdownRuntimeServices());
        process.on('SIGINT', () => void shutdownRuntimeServices());
    } catch (error) {
        console.error('[ERROR] Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
