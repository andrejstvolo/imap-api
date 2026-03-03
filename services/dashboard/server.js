'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const logger = require('../../lib/logger');
const { redis } = require('../../lib/db');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const TaskMonitorService = require('./src/services/task-monitor');
const DraftService = require('./src/services/draft-service');
const ActivityFeedService = require('./src/services/activity-feed');
const BusinessOverviewService = require('./src/services/business-overview');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const taskMonitor = new TaskMonitorService(redis);
const draftService = new DraftService(redis);
const activityFeed = new ActivityFeedService(redis);
const businessOverview = new BusinessOverviewService(redis);

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "cdn.jsdelivr.net", "unpkg.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "fonts.googleapis.com"],
            fontSrc: ["'self'", "fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "blob:"],
            connectSrc: ["'self'", "ws:", "wss:"]
        }
    }
}));

const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100
});
app.use(limiter);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const clients = new Map();

wss.on('connection', async (ws, req) => {
    const clientId = Date.now().toString(36) + Math.random().toString(36).substr(2);
    clients.set(clientId, { ws, subscriptions: new Set() });
    
    logger.info({ msg: 'Dashboard client connected', clientId, totalClients: clients.size });
    
    ws.send(JSON.stringify({
        type: 'init',
        data: {
            tasks: await taskMonitor.getActiveTasks(),
            drafts: await draftService.getPendingDrafts(),
            activities: await activityFeed.getRecent(50),
            businesses: await businessOverview.getAll()
        }
    }));
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            const client = clients.get(clientId);
            
            switch (data.action) {
                case 'subscribe':
                    client.subscriptions.add(data.channel);
                    ws.send(JSON.stringify({ type: 'subscribed', channel: data.channel }));
                    break;
                    
                case 'unsubscribe':
                    client.subscriptions.delete(data.channel);
                    ws.send(JSON.stringify({ type: 'unsubscribed', channel: data.channel }));
                    break;
                    
                case 'getTaskDetails':
                    const task = await taskMonitor.getTaskDetails(data.taskId);
                    ws.send(JSON.stringify({ type: 'taskDetails', task }));
                    break;
                    
                case 'getDraftDetails':
                    const draft = await draftService.getDraft(data.draftId);
                    ws.send(JSON.stringify({ type: 'draftDetails', draft }));
                    break;
                    
                case 'approveDraft':
                    await handleDraftAction(data.draftId, 'approved', clientId);
                    break;
                    
                case 'rejectDraft':
                    await handleDraftAction(data.draftId, 'rejected', clientId);
                    break;
                    
                case 'editDraft':
                    await draftService.updateDraft(data.draftId, data.updates);
                    broadcast('draftUpdated', { draftId: data.draftId, updates: data.updates });
                    break;
                    
                case 'sendDraft':
                    await handleSendDraft(data.draftId, clientId);
                    break;
                    
                case 'refreshBusiness':
                    const business = await businessOverview.getBusiness(data.businessId);
                    ws.send(JSON.stringify({ type: 'businessData', business }));
                    break;
            }
        } catch (err) {
            logger.error({ msg: 'WebSocket message error', error: err.message });
            ws.send(JSON.stringify({ type: 'error', message: err.message }));
        }
    });
    
    ws.on('close', () => {
        clients.delete(clientId);
        logger.info({ msg: 'Dashboard client disconnected', clientId, totalClients: clients.size });
    });
    
    ws.on('error', (err) => {
        logger.error({ msg: 'WebSocket error', clientId, error: err.message });
    });
});

function broadcast(channel, data) {
    const message = JSON.stringify({ type: channel, data });
    clients.forEach(({ ws, subscriptions }) => {
        if (ws.readyState === WebSocket.OPEN && subscriptions.has(channel)) {
            ws.send(message);
        }
    });
}

function broadcastAll(type, data) {
    const message = JSON.stringify({ type, data });
    clients.forEach(({ ws }) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(message);
        }
    });
}

async function handleDraftAction(draftId, action, clientId) {
    try {
        const result = await draftService.updateStatus(draftId, action);
        broadcastAll('draftStatusChanged', { draftId, status: action, result });
        
        await activityFeed.log({
            type: 'draft_action',
            action,
            draftId,
            user: clientId,
            timestamp: new Date().toISOString()
        });
        
        return result;
    } catch (err) {
        logger.error({ msg: 'Draft action failed', draftId, action, error: err.message });
        throw err;
    }
}

async function handleSendDraft(draftId, clientId) {
    try {
        const result = await draftService.sendDraft(draftId);
        broadcastAll('draftSent', { draftId, messageId: result.messageId });
        
        await activityFeed.log({
            type: 'draft_sent',
            draftId,
            messageId: result.messageId,
            user: clientId,
            timestamp: new Date().toISOString()
        });
        
        return result;
    } catch (err) {
        logger.error({ msg: 'Send draft failed', draftId, error: err.message });
        throw err;
    }
}

const subscriber = redis.duplicate();
subscriber.subscribe('email:new', 'draft:created', 'draft:updated', 'task:started', 'task:completed', 'task:failed', 'activity:new');

subscriber.on('message', async (channel, message) => {
    try {
        const data = JSON.parse(message);
        
        switch (channel) {
            case 'email:new':
                broadcastAll('newEmail', data);
                break;
            case 'draft:created':
                broadcastAll('newDraft', data);
                break;
            case 'draft:updated':
                broadcastAll('draftUpdated', data);
                break;
            case 'task:started':
            case 'task:completed':
            case 'task:failed':
                broadcastAll('taskUpdate', { event: channel, ...data });
                break;
            case 'activity:new':
                broadcastAll('newActivity', data);
                break;
        }
    } catch (err) {
        logger.error({ msg: 'Redis message error', channel, error: err.message });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'dashboard', timestamp: new Date().toISOString() });
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/tasks', async (req, res) => {
    try {
        const tasks = await taskMonitor.getActiveTasks();
        res.json({ tasks });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/drafts', async (req, res) => {
    try {
        const drafts = await draftService.getPendingDrafts();
        res.json({ drafts });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/activities', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const activities = await activityFeed.getRecent(limit);
        res.json({ activities });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/businesses', async (req, res) => {
    try {
        const businesses = await businessOverview.getAll();
        res.json({ businesses });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.DASHBOARD_PORT || 3005;
server.listen(PORT, () => {
    logger.info({ msg: 'Dashboard service running', port: PORT });
});
