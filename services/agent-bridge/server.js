'use strict';

/**
 * AI Agent Bridge Service
 * 
 * Provides API endpoints for AI agents (OpenClaw, Manus, Claude Code) to:
 * - Access emails from all connected accounts
 * - Draft replies
 * - Get email context and thread history
 * - Submit approved replies for sending
 */

require('dotenv').config();

const Hapi = require('@hapi/hapi');
const Boom = require('@hapi/boom');
const Joi = require('@hapi/joi');
const logger = require('../../lib/logger');
const hapiPino = require('hapi-pino');
const Inert = require('@hapi/inert');
const Vision = require('@hapi/vision');
const HapiSwagger = require('hapi-swagger');
const packageData = require('../../package.json');
const pathlib = require('path');
const jwt = require('jsonwebtoken');

const { redis } = require('../../lib/db');
const EmailService = require('./services/email-service');
const DraftService = require('./services/draft-service');
const AgentAuth = require('./middleware/agent-auth');

const emailService = new EmailService();
const draftService = new DraftService();
const agentAuth = new AgentAuth();

// Validation schemas
const agentCredentialsSchema = Joi.object({
    agentId: Joi.string().required().example('openclaw-001'),
    agentType: Joi.string().valid('openclaw', 'manus', 'claude-code', 'custom').required(),
    apiKey: Joi.string().required(),
    permissions: Joi.array().items(
        Joi.string().valid('read', 'draft', 'send', 'admin')
    ).default(['read', 'draft'])
});

const emailQuerySchema = Joi.object({
    account: Joi.string().required().description('Account ID'),
    mailbox: Joi.string().default('INBOX').description('Mailbox path'),
    limit: Joi.number().integer().min(1).max(100).default(20),
    since: Joi.date().iso().optional(),
    unreadOnly: Joi.boolean().default(false),
    search: Joi.string().optional()
});

const draftRequestSchema = Joi.object({
    account: Joi.string().required(),
    replyTo: Joi.object({
        messageId: Joi.string().required(),
        threadId: Joi.string().optional()
    }).required(),
    content: Joi.object({
        tone: Joi.string().valid('professional', 'friendly', 'formal', 'casual').default('professional'),
        instructions: Joi.string().optional().description('Special instructions for drafting'),
        customTemplate: Joi.string().optional()
    }).optional(),
    requireApproval: Joi.boolean().default(true)
});

const failAction = async (request, h, err) => {
    let details = (err.details || []).map(detail => ({ 
        message: detail.message, 
        key: detail.context?.key 
    }));
    
    let error = Boom.boomify(new Error('Invalid input'), { statusCode: 400 });
    error.reformat();
    error.output.payload.fields = details;
    throw error;
};

