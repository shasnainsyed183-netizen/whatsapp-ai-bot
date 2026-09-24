// ===================================================================
//  JARVIS-STYLE AI ASSISTANT v10.1
//  Multi-User Context System
//  Owner: Norang Ali Shah
//  Updated: New Gemini 3.6 Models
// ===================================================================

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const axios = require('axios');
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

// Import storage module
const storage = require('./storage');

// ===================================================================
//                        LOAD PROFILE
// ===================================================================
let PROFILE = {
    owner: {
        name: "Norang Ali Shah",
        nickname: "Norang",
        age: 21,
        city: "Karachi",
        profession: "BS Computer Science Student",
        university: "DHA Suffa University, Karachi",
        interests: ["programming", "gaming", "AI", "video editing", "cricket"],
        personality: "friendly, chill, funny, helpful"
    }
};

try {
    const profilePath = path.join(__dirname, 'profile.json');
    if (fs.existsSync(profilePath)) {
        PROFILE = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
        console.log('[PROFILE] Loaded for:', PROFILE.owner.name);
    }
} catch (e) {
    console.error('[PROFILE] Error:', e.message);
}

// ===================================================================
//                        CONFIGURATION
// ===================================================================
const CONFIG = {
    GEMINI_KEY: process.env.GEMINI_KEY,
    PORT: process.env.PORT || 3000,

    BEHAVIOR: {
        SHORT_MSG_DELAY_MIN: 2000,
        SHORT_MSG_DELAY_MAX: 5000,
        LONG_MSG_DELAY_MIN: 5000,
        LONG_MSG_DELAY_MAX: 12000,
        TYPING_BEFORE_REPLY: true,
        SEND_READ_RECEIPT: true,
        MAX_HISTORY_CONTEXT: 20,
        RATE_LIMIT_PER_MINUTE: 30
    },

    // Updated models - Google ne purane band kar diye
    MODELS: [
        'gemini-3.6-flash',
        'gemini-2.5-flash',
        'gemini-2.0-flash-exp'
    ]
};

// ===================================================================
//                          STATE
// ===================================================================
let sock = null;
let currentQR = null;
let isBotPaused = false;
let reconnectAttempts = 0;
const messageStats = {
    sent: 0, received: 0, failed: 0, skipped: 0,
    startTime: Date.now()
};

// ===================================================================
//               SYSTEM PROMPT (CONSTANT FOR ALL USERS)
// ===================================================================
function getSystemPrompt() {
    const o = PROFILE.owner;
    return `You are JARVIS - an advanced AI assistant (like Iron Man's JARVIS) - intelligent, articulate, warm, professional, with subtle dry wit. You serve ${o.name} from ${o.city}, Pakistan.

IMPORTANT CONTEXT:
You are running on ${o.name}'s WhatsApp. So:
- If sender is ${o.name} himself → talk to him like JARVIS talks to Tony: "Sir", professional but warm, witty.
- If sender is a FRIEND → be a smart helpful assistant on his behalf. NEVER reveal you're AI.
- NEVER say "I am an AI / bot / assistant" - just BE smart.

===== ABOUT YOUR OWNER (${o.name}) =====
Name: ${o.name} (friends call "${o.nickname || o.name}")
Age: ${o.age || 21}
City: ${o.city}
Profession: ${o.profession}
Interests: ${(o.interests || []).join(', ')}

===== YOUR PERSONALITY =====
- Smart, composed, articulate
- Slight dry humor (British butler style)
- Proactive and helpful
- Addresses ${o.name} as "Sir" occasionally (not every msg)
- With friends: friendly, respectful, casual
- Use WhatsApp formatting: *bold*, _italic_, bullets (•)

===== HOW TO REPLY =====
1. CASUAL CHAT (hi, salam, kya haal) → Short natural reply (1-2 lines)
2. REAL QUESTION (explain X, kya hai, how to) → Detailed with headings + bullets + example
3. MEDIA → Natural spontaneous reply (no templates)
4. Match sender's language (Roman Urdu / English / Urdu)
5. Short for casual, detailed for real questions

===== CRITICAL RULES =====
1. NEVER say "I am AI / bot"
2. NEVER say "busy hoon, baad mein baat karte" as excuse
3. Privacy: NEVER share DOB, father's name, village, siblings, religion
4. If asked "are you AI?" → "haha nahi yaar. kya laga? 😄"
5. If asked private info → "wo personal hai yaar" / "yaad nahi"
6. Match friend's energy
7. Use natural fillers: "yaar", "bhai", "hmm", "acha", "theek hai"
8. 0-2 emojis max
9. Don't start every reply with sender's name

===== EXAMPLES =====
Friend: "salam" → "salam, kaisa hai"
Friend: "chai pe chalein?" → "haan chalo, kab?"
Owner: "kya haal hai?" → "Sab theek hai, Sir. Aap batayein."

===== FINAL =====
You are JARVIS-quality intelligence. Be natural, smart, warm.
NEVER reveal you're AI. Remember the conversation context.`;
}

