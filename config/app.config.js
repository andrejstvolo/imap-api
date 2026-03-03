'use strict';

const pathlib = require('path');
const config = require('wild-config');

// Load environment-based configuration
const appConfig = {
    api: {
        port: parseInt(process.env.PORT) || 3000,
        host: process.env.HOST || '0.0.0.0',
        key: process.env.API_KEY
    },
    
    redis: {
        url: process.env.REDIS_URL || 'redis://localhost:6379',
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        db: parseInt(process.env.REDIS_DB) || 0
    },
    
    database: {
        url: process.env.DATABASE_URL
    },
    
    security: {
        jwtSecret: process.env.JWT_SECRET,
        encryptionKey: process.env.ENCRYPTION_KEY,
        rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
        rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100
    },
    
    ai: {
        openai: {
            apiKey: process.env.OPENAI_API_KEY,
            model: process.env.OPENAI_MODEL || 'gpt-4'
        },
        anthropic: {
            apiKey: process.env.ANTHROPIC_API_KEY
        },
        agents: {
            openclaw: process.env.OPENCLAW_AGENT_URL,
            manus: process.env.MANUS_AGENT_URL,
            claudeCode: process.env.CLAUDE_CODE_AGENT_URL
        }
    },
    
    email: {
        batchSize: parseInt(process.env.BATCH_SIZE) || 50,
        fetchInterval: parseInt(process.env.FETCH_INTERVAL) || 30000,
        draftAutosaveInterval: parseInt(process.env.DRAFT_AUTOSAVE_INTERVAL) || 30000
    },
    
    autopilot: {
        enabled: process.env.AUTOPILOT_ENABLED === 'true',
        confidenceThreshold: parseFloat(process.env.AUTOPILOT_CONFIDENCE_THRESHOLD) || 0.85,
        rateLimit: parseInt(process.env.AUTOPILOT_RATE_LIMIT) || 20,
        escalationEmail: process.env.AUTOPILOT_ESCALATION_EMAIL
    },
    
    multiAccount: {
        accountsConfigPath: process.env.ACCOUNTS_CONFIG_PATH || './config/accounts.json',
        maxImapConnections: parseInt(process.env.MAX_IMAP_CONNECTIONS) || 20,
        connectionTimeout: parseInt(process.env.IMAP_CONNECTION_TIMEOUT) || 30000
    },
    
    webhooks: {
        url: process.env.WEBHOOK_URL,
        secret: process.env.WEBHOOK_SECRET
    },
    
    snappymail: {
        url: process.env.SNAPPYMAIL_URL,
        apiKey: process.env.SNAPPYMAIL_API_KEY
    },
    
    logging: {
        level: process.env.LOG_LEVEL || 'info',
        file: process.env.LOG_FILE || './logs/email-automation.log'
    },
    
    notifications: {
        slackWebhook: process.env.SLACK_WEBHOOK_URL,
        alertEmail: process.env.ALERT_EMAIL
    }
};

module.exports = appConfig;
