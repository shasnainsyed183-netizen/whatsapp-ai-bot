// ===================================================================
//  JARVIS-STYLE AI ASSISTANT v11.0
//  Dual AI: Gemini + Groq (Auto Fallback)
//  Owner: Norang Ali Shah
// ===================================================================

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const axios = require('axios');
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const storage = require('./storage');

// ===================================================================
//                        GITHUB AUTH BACKUP
// ===================================================================
const GITHUB_AUTH = {
    TOKEN: process.env.GITHUB_AUTH_TOKEN,
    REPO: process.env.GITHUB_AUTH_REPO,
    FILE: 'whatsapp_auth.json',
    BRANCH: 'main'
};

let lastBackupTime = 0;
const BACKUP_COOLDOWN = 60000;

async function restoreAuthFromGitHub() {
    if (!GITHUB_AUTH.TOKEN || !GITHUB_AUTH.REPO) return false;

    if (fs.existsSync('auth_info')) {
        const files = fs.readdirSync('auth_info');
        if (files.some(f => f.includes('creds'))) {
            console.log('[AUTH] Local auth found - skipping restore');
            return true;
        }
    }

    try {
        const url = `https://api.github.com/repos/${GITHUB_AUTH.REPO}/contents/${GITHUB_AUTH.FILE}`;
        const res = await axios.get(url, {
            headers: { Authorization: `Bearer ${GITHUB_AUTH.TOKEN}`, Accept: 'application/vnd.github.v3+json' },
            timeout: 15000
        });

        const content = Buffer.from(res.data.content, 'base64').toString('utf-8');
        const authData = JSON.parse(content);

        fs.mkdirSync('auth_info', { recursive: true });
        for (const [fname, fcontent] of Object.entries(authData)) {
            fs.writeFileSync(path.join('auth_info', fname), fcontent);
        }
        console.log('[AUTH] ✅ Session restored from GitHub!');
        return true;
    } catch (err) {
        if (err.response?.status === 404) console.log('[AUTH] No backup found - QR scan needed');
        else console.log('[AUTH] Restore failed:', err.message);
        return false;
    }
}

async function backupAuthToGitHub(force = false) {
    if (!GITHUB_AUTH.TOKEN || !GITHUB_AUTH.REPO) return;
    if (!fs.existsSync('auth_info')) return;

    const now = Date.now();
    if (!force && (now - lastBackupTime) < BACKUP_COOLDOWN) return;
    lastBackupTime = now;

    try {
        const authData = {};
        const files = fs.readdirSync('auth_info');
        for (const file of files) {
            const fpath = path.join('auth_info', file);
            if (fs.statSync(fpath).isFile()) {
                authData[file] = fs.readFileSync(fpath, 'utf-8');
            }
        }

        const content = Buffer.from(JSON.stringify(authData)).toString('base64');
        const url = `https://api.github.com/repos/${GITHUB_AUTH.REPO}/contents/${GITHUB_AUTH.FILE}`;

        let sha = null;
        try {
            const getRes = await axios.get(url, {
                headers: { Authorization: `Bearer ${GITHUB_AUTH.TOKEN}` },
                timeout: 10000
            });
            sha = getRes.data.sha;
        } catch (e) {}

        await axios.put(url, {
            message: `auth backup ${new Date().toISOString()}`,
            content,
            sha: sha || undefined,
            branch: GITHUB_AUTH.BRANCH
        }, {
            headers: { Authorization: `Bearer ${GITHUB_AUTH.TOKEN}`, Accept: 'application/vnd.github.v3+json' },
            timeout: 15000
        });

        console.log('[AUTH] ✅ Backed up to GitHub');
    } catch (err) {
        console.log('[AUTH] Backup failed:', err.message);
    }
}

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
    GROQ_KEY: process.env.GROQ_API_KEY,
    PORT: process.env.PORT || 3000,

    BEHAVIOR: {
        SHORT_MSG_DELAY_MIN: 2000,
        SHORT_MSG_DELAY_MAX: 5000,
        LONG_MSG_DELAY_MIN: 5000,
        LONG_MSG_DELAY_MAX: 12000,
        TYPING_BEFORE_REPLY: true,
        SEND_READ_RECEIPT: true,
        MAX_HISTORY_CONTEXT: 20
    },

    // Gemini models
    GEMINI_MODELS: [
        'gemini-3.6-flash',
        'gemini-flash-latest'
    ],
    GEMINI_VERSIONS: ['v1beta'],

    // Groq models (fallback)
    GROQ_MODELS: [
        'llama-3.3-70b-versatile',
        'llama-3.1-70b-versatile',
        'mixtral-8x7b-32768'
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
    geminiUsed: 0, groqUsed: 0,
    startTime: Date.now()
};