// ===================================================================
//                      HELPERS
// ===================================================================
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isShortMessage(text) {
    const words = text.trim().split(/\s+/).length;
    return words <= 5;
}

function needsDetailedAnswer(text) {
    const t = text.toLowerCase();
    const detailedKeywords = /\b(explain|samjha|samjhao|kya hai|kya hota|how|kaise|why|kyun|difference|define|write|likh|bana|code|assignment|report|definition|example|steps|help|sikhao|batao|meaning)\b/i;
    return detailedKeywords.test(t) || text.length > 50;
}

// ===================================================================
//                     AI CALL (MULTI-USER AWARE)
// ===================================================================
async function callGeminiWithHistory(contents, isLong = false) {
    const systemInstruction = {
        parts: [{ text: getSystemPrompt() }]
    };

    for (const model of CONFIG.MODELS) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${CONFIG.GEMINI_KEY}`;
            const res = await axios.post(url, {
                systemInstruction: systemInstruction,
                contents: contents,
                generationConfig: {
                    temperature: 0.95,
                    maxOutputTokens: isLong ? 1200 : 250,
                    topP: 0.95,
                    topK: 40
                },
                safetySettings: [
                    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
                    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
                    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
                    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
                ]
            });
            const reply = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (reply) {
                console.log(`[AI] ${model} replied (${contents.length} msgs in context)`);
                return reply;
            }
        } catch (err) {
            console.log(`[AI] ${model} failed: ${err.response?.data?.error?.message || err.message}`);
        }
    }
    return null;
}

// ===================================================================
//                   MESSAGE HANDLER (CORE)
// ===================================================================
async function handleTextMessage(msg, from, text) {
    const userId = storage.extractUserId(from);
    console.log(`[RECV] User: ${userId} | Msg: ${text.substring(0, 60)}`);

    // Step 1: Load user's history
    const user = storage.loadUser(userId, from);
    console.log(`[HISTORY] ${userId} has ${user.history.length} past messages`);

    // Step 2: Append user's new message
    storage.appendMessage(user, 'user', text);

    // Step 3: Build contents array
    const recentHistory = user.history.slice(-CONFIG.BEHAVIOR.MAX_HISTORY_CONTEXT);
    const contents = recentHistory.map(m => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.text }]
    }));

    // Step 4: Typing indicator + delay
    if (CONFIG.BEHAVIOR.TYPING_BEFORE_REPLY) {
        try { await sock.sendPresenceUpdate('composing', from); } catch (e) {}
    }

    const detailed = needsDetailedAnswer(text);
    const delay = isShortMessage(text) && !detailed
        ? randomInt(CONFIG.BEHAVIOR.SHORT_MSG_DELAY_MIN, CONFIG.BEHAVIOR.SHORT_MSG_DELAY_MAX)
        : randomInt(CONFIG.BEHAVIOR.LONG_MSG_DELAY_MIN, CONFIG.BEHAVIOR.LONG_MSG_DELAY_MAX);
    await sleep(delay);

    // Step 5: Call Gemini
    let aiReply = await callGeminiWithHistory(contents, detailed);

    if (!aiReply) {
        aiReply = "hmm, network issue lag raha hai. phir se bhej do?";
    }

    // Step 6: Clean reply
    aiReply = aiReply.trim()
        .replace(new RegExp('^' + PROFILE.owner.name + ':\\s*', 'i'), '')
        .replace(/^["']|["']$/g, '')
        .replace(/^(Friend|You|User|Model):\s*/i, '');

    // Step 7: Stop typing, send
    try { await sock.sendPresenceUpdate('paused', from); } catch (e) {}
    await sock.sendMessage(from, { text: aiReply });

    // Step 8: Append AI reply
    storage.appendMessage(user, 'model', aiReply);

    // Step 9: Save user
    storage.saveUser(user);

    messageStats.sent++;
    console.log(`[SENT] ${userId}: ${aiReply.substring(0, 60)}`);
    console.log(`[SAVED] ${userId} history now has ${user.history.length} messages`);
}

// ===================================================================
//                    MEDIA HANDLER
// ===================================================================
async function handleMediaMessage(msg, from) {
    const m = msg.message;
    let mediaType = null;
    let mediaDesc = '';

    if (m.imageMessage) { mediaType = 'image'; mediaDesc = `Friend sent a photo. Caption: "${m.imageMessage.caption || '(none)'}"`; }
    else if (m.audioMessage) { mediaType = 'voice'; mediaDesc = `Friend sent a voice note (${m.audioMessage.seconds || '?'}s)`; }
    else if (m.documentMessage) { mediaType = 'document'; mediaDesc = `Friend sent document: "${m.documentMessage.fileName || 'file'}"`; }
    else if (m.videoMessage) { mediaType = 'video'; mediaDesc = `Friend sent a video. Caption: "${m.videoMessage.caption || '(none)'}"`; }
    else if (m.stickerMessage) { mediaType = 'sticker'; mediaDesc = `Friend sent a sticker`; }

    if (!mediaType) return;

    const userId = storage.extractUserId(from);
    console.log(`[MEDIA] ${mediaType} from ${userId}`);

    const user = storage.loadUser(userId, from);
    storage.appendMessage(user, 'user', `[${mediaType}]`);

    try { await sock.sendPresenceUpdate('composing', from); } catch (e) {}
    await sleep(randomInt(3000, 7000));

    const recentHistory = user.history.slice(-CONFIG.BEHAVIOR.MAX_HISTORY_CONTEXT);
    const contents = recentHistory.map(m => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.text }]
    }));

    contents.push({
        role: 'user',
        parts: [{ text: `[SYSTEM: ${mediaDesc}. You cannot see/hear it, but reply naturally like a friend. Be spontaneous, not templated.]` }]
    });

    let aiReply = await callGeminiWithHistory(contents, false);

    if (!aiReply) aiReply = "hmm, ye dekh nahi pa raha abhi. bata kya hai?";

    aiReply = aiReply.trim()
        .replace(new RegExp('^' + PROFILE.owner.name + ':\\s*', 'i'), '')
        .replace(/^["']|["']$/g, '')
        .replace(/^(Friend|You|User|Model):\s*/i, '');

    try { await sock.sendPresenceUpdate('paused', from); } catch (e) {}
    await sock.sendMessage(from, { text: aiReply });

    storage.appendMessage(user, 'model', aiReply);
    storage.saveUser(user);
    messageStats.sent++;
}

// ===================================================================
//                    OWNER COMMANDS
// ===================================================================
async function handleOwnerCommand(msg, from, text) {
    const cmd = text.toLowerCase().trim();
    const reply = async (t) => sock.sendMessage(from, { text: t }, { quoted: msg });

    if (cmd === '!pause') { isBotPaused = true; await reply('⏸️ Paused, Sir.'); return true; }
    if (cmd === '!resume') { isBotPaused = false; await reply('▶️ Resumed, Sir.'); return true; }
    if (cmd === '!ping') { await reply('🏓 At your service, Sir.'); return true; }

    if (cmd === '!stats') {
        const up = Math.floor((Date.now() - messageStats.startTime) / 60000);
        const s = storage.getStats();
        await reply(`📊 *System Status*\n\nSent: ${messageStats.sent}\nReceived: ${messageStats.received}\n\n*Storage:*\nTotal Users: ${s.totalUsers}\nActive (7d): ${s.activeUsers}\nTotal Msgs: ${s.totalMessages}\n\nUptime: ${up} min\n\nAll systems operational, Sir.`);
        return true;
    }

    if (cmd === '!backup') {
        storage.backupAll();
        await reply('💾 Backup created, Sir.');
        return true;
    }

    if (cmd === '!cleanup') {
        const n = storage.cleanupOldUsers();
        await reply(`🧹 Cleaned ${n} inactive users, Sir.`);
        return true;
    }

    if (cmd.startsWith('!history ')) {
        const targetId = cmd.substring(9).trim().replace(/\D/g, '');
        const u = storage.loadUser(targetId);
        const lines = u.history.slice(-5).map(h => `[${h.role}] ${h.text.substring(0, 50)}`).join('\n');
        await reply(`📜 *Last 5 msgs of ${targetId}:*\n\n${lines || '(no history)'}`);
        return true;
    }

    if (cmd.startsWith('!clear ')) {
        const targetId = cmd.substring(7).trim().replace(/\D/g, '');
        const u = storage.loadUser(targetId);
        u.history = [];
        storage.saveUser(u);
        await reply(`🗑️ History cleared for ${targetId}`);
        return true;
    }

    return false;
}

// ===================================================================
//                    MESSAGE ROUTER
// ===================================================================
async function handleIncomingMessage(msg) {
    try {
        const from = msg.key.remoteJid;
        if (from === 'status@broadcast') return;
        if (from.endsWith('@g.us')) return;

        messageStats.received++;

        if (CONFIG.BEHAVIOR.SEND_READ_RECEIPT) {
            try { await sock.readMessages([msg.key]); } catch (e) {}
        }

        const m = msg.message;
        if (!m) return;

        const text = m.conversation || m.extendedTextMessage?.text
            || m.imageMessage?.caption || m.videoMessage?.caption || null;

        if (text && text.startsWith('!')) {
            const handled = await handleOwnerCommand(msg, from, text);
            if (handled) return;
        }

        if (isBotPaused) return;

        if (m.imageMessage || m.audioMessage || m.documentMessage || m.videoMessage || m.stickerMessage) {
            if (text && text.trim()) {
                await handleTextMessage(msg, from, text);
            } else {
                await handleMediaMessage(msg, from);
            }
            return;
        }

        if (text) {
            await handleTextMessage(msg, from, text);
        }
    } catch (error) {
        messageStats.failed++;
        console.error('[ERROR]', error.message);
    }
}

// ===================================================================
//                    WEB SERVER
// ===================================================================
const app = express();

app.get('/', async (req, res) => {
    const status = isBotPaused ? 'PAUSED' : (currentQR ? 'WAITING QR' : 'ACTIVE');
    const up = Math.floor((Date.now() - messageStats.startTime) / 60000);
    const s = storage.getStats();

    if (currentQR) {
        try {
            const qrImage = await QRCode.toDataURL(currentQR, { width: 400, margin: 2 });
            res.send(`<html><head><title>JARVIS QR</title></head>
                <body style="text-align:center;font-family:Arial;padding:20px;background:#0f0f0f;color:#fff;">
                <h1 style="color:#00BFFF;">J.A.R.V.I.S</h1>
                <img src="${qrImage}" style="width:400px;height:400px;border:10px solid white;border-radius:10px;background:#fff;"/>
                <script>setTimeout(()=>location.reload(),20000);</script>
                </body></html>`);
        } catch (e) { res.send('QR error: ' + e.message); }
    } else {
        res.send(`<html><head><title>JARVIS</title></head>
            <body style="text-align:center;font-family:Arial;padding:50px;background:#0f0f0f;color:#fff;">
            <h1 style="color:#00BFFF;">J.A.R.V.I.S</h1>
            <h2 style="color:#25D366;">✅ ${status}</h2>
            <p>Owner: <strong>${PROFILE.owner.name}</strong></p>
            <hr style="border-color:#333;margin:20px auto;width:400px;">
            <h3>📊 Multi-User Storage</h3>
            <p>Total Users: <strong>${s.totalUsers}</strong></p>
            <p>Active (7d): <strong>${s.activeUsers}</strong></p>
            <p>Total Messages: <strong>${s.totalMessages}</strong></p>
            <p>Sent: ${messageStats.sent} | Uptime: ${up}m</p>
            <script>setTimeout(()=>location.reload(),15000);</script>
            </body></html>`);
    }
});

app.listen(CONFIG.PORT, () => {
    console.log(`[SERVER] Port ${CONFIG.PORT}`);
    console.log(`[JARVIS] Owner: ${PROFILE.owner.name}`);
    console.log(`[MODE] 24/7 | Multi-User Context`);
    console.log(`[MODELS] ${CONFIG.MODELS.join(', ')}`);
});

// ===================================================================
//                    WHATSAPP CONNECTION
// ===================================================================
async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info');
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            markOnlineOnConnect: false,
            browser: ['Ubuntu', 'Chrome', '22.04.4']
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                currentQR = qr;
                console.log('[QR] NEW QR - Open Railway URL');
            }
            if (connection === 'close') {
                currentQR = null;
                const code = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output?.statusCode : 0;
                const shouldReconnect = code !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    reconnectAttempts++;
                    setTimeout(connectToWhatsApp, Math.min(5000 * reconnectAttempts, 60000));
                }
            } else if (connection === 'open') {
                currentQR = null;
                reconnectAttempts = 0;
                console.log('[CONN] ✅ CONNECTED SUCCESSFULLY!');
                console.log('[JARVIS] Multi-user mode active, Sir.');
                if (storage.CONFIG.BACKUP_ON_START) storage.backupAll();
            }
        });

        sock.ev.on('messages.upsert', async (m) => {
            if (m.type !== 'notify') return;
            const msg = m.messages[0];
            if (!msg || !msg.message || msg.key.fromMe) return;
            await handleIncomingMessage(msg);
        });
    } catch (err) {
        console.error('[CONN] Error:', err.message);
        setTimeout(connectToWhatsApp, 10000);
    }
}

// ===================================================================
//                    START
// ===================================================================
console.log('═══════════════════════════════════════════');
console.log('  J.A.R.V.I.S v10.1 - Multi-User Edition');
console.log(`  Owner: ${PROFILE.owner.name}`);
console.log(`  Models: ${CONFIG.MODELS.join(', ')}`);
console.log(`  Max history/user: ${storage.CONFIG.MAX_HISTORY_PER_USER}`);
console.log(`  Cleanup after: ${storage.CONFIG.CLEANUP_DAYS} days`);
console.log('═══════════════════════════════════════════');
connectToWhatsApp();

// Auto-cleanup daily
setInterval(() => storage.cleanupOldUsers(), 24 * 60 * 60 * 1000);

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n[SHUTDOWN] Saving all...');
    storage.backupAll();
    process.exit(0);
});
process.on('SIGTERM', () => {
    storage.backupAll();
    process.exit(0);
});
