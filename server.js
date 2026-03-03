'use strict';

process.title = 'email-automation-hub';

// Load environment variables first
require('dotenv').config();

const logger = require('./lib/logger');
const pathlib = require('path');
const { Worker, SHARE_ENV } = require('worker_threads');
const { redis } = require('./lib/db');
const promClient = require('prom-client');
const config = require('./config/app.config');

// Security: Validate required environment variables
const requiredEnvVars = ['API_KEY', 'JWT_SECRET', 'ENCRYPTION_KEY'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
    logger.error(`Missing required environment variables: ${missingVars.join(', ')}`);
    logger.error('Please copy .env.example to .env and configure all required variables');
    process.exit(1);
}

// Security: Validate encryption key length
if (process.env.ENCRYPTION_KEY.length < 32) {
    logger.error('ENCRYPTION_KEY must be at least 32 characters long');
    process.exit(1);
}

// Prometheus metrics
const metrics = {
    threadStarts: new promClient.Counter({
        name: 'thread_starts_total',
        help: 'Number of started threads'
    }),

    threadStops: new promClient.Counter({
        name: 'thread_stops_total',
        help: 'Number of stopped threads'
    }),

    apiCall: new promClient.Counter({
        name: 'api_calls_total',
        help: 'Number of API calls',
        labelNames: ['method', 'statusCode', 'route']
    }),

    imapConnections: new promClient.Gauge({
        name: 'imap_connections',
        help: 'Current IMAP connection state',
        labelNames: ['status', 'account']
    }),

    emailsProcessed: new promClient.Counter({
        name: 'emails_processed_total',
        help: 'Total emails processed',
        labelNames: ['account', 'action']
    }),

    draftsPending: new promClient.Gauge({
        name: 'drafts_pending',
        help: 'Number of drafts awaiting approval'
    }),

    autopilotDecisions: new promClient.Counter({
        name: 'autopilot_decisions_total',
        help: 'Autopilot decision count',
        labelNames: ['account', 'decision']
    })
};

let callQueue = new Map();
let mids = 0;

let closing = false;
let assigning = false;

let unassigned = false;
let assigned = new Map();
let workerAssigned = new WeakMap();

let workers = new Map();
let availableIMAPWorkers = new Set();

let spawnWorker = type => {
    if (closing) {
        return;
    }

    if (!workers.has(type)) {
        workers.set(type, new Set());
    }

    let worker = new Worker(pathlib.join(__dirname, 'workers', `${type}.js`), {
        argv: process.argv.slice(2),
        env: SHARE_ENV
    });
    metrics.threadStarts.inc();

    workers.get(type).add(worker);

    worker.on('exit', exitCode => {
        metrics.threadStops.inc();

        workers.get(type).delete(worker);
        availableIMAPWorkers.delete(worker);

        if (workerAssigned.has(worker)) {
            workerAssigned.get(worker).forEach(account => {
                assigned.delete(account);
                unassigned.add(account);
            });
            workerAssigned.delete(worker);
        }

        if (closing) {
            return;
        }

        // Log and respawn worker
        logger.error({ msg: 'Worker exited', type, exitCode });
        setTimeout(() => spawnWorker(type), 1000);
    });

    worker.on('error', err => {
        logger.error({ msg: 'Worker error', type, error: err.message, stack: err.stack });
    });

    worker.on('message', message => {
        if (!message) {
            return;
        }

        if (message.cmd === 'resp' && message.mid && callQueue.has(message.mid)) {
            let { resolve, reject, timer } = callQueue.get(message.mid);
            clearTimeout(timer);
            callQueue.delete(message.mid);
            if (message.error) {
                let err = new Error(message.error);
                if (message.code) {
                    err.code = message.code;
                }
                if (message.statusCode) {
                    err.statusCode = message.statusCode;
                }
                return reject(err);
            } else {
                return resolve(message.response);
            }
        }

        if (message.cmd === 'call' && message.mid) {
            return onCommand(worker, message.message)
                .then(response => {
                    worker.postMessage({
                        cmd: 'resp',
                        mid: message.mid,
                        response
                    });
                })
                .catch(err => {
                    worker.postMessage({
                        cmd: 'resp',
                        mid: message.mid,
                        error: err.message,
                        code: err.code,
                        statusCode: err.statusCode
                    });
                });
        }

        switch (message.cmd) {
            case 'metrics':
                if (message.key && metrics[message.key] && typeof metrics[message.key][message.method] === 'function') {
                    metrics[message.key][message.method](...message.args);
                }
                return;

            case 'settings':
                availableIMAPWorkers.forEach(worker => {
                    worker.postMessage(message);
                });
                return;
        }

        switch (type) {
            case 'imap':
                return processImapWorkerMessage(worker, message);
        }
    });
};

function processImapWorkerMessage(worker, message) {
    if (!message || !message.cmd) {
        logger.debug({ msg: 'Unexpected message', type: 'imap', message });
        return;
    }

    switch (message.cmd) {
        case 'ready':
            availableIMAPWorkers.add(worker);
            assignAccounts().catch(err => logger.error(err));
            break;
        
        case 'metrics':
            if (message.connections) {
                Object.entries(message.connections).forEach(([status, count]) => {
                    metrics.imapConnections.set({ status, account: message.account || 'unknown' }, count);
                });
            }
            break;
    }
}

async function call(worker, message, transferList) {
    return new Promise((resolve, reject) => {
        let mid = `${Date.now()}:${++mids}`;

        let timer = setTimeout(() => {
            let err = new Error('Timeout waiting for command response');
            err.statusCode = 504;
            err.code = 'Timeout';
            reject(err);
        }, message.timeout || 30 * 1000);

        callQueue.set(mid, { resolve, reject, timer });
        worker.postMessage(
            {
                cmd: 'call',
                mid,
                message
            },
            transferList
        );
    });
}