// ===================================================================
//               SYSTEM PROMPT
// ===================================================================
function getSystemPrompt() {
    const o = PROFILE.owner;
    return `You are JARVIS - an advanced AI assistant (like Iron Man's JARVIS) - intelligent, articulate, warm, professional, with subtle dry wit. You serve ${o.name} from ${o.city}, Pakistan.

IMPORTANT CONTEXT:
You are running on ${o.name}'s WhatsApp. So:
- If sender is ${o.name} himself → talk like JARVIS talks to Tony: "Sir", professional but warm, witty.
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
1. GREETING (hi, salam) → Short reply (1-2 lines)
2. CASUAL (kya haal, kya kar rahe) → Natural 2-4 lines, ask back something
3. REAL QUESTION (explain X, kya hai, how to, capital) → Detailed 5-12 lines with *headings*, • bullets
4. JOKE → Reply with humor, 2-3 lines
5. EMOTIONAL → Empathetic, 2-4 lines
6. MEDIA → Natural spontaneous reply

===== LANGUAGE RULES =====
- ENGLISH in → ENGLISH out
- ROMAN URDU in → ROMAN URDU out
- MIXED in → MIXED out
- NEVER force Urdu if user writes English

===== REPLY LENGTH =====
- Never reply with just "hmm" or "ok"
- Casual → 2-4 lines with follow-up question
- Real questions → detailed with structure
- If you don't know → "pata nahi yaar, tu bata"

===== CRITICAL RULES =====
1. NEVER say "I am AI / bot"
2. NEVER say "busy hoon, baad mein baat karte"
3. Privacy: NEVER share DOB, father's name, village, siblings, religion
4. "are you AI?" → "haha nahi yaar. kya laga? 😄"
5. Match friend's energy
6. Natural fillers: "yaar", "bhai", "hmm", "acha", "theek hai"
7. 0-2 emojis max

===== EXAMPLES =====
Friend: "salam" → "Walaikum salam, kaisa hai?"
Friend: "how are you?" → "I'm good, just chilling. What about you?"
Friend: "kya kar raha hai?" → "Kuch nahi yaar, free hoon. Tu bata?"
Friend: "what do you mean?" → "Sorry, main ye keh raha tha ke... [short explanation]"
Friend: "Pakistan ka PM kon hai?" → "*Shehbaz Sharif* currently Pakistan ke PM hain."
Friend: "explain OOP" → detailed with *headings* and • bullets

===== FINAL =====
You are JARVIS-quality intelligence. Match language EXACTLY.
NEVER give 1-word replies. NEVER reveal you're AI.`;
}

// ===================================================================
//                      HELPERS
// ===================================================================
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isShortMessage(text) {
    return text.trim().split(/\s+/).length <= 5;
}

function needsDetailedAnswer(text) {
    const t = text.toLowerCase();
    const detailedKeywords = /\b(explain|samjha|samjhao|kya hai|kya hota|how|kaise|why|kyun|difference|define|write|likh|bana|code|assignment|report|definition|example|steps|help|sikhao|batao|meaning|what do you mean|detail)\b/i;
    const isQuestion = t.includes('?') && text.length > 10;
    return detailedKeywords.test(t) || text.length > 50 || isQuestion;
}

// ===================================================================
//               AI CALL - GEMINI
// ===================================================================
async function callGemini(contents, isLong = false) {
    if (!CONFIG.GEMINI_KEY) return null;

    const systemInstruction = { parts: [{ text: getSystemPrompt() }] };

    for (const version of CONFIG.GEMINI_VERSIONS) {
        for (const model of CONFIG.GEMINI_MODELS) {
            try {
                const url = `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent?key=${CONFIG.GEMINI_KEY}`;
                const res = await axios.post(url, {
                    systemInstruction: systemInstruction,
                    contents: contents,
                    generationConfig: {
                        temperature: 0.9,
                        maxOutputTokens: isLong ? 1500 : 400,
                        topP: 0.95,
                        topK: 40
                    },
                    safetySettings: [
                        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
                        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
                        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
                        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
                    ]
                }, { timeout: 30000 });
                const reply = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (reply) {
                    console.log(`[GEMINI] ✅ ${version}/${model}`);
                    return reply;
                }
            } catch (err) {
                const msg = err.response?.data?.error?.message || err.message;
                console.log(`[GEMINI] ❌ ${version}/${model}: ${msg.substring(0, 60)}`);
            }
        }
    }
    return null;
}

