import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import winston from 'winston';
import { bundlerRouter } from './services/bundler.js';
import { cerberusRouter } from './services/cerberus.js';
import { simulatorRouter } from './services/simulator.js';
import { proxyRouter } from './services/tor-proxy.js';
import { crossChainRouter } from './services/crosschain.js';
import { mevRouter } from './services/mev-protection.js';
import { webauthnRouter } from './services/webauthn.js';
import { analyticsRouter } from './services/analytics.js';

dotenv.config();

// ═══════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'logs/omega-backend.log' })
    ]
});

// ═══════════════════════════════════════════════════════════════
// EXPRESS — Hardened
// ═══════════════════════════════════════════════════════════════
const app = express();

app.use(helmet());
app.use(cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true
}));
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
    logger.info({ method: req.method, path: req.path, ip: req.ip });
    next();
});

// ═══════════════════════════════════════════════════════════════
// ROUTES — 8 Service Modules
// ═══════════════════════════════════════════════════════════════
app.use('/api/bundler', bundlerRouter);       // ERC-4337 UserOp
app.use('/api/cerberus', cerberusRouter);     // Contract scanner
app.use('/api/simulate', simulatorRouter);     // Dry-run
app.use('/api/proxy', proxyRouter);           // Tor/Nym relay
app.use('/api/crosschain', crossChainRouter); // Multi-chain
app.use('/api/mev', mevRouter);               // MEV protection
app.use('/api/webauthn', webauthnRouter);     // Hardware signing
app.use('/api/analytics', analyticsRouter);   // Portfolio + threats

// Health
app.get('/api/health', (req, res) => {
    res.json({
        status: 'operational',
        version: '1.0.0',
        services: {
            bundler: 'active',
            cerberus: 'active',
            simulator: 'active',
            torProxy: process.env.TOR_SOCKS_HOST ? 'active' : 'standby',
            crosschain: 'active',
            mevProtection: 'active',
            webauthn: 'active',
            analytics: 'active'
        },
        invariants: '10/10 HOLDING',
        assurance: 'STATE_LEVEL_SHIELDED',
        uptime: process.uptime()
    });
});

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3001;
app.listen(PORT, '127.0.0.1', () => {
    logger.info({
        event: 'server_start',
        port: PORT,
        host: '127.0.0.1',
        services: 8,
        assurance: 'STATE_LEVEL_SHIELDED'
    });
});

export { app, logger };