async function assignAccounts() {
    if (assigning) {
        return false;
    }
    assigning = true;
    try {
        if (!unassigned) {
            // First run - load all accounts
            let accounts = await redis.smembers('ia:accounts');
            unassigned = new Set(accounts);
            logger.info({ msg: 'Loaded accounts from Redis', count: accounts.length });
        }

        if (!availableIMAPWorkers.size || !unassigned.size) {
            return;
        }

        let workerIterator = availableIMAPWorkers.values();
        let getNextWorker = () => {
            let next = workerIterator.next();
            if (next.done) {
                if (!availableIMAPWorkers.size) {
                    return false;
                }
                workerIterator = availableIMAPWorkers.values();
                return workerIterator.next().value;
            } else {
                return next.value;
            }
        };

        for (let account of unassigned) {
            let worker = getNextWorker();
            if (!worker) {
                break;
            }

            if (!workerAssigned.has(worker)) {
                workerAssigned.set(worker, new Set());
            }
            workerAssigned.get(worker).add(account);
            assigned.set(account, worker);
            unassigned.delete(account);
            
            logger.info({ msg: 'Assigning account to worker', account });
            await call(worker, { cmd: 'assign', account });
        }
    } finally {
        assigning = false;
    }
}

async function onCommand(worker, message) {
    switch (message.cmd) {
        case 'metrics':
            return promClient.register.metrics();

        case 'structuredMetrics': {
            let connections = {};
            for (let key of Object.keys(metrics.imapConnections.hashMap || {})) {
                if (key.indexOf('status:') === 0) {
                    let metric = metrics.imapConnections.hashMap[key];
                    connections[metric.labels.status] = metric.value;
                }
            }
            return { connections };
        }

        case 'new':
            unassigned.add(message.account);
            assignAccounts().catch(err => logger.error(err));
            return { success: true };

        case 'delete':
            unassigned.delete(message.account);
            if (assigned.has(message.account)) {
                let assignedWorker = assigned.get(message.account);
                if (workerAssigned.has(assignedWorker)) {
                    workerAssigned.get(assignedWorker).delete(message.account);
                }
                call(assignedWorker, message).catch(err => logger.error(err));
            }
            return { success: true };

        case 'update':
            if (assigned.has(message.account)) {
                let assignedWorker = assigned.get(message.account);
                call(assignedWorker, message).catch(err => logger.error(err));
            }
            return { success: true };

        case 'listMessages':
        case 'buildContacts':
        case 'getRawMessage':
        case 'getText':
        case 'getMessage':
        case 'updateMessage':
        case 'deleteMessage':
        case 'createMailbox':
        case 'deleteMailbox':
        case 'submitMessage':
        case 'saveDraft':
        case 'getAttachment':
        case 'searchMessages':
        case 'getThread': {
            if (!assigned.has(message.account)) {
                return {
                    error: 'No active connection to requested account. Try again later.',
                    statusCode: 503
                };
            }

            let assignedWorker = assigned.get(message.account);
            return await call(assignedWorker, message, message.port ? [message.port] : []);
        }

        default:
            logger.warn({ msg: 'Unknown command', cmd: message.cmd });
            return { error: 'Unknown command', statusCode: 400 };
    }
}

// Spawn workers based on configuration
const IMAP_WORKER_COUNT = parseInt(process.env.IMAP_WORKER_COUNT) || 4;
for (let i = 0; i < IMAP_WORKER_COUNT; i++) {
    spawnWorker('imap');
}

// Spawn API and webhook workers
spawnWorker('api');
spawnWorker('webhooks');

// Metrics collection
let metricsResult = {};
async function collectMetrics() {
    Object.keys(metricsResult || {}).forEach(key => {
        metricsResult[key] = 0;
    });

    if (workers.has('imap')) {
        let imapWorkers = workers.get('imap');
        for (let imapWorker of imapWorkers) {
            try {
                let workerStats = await call(imapWorker, { cmd: 'countConnections' });
                Object.keys(workerStats || {}).forEach(status => {
                    if (!metricsResult[status]) {
                        metricsResult[status] = 0;
                    }
                    metricsResult[status] += Number(workerStats[status]) || 0;
                });
            } catch (err) {
                logger.error({ msg: 'Failed to collect metrics from worker', error: err.message });
            }
        }
    }

    Object.keys(metricsResult).forEach(status => {
        metrics.imapConnections.set({ status, account: 'all' }, metricsResult[status]);
    });
}

setInterval(() => {
    collectMetrics().catch(err => logger.error({ msg: 'Failed to collect metrics', err }));
}, 5000).unref();

// Graceful shutdown
async function gracefulShutdown(signal) {
    logger.info({ msg: `Received ${signal}, starting graceful shutdown...` });
    closing = true;

    // Close all workers
    const closePromises = [];
    for (const [type, workerSet] of workers) {
        for (const worker of workerSet) {
            closePromises.push(
                new Promise((resolve) => {
                    worker.terminate().then(resolve).catch(resolve);
                })
            );
        }
    }

    await Promise.all(closePromises);
    logger.info({ msg: 'All workers terminated' });
    
    // Close Redis connection
    await redis.quit();
    logger.info({ msg: 'Redis connection closed' });
    
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', err => {
    logger.error({ msg: 'Uncaught exception', error: err.message, stack: err.stack });
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error({ msg: 'Unhandled rejection', reason, promise });
});

logger.info({ msg: 'Email Automation Hub started', version: require('./package.json').version });