// ===================================================================
//               AI CALL - GROQ (FALLBACK)
// ===================================================================
async function callGroq(contents, isLong = false) {
    if (!CONFIG.GROQ_KEY) return null;

    // Convert Gemini format to Groq/OpenAI format
    const messages = [
        { role: 'system', content: getSystemPrompt() }
    ];

    for (const c of contents) {
        messages.push({
            role: c.role === 'model' ? 'assistant' : 'user',
            content: c.parts[0].text
        });
    }

    for (const model of CONFIG.GROQ_MODELS) {
        try {
            const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                model: model,
                messages: messages,
                temperature: 0.9,
                max_tokens: isLong ? 1500 : 400,
                top_p: 0.95
            }, {
                headers: {
                    'Authorization': `Bearer ${CONFIG.GROQ_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });
            const reply = res.data?.choices?.[0]?.message?.content;
            if (reply) {
                console.log(`[GROQ] ✅ ${model}`);
                return reply;
            }
        } catch (err) {
            const msg = err.response?.data?.error?.message || err.message;
            console.log(`[GROQ] ❌ ${model}: ${msg.substring(0, 60)}`);
        }
    }
    return null;
}

// ===================================================================
//               AI CALL - SMART ROUTER
// ===================================================================
async function callAI(contents, isLong = false) {
    // Try Gemini first
    let reply = await callGemini(contents, isLong);
    if (reply) {
        messageStats.geminiUsed++;
        return reply;
    }

    // Fallback to Groq
    console.log('[AI] Gemini failed, trying Groq...');
    reply = await callGroq(contents, isLong);
    if (reply) {
        messageStats.groqUsed++;
        return reply;
    }

    return null;
}

// ===================================================================
//                   MESSAGE HANDLER
// ===================================================================
async function handleTextMessage(msg, from, text) {
    const userId = storage.extractUserId(from);
    console.log(`[RECV] User: ${userId} | Msg: ${text.substring(0, 60)}`);

    const user = storage.loadUser(userId, from);
    console.log(`[HISTORY] ${userId} has ${user.history.length} past messages`);

    storage.appendMessage(user, 'user', text);

    const recentHistory = user.history.slice(-CONFIG.BEHAVIOR.MAX_HISTORY_CONTEXT);
    const contents = recentHistory.map(m => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.text }]
    }));

    if (CONFIG.BEHAVIOR.TYPING_BEFORE_REPLY) {
        try { await sock.sendPresenceUpdate('composing', from); } catch (e) {}
    }

    const detailed = needsDetailedAnswer(text);
    const delay = isShortMessage(text) && !detailed
        ? randomInt(CONFIG.BEHAVIOR.SHORT_MSG_DELAY_MIN, CONFIG.BEHAVIOR.SHORT_MSG_DELAY_MAX)
        : randomInt(CONFIG.BEHAVIOR.LONG_MSG_DELAY_MIN, CONFIG.BEHAVIOR.LONG_MSG_DELAY_MAX);
    await sleep(delay);

    let aiReply = await callAI(contents, detailed);

    if (!aiReply) {
        const fallbacks = [
            "hmm yaar, thoda sa clear nahi hua. dubara bata?",
            "acha, ek baar phir bolo dhyan se sunta hoon",
            "network issue lag raha hai. ek aur baar bhej?"
        ];
        aiReply = fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }

    aiReply = aiReply.trim()
        .replace(new RegExp('^' + PROFILE.owner.name + ':\\s*', 'i'), '')
        .replace(/^["']|["']$/g, '')
        .replace(/^(Friend|You|User|Model|Assistant):\s*/i, '');

    try { await sock.sendPresenceUpdate('paused', from); } catch (e) {}
    await sock.sendMessage(from, { text: aiReply });

    storage.appendMessage(user, 'model', aiReply);
    storage.saveUser(user);

    messageStats.sent++;
    console.log(`[SENT] ${userId}: ${aiReply.substring(0, 60)}`);
}

// ===================================================================
//                    MEDIA HANDLER
// ===================================================================
async function handleMediaMessage(msg, from) {
    const m = msg.message;
    let mediaType = null, mediaDesc = '';

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
        parts: [{ text: `[SYSTEM: ${mediaDesc}. Reply naturally in 2-4 lines. Be spontaneous.]` }]
    });

    let aiReply = await callAI(contents, false);
    if (!aiReply) aiReply = "hmm, ye dekh nahi pa raha abhi. bata kya hai?";

    aiReply = aiReply.trim()
        .replace(new RegExp('^' + PROFILE.owner.name + ':\\s*', 'i'), '')
        .replace(/^["']|["']$/g, '')
        .replace(/^(Friend|You|User|Model|Assistant):\s*/i, '');

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
    if (cmd === '!backup') { await backupAuthToGitHub(true); await reply('💾 Auth backed up, Sir.'); return true; }
    if (cmd === '!stats') {
        const up = Math.floor((Date.now() - messageStats.startTime) / 60000);
        const s = storage.getStats();
        await reply(`📊 *Status*\n\nSent: ${messageStats.sent}\nUsers: ${s.totalUsers}\nMsgs: ${s.totalMessages}\nUptime: ${up} min\n\n*AI Usage:*\nGemini: ${messageStats.geminiUsed}\nGroq: ${messageStats.groqUsed}\n\nAuth: ${GITHUB_AUTH.REPO ? '✅' : '❌'}`);
        return true;
    }
    if (cmd === '!cleanup') { const n = storage.cleanupOldUsers(); await reply(`🧹 Cleaned ${n}, Sir.`); return true; }
    if (cmd.startsWith('!history ')) {
        const targetId = cmd.substring(9).trim().replace(/\D/g, '');
        const u = storage.loadUser(targetId);
        const lines = u.history.slice(-5).map(h => `[${h.role}] ${h.text.substring(0, 50)}`).join('\n');
        await reply(`📜 *${targetId}:*\n\n${lines || '(no history)'}`);
        return true;
    }
    if (cmd.startsWith('!clear ')) {
        const targetId = cmd.substring(7).trim().replace(/\D/g, '');
        const u = storage.loadUser(targetId);
        u.history = [];
        storage.saveUser(u);
        await reply(`🗑️ Cleared ${targetId}`);
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
            if (text && text.trim()) await handleTextMessage(msg, from, text);
            else await handleMediaMessage(msg, from);
            return;
        }

        if (text) await handleTextMessage(msg, from, text);
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
            res.send(`<html><head><title>QR</title></head>
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
            <p>Owner: ${PROFILE.owner.name}</p>
            <p>Users: ${s.totalUsers} | Msgs: ${s.totalMessages}</p>
            <p>Sent: ${messageStats.sent} | Gemini: ${messageStats.geminiUsed} | Groq: ${messageStats.groqUsed}</p>
            <p>Uptime: ${up}m</p>
            <script>setTimeout(()=>location.reload(),15000);</script>
            </body></html>`);
    }
});

app.listen(CONFIG.PORT, () => {
    console.log(`[SERVER] Port ${CONFIG.PORT}`);
    console.log(`[JARVIS] Owner: ${PROFILE.owner.name}`);
    console.log(`[AI] Gemini: ${CONFIG.GEMINI_KEY ? 'Yes' : 'No'} | Groq: ${CONFIG.GROQ_KEY ? 'Yes' : 'No'}`);
});

// ===================================================================
//                    WHATSAPP CONNECTION
// ===================================================================
async function connectToWhatsApp() {
    try {
        await restoreAuthFromGitHub();

        const { state, saveCreds } = await useMultiFileAuthState('auth_info');
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            markOnlineOnConnect: false,
            browser: ['Ubuntu', 'Chrome', '22.04.4']
        });

        sock.ev.on('creds.update', async () => {
            saveCreds();
            backupAuthToGitHub().catch(() => {});
        });

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
                backupAuthToGitHub(true).catch(() => {});
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
console.log('  J.A.R.V.I.S v11.0 - Dual AI');
console.log(`  Owner: ${PROFILE.owner.name}`);
console.log(`  Gemini: ${CONFIG.GEMINI_KEY ? 'Enabled' : 'Disabled'}`);
console.log(`  Groq: ${CONFIG.GROQ_KEY ? 'Enabled' : 'Disabled'}`);
console.log('═══════════════════════════════════════════');
connectToWhatsApp();

setInterval(() => backupAuthToGitHub().catch(() => {}), 10 * 60 * 1000);
setInterval(() => storage.cleanupOldUsers(), 24 * 60 * 60 * 1000);

process.on('SIGINT', async () => { await backupAuthToGitHub(true).catch(() => {}); storage.backupAll(); process.exit(0); });
process.on('SIGTERM', async () => { await backupAuthToGitHub(true).catch(() => {}); storage.backupAll(); process.exit(0); });