const init = async () => {
    const server = Hapi.server({
        port: process.env.AGENT_BRIDGE_PORT || 3001,
        host: process.env.HOST || '0.0.0.0',
        routes: {
            cors: {
                origin: ['*'],
                credentials: true
            }
        }
    });

    const swaggerOptions = {
        swaggerUI: true,
        swaggerUIPath: '/swagger/',
        documentationPage: true,
        documentationPath: '/docs',
        grouping: 'tags',
        info: {
            title: 'AI Agent Bridge API',
            version: packageData.version,
            description: 'API for AI agents to interact with the email automation system',
            contact: {
                name: 'Email Automation Hub'
            }
        }
    };

    await server.register({
        plugin: hapiPino,
        options: {
            instance: logger.child({ component: 'agent-bridge' }),
            redact: ['req.headers.authorization', 'req.headers["x-api-key"]']
        }
    });

    await server.register([
        Inert,
        Vision,
        { plugin: HapiSwagger, options: swaggerOptions }
    ]);

    // JWT Authentication strategy
    server.auth.strategy('agent-jwt', 'bearer-access-token', {
        validate: async (request, token, h) => {
            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                const agent = await agentAuth.getAgent(decoded.agentId);
                if (!agent || !agent.active) {
                    return { isValid: false };
                }
                return { isValid: true, credentials: agent };
            } catch (err) {
                return { isValid: false };
            }
        }
    });

    server.auth.default('agent-jwt');

    // ============================================
    // Health Check
    // ============================================
    server.route({
        method: 'GET',
        path: '/health',
        options: { auth: false },
        handler: async () => {
            const redisHealth = await redis.ping() === 'PONG';
            return {
                status: 'ok',
                service: 'agent-bridge',
                version: packageData.version,
                timestamp: new Date().toISOString(),
                redis: redisHealth ? 'connected' : 'disconnected'
            };
        }
    });

    // ============================================
    // Agent Authentication
    // ============================================
    server.route({
        method: 'POST',
        path: '/auth/register',
        options: {
            auth: false,
            description: 'Register a new AI agent',
            tags: ['api', 'auth'],
            validate: {
                payload: agentCredentialsSchema
            }
        },
        handler: async (request) => {
            try {
                const agent = await agentAuth.register(request.payload);
                return {
                    success: true,
                    agentId: agent.agentId,
                    message: 'Agent registered successfully'
                };
            } catch (err) {
                logger.error({ msg: 'Agent registration failed', error: err.message });
                throw Boom.boomify(err, { statusCode: 400 });
            }
        }
    });

    server.route({
        method: 'POST',
        path: '/auth/token',
        options: {
            auth: false,
            description: 'Authenticate and get JWT token',
            tags: ['api', 'auth'],
            validate: {
                payload: Joi.object({
                    agentId: Joi.string().required(),
                    apiKey: Joi.string().required()
                })
            }
        },
        handler: async (request) => {
            try {
                const token = await agentAuth.authenticate(request.payload);
                return { success: true, token };
            } catch (err) {
                throw Boom.unauthorized('Invalid credentials');
            }
        }
    });

    // ============================================
    // Email Access Endpoints
    // ============================================
    server.route({
        method: 'GET',
        path: '/v1/accounts',
        options: {
            description: 'List all accessible accounts',
            tags: ['api', 'accounts'],
            notes: 'Returns all email accounts the agent has access to'
        },
        handler: async (request) => {
            try {
                const accounts = await emailService.getAccounts(request.auth.credentials);
                return { accounts };
            } catch (err) {
                logger.error({ msg: 'Failed to get accounts', error: err.message });
                throw Boom.boomify(err, { statusCode: 500 });
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/v1/emails',
        options: {
            description: 'List emails from an account',
            tags: ['api', 'emails'],
            validate: {
                query: emailQuerySchema
            }
        },
        handler: async (request) => {
            try {
                const emails = await emailService.listEmails(
                    request.query,
                    request.auth.credentials
                );
                return { emails, count: emails.length };
            } catch (err) {
                logger.error({ msg: 'Failed to list emails', error: err.message });
                throw Boom.boomify(err, { statusCode: 500 });
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/v1/emails/{account}/{messageId}',
        options: {
            description: 'Get a specific email by ID',
            tags: ['api', 'emails'],
            validate: {
                params: Joi.object({
                    account: Joi.string().required(),
                    messageId: Joi.string().required()
                })
            }
        },
        handler: async (request) => {
            try {
                const email = await emailService.getEmail(
                    request.params.account,
                    request.params.messageId,
                    request.auth.credentials
                );
                if (!email) {
                    throw Boom.notFound('Email not found');
                }
                return { email };
            } catch (err) {
                logger.error({ msg: 'Failed to get email', error: err.message });
                throw Boom.boomify(err, { statusCode: 500 });
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/v1/threads/{account}/{threadId}',
        options: {
            description: 'Get full thread conversation',
            tags: ['api', 'threads'],
            validate: {
                params: Joi.object({
                    account: Joi.string().required(),
                    threadId: Joi.string().required()
                })
            }
        },
        handler: async (request) => {
            try {
                const thread = await emailService.getThread(
                    request.params.account,
                    request.params.threadId,
                    request.auth.credentials
                );
                return { thread };
            } catch (err) {
                logger.error({ msg: 'Failed to get thread', error: err.message });
                throw Boom.boomify(err, { statusCode: 500 });
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/v1/context/{account}/{messageId}',
        options: {
            description: 'Get email context for AI processing',
            tags: ['api', 'context'],
            notes: 'Returns email with parsed content, thread history, and sender info'
        },
        handler: async (request) => {
            try {
                const context = await emailService.getEmailContext(
                    request.params.account,
                    request.params.messageId,
                    request.auth.credentials
                );
                return { context };
            } catch (err) {
                logger.error({ msg: 'Failed to get context', error: err.message });
                throw Boom.boomify(err, { statusCode: 500 });
            }
        }
    });

    // ============================================
    // Draft Management Endpoints
    // ============================================
    server.route({
        method: 'POST',
        path: '/v1/drafts',
        options: {
            description: 'Create a draft reply using AI',
            tags: ['api', 'drafts'],
            validate: {
                payload: draftRequestSchema
            }
        },
        handler: async (request) => {
            try {
                // Check permissions
                if (!request.auth.credentials.permissions.includes('draft')) {
                    throw Boom.forbidden('Agent does not have draft permission');
                }

                const draft = await draftService.createDraft(
                    request.payload,
                    request.auth.credentials
                );
                
                return {
                    success: true,
                    draftId: draft.id,
                    status: draft.status,
                    message: draft.requireApproval 
                        ? 'Draft created and queued for approval' 
                        : 'Draft created and ready to send'
                };
            } catch (err) {
                logger.error({ msg: 'Failed to create draft', error: err.message });
                throw Boom.boomify(err, { statusCode: 500 });
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/v1/drafts',
        options: {
            description: 'List drafts created by this agent',
            tags: ['api', 'drafts'],
            validate: {
                query: Joi.object({
                    status: Joi.string().valid('pending', 'approved', 'rejected', 'sent').optional(),
                    limit: Joi.number().integer().min(1).max(100).default(20)
                })
            }
        },
        handler: async (request) => {
            try {
                const drafts = await draftService.listDrafts(
                    request.auth.credentials.agentId,
                    request.query
                );
                return { drafts, count: drafts.length };
            } catch (err) {
                logger.error({ msg: 'Failed to list drafts', error: err.message });
                throw Boom.boomify(err, { statusCode: 500 });
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/v1/drafts/{draftId}',
        options: {
            description: 'Get a specific draft',
            tags: ['api', 'drafts']
        },
        handler: async (request) => {
            try {
                const draft = await draftService.getDraft(request.params.draftId);
                if (!draft) {
                    throw Boom.notFound('Draft not found');
                }
                // Verify ownership
                if (draft.agentId !== request.auth.credentials.agentId) {
                    throw Boom.forbidden('Access denied');
                }
                return { draft };
            } catch (err) {
                logger.error({ msg: 'Failed to get draft', error: err.message });
                throw Boom.boomify(err, { statusCode: 500 });
            }
        }
    });

    server.route({
        method: 'PUT',
        path: '/v1/drafts/{draftId}',
        options: {
            description: 'Update a draft',
            tags: ['api', 'drafts'],
            validate: {
                payload: Joi.object({
                    content: Joi.string().required(),
                    subject: Joi.string().optional()
                })
            }
        },
        handler: async (request) => {
            try {
                const draft = await draftService.getDraft(request.params.draftId);
                if (!draft) {
                    throw Boom.notFound('Draft not found');
                }
                if (draft.agentId !== request.auth.credentials.agentId) {
                    throw Boom.forbidden('Access denied');
                }
                if (draft.status !== 'pending') {
                    throw Boom.badRequest('Cannot update draft that is not pending');
                }

                const updated = await draftService.updateDraft(
                    request.params.draftId,
                    request.payload
                );
                return { success: true, draft: updated };
            } catch (err) {
                logger.error({ msg: 'Failed to update draft', error: err.message });
                throw Boom.boomify(err, { statusCode: 500 });
            }
        }
    });

    server.route({
        method: 'DELETE',
        path: '/v1/drafts/{draftId}',
        options: {
            description: 'Delete a draft',
            tags: ['api', 'drafts']
        },
        handler: async (request) => {
            try {
                const draft = await draftService.getDraft(request.params.draftId);
                if (!draft) {
                    throw Boom.notFound('Draft not found');
                }
                if (draft.agentId !== request.auth.credentials.agentId) {
                    throw Boom.forbidden('Access denied');
                }

                await draftService.deleteDraft(request.params.draftId);
                return { success: true, message: 'Draft deleted' };
            } catch (err) {
                logger.error({ msg: 'Failed to delete draft', error: err.message });
                throw Boom.boomify(err, { statusCode: 500 });
            }
        }
    });

    // ============================================
    // Send Email (Direct - requires 'send' permission)
    // ============================================
    server.route({
        method: 'POST',
        path: '/v1/send',
        options: {
            description: 'Send an email directly (requires send permission)',
            tags: ['api', 'send'],
            validate: {
                payload: Joi.object({
                    account: Joi.string().required(),
                    to: Joi.array().items(Joi.string().email()).required(),
                    cc: Joi.array().items(Joi.string().email()).optional(),
                    bcc: Joi.array().items(Joi.string().email()).optional(),
                    subject: Joi.string().required(),
                    text: Joi.string().required(),
                    html: Joi.string().optional(),
                    replyTo: Joi.string().optional()
                })
            }
        },
        handler: async (request) => {
            try {
                if (!request.auth.credentials.permissions.includes('send')) {
                    throw Boom.forbidden('Agent does not have send permission');
                }

                const result = await emailService.sendEmail(
                    request.payload,
                    request.auth.credentials
                );
                return { success: true, messageId: result.messageId };
            } catch (err) {
                logger.error({ msg: 'Failed to send email', error: err.message });
                throw Boom.boomify(err, { statusCode: 500 });
            }
        }
    });

    // ============================================
    // WebSocket for Real-time Updates
    // ============================================
    const WebSocket = require('ws');
    const http = require('http');
    
    const httpServer = http.createServer(server.listener);
    const wss = new WebSocket.Server({ server: httpServer, path: '/ws' });

    wss.on('connection', (ws, req) => {
        logger.info({ msg: 'WebSocket connection established' });
        
        ws.on('message', async (message) => {
            try {
                const data = JSON.parse(message);
                // Handle subscription requests
                if (data.action === 'subscribe' && data.account) {
                    ws.account = data.account;
                    ws.send(JSON.stringify({ type: 'subscribed', account: data.account }));
                }
            } catch (err) {
                ws.send(JSON.stringify({ type: 'error', message: err.message }));
            }
        });

        ws.on('close', () => {
            logger.info({ msg: 'WebSocket connection closed' });
        });
    });

    // Broadcast function for new emails
    global.broadcastEmail = (account, email) => {
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.account === account) {
                client.send(JSON.stringify({ type: 'new_email', account, email }));
            }
        });
    };

    // Start server
    await server.start();
    logger.info({ msg: 'Agent Bridge running on', uri: server.info.uri });

    return server;
};

process.on('unhandledRejection', (err) => {
    logger.error({ msg: 'Unhandled rejection', error: err.message, stack: err.stack });
    process.exit(1);
});

init();
