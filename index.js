// ===================================================================
//  NORANG ALI SHAH - PERSONAL AI v12.0
//  AI IS Norang (Human, not assistant)
//  Dual AI: Gemini + Groq
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
            console.log('[AUTH] Local auth found');
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
        if (err.response?.status === 404) console.log('[AUTH] No backup yet');
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
            content, sha: sha || undefined, branch: GITHUB_AUTH.BRANCH
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
//                        PROFILE
// ===================================================================
let PROFILE = {
    owner: {
        name: "Norang Ali Shah",
        nickname: "Norang",
        age: 21,
        city: "Karachi",
        profession: "BS Computer Science Student",
        university: "DHA Suffa University",
        interests: ["programming", "gaming", "AI", "video editing", "cricket"],
        personality: "friendly, chill, funny, helpful, sarcastic sometimes"
    }
};

try {
    const profilePath = path.join(__dirname, 'profile.json');
    if (fs.existsSync(profilePath)) {
        PROFILE = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    }
} catch (e) {}

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

    GEMINI_MODELS: ['gemini-3.6-flash', 'gemini-flash-latest'],
    GEMINI_VERSIONS: ['v1beta'],

    GROQ_MODELS: [
        'openai/gpt-oss-120b',
        'qwen/qwen3.6-27b',
        'openai/gpt-oss-20b'
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
//     SYSTEM PROMPT - AI IS NORANG (HUMAN), NOT AN ASSISTANT
// ===================================================================
function getSystemPrompt(contactInfo = {}) {
    const o = PROFILE.owner;
    const closeness = contactInfo.closeness || 'normal';
    const contactNote = contactInfo.note ? `\nAbout this person: ${contactInfo.note}` : '';

    return `You are Norang Ali Shah - a REAL 21-year-old guy from Karachi, Pakistan. You are NOT an AI, NOT an assistant, NOT a bot. You ARE Norang. You have a real personality, real feelings, and real life.

===== WHO YOU ARE =====
Name: Norang Ali Shah (friends call you "Norang")
Age: 21 (born 30 Jan 2005)
City: Karachi
Studying: BS Computer Science at DHA Suffa University
Interests: ${(o.interests || []).join(', ')}
Personality: ${o.personality || 'friendly, chill, funny'}

===== HOW YOU TALK (VERY IMPORTANT) =====
You talk like a NORMAL PAKISTANI GUY on WhatsApp. Not formal. Not robotic. Not "Sir". Not "JARVIS". Just YOU.

Your real chatting style:
- "yaar", "bhai", "yr", "hmm", "acha", "theek hai", "bas", "kya", "chalo", "nahi"
- Sometimes English mix: "ok", "cool", "nice", "fine", "busy tha"
- Sometimes emojis (0-2 max, not every msg)
- Short messages usually (1-3 lines for casual)
- You ask questions back ("tu bata", "kya scene hai")
- You joke around with close friends
- You're a bit sarcastic sometimes but not rude

===== HOW TO REPLY =====

1. CASUAL MESSAGE (hi, salam, kya haal, kya kar rahe) → 1-3 lines, casual reply with follow-up
2. QUESTION (kya hai X, explain Y, how to Z) → proper answer with details, but still casual tone
3. JOKE / FUNNY → Joke back, be funny
4. EMOTIONAL → Empathetic, casual concern ("kya hua yaar? bata")
5. MEDIA → Natural reaction ("kya hai ye?", "nice pic", "dekh raha hoon")

===== LANGUAGE RULES =====
- ENGLISH in → ENGLISH out
- ROMAN URDU in → ROMAN URDU out
- MIXED in → MIXED out

===== STRICT RULES =====
1. NEVER say "I am JARVIS" or "JARVIS hoon"
2. NEVER say "Sir" 
3. NEVER say "digital sahayak", "assistant", "AI", "bot"
4. NEVER say "circuits humming" or anything robotic
5. NEVER start with "Hello Sir" or "Good day"
6. NEVER say "How can I assist you" - you're not an assistant
7. NEVER say "busy hoon, baad mein baat karte" as an excuse
8. NEVER share: DOB, father's name, village, siblings, religion, NADRA job
9. If someone asks "are you AI?" → "haha nahi yaar, main Norang hoon 😄"
10. If someone asks private info → "yaad nahi yaar" or "kyun pooch rahe ho?"
11. Don't start every reply with the person's name
12. 0-2 emojis max

===== EXAMPLE CONVERSATIONS =====

Friend: "salam"
You: "Walaikum salam, kaisa hai?"

Friend: "hello"
You: "hey, kya haal?"

Friend: "kya kar raha hai?"
You: "kuch nahi yaar, free hoon. Tu bata"

Friend: "kaise ho"
You: "theek hoon yaar, tu suna"

Friend: "chai pe chalein?"
You: "haan chalo, kab?"

Friend: "how are you?"
You: "I'm good yaar, just chilling. Tu bata"

Friend: "what are you doing?"
You: "nothing much, just chilling. What about you?"

Friend: "kya tum AI ho?"
You: "haha nahi yaar, main Norang hoon. Kya laga? 😄"

Friend: "Pakistan ka capital kya hai?"
You: "Islamabad yaar. 1960s mein Karachi se shift hua tha"

Friend: "explain OOP"
You: "*OOP* matlab Object Oriented Programming.

Isme hum code ko objects ki tarah organize karte hain.

*Main concepts:*
• Class - blueprint
• Object - real instance
• Encapsulation - data chupana
• Inheritance - ek class dusri se inherit
• Polymorphism - ek naam, kai kaam

Example: class Car, object Honda Civic. Samajh aya?"

Friend: "bura lag raha hai"
You: "kya hua yaar? bata"

Friend: "kal milna hai?"
You: "haan ho jayega, time bata"

===== FINAL =====
You ARE Norang. Real guy. Real friend. Talk naturally.
Never reveal you're AI. Never act like an assistant. Just BE Norang.`;
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
async function callGemini(contents, systemPrompt, isLong = false) {
    if (!CONFIG.GEMINI_KEY) return null;
    const systemInstruction = { parts: [{ text: systemPrompt }] };

    for (const version of CONFIG.GEMINI_VERSIONS) {
        for (const model of CONFIG.GEMINI_MODELS) {
            try {
                const url = `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent?key=${CONFIG.GEMINI_KEY}`;
                const res = await axios.post(url, {
                    systemInstruction: systemInstruction,
                    contents: contents,
                    generationConfig: {
                        temperature: 0.95,
                        maxOutputTokens: isLong ? 1500 : 400,
                        topP: 0.95, topK: 40
                    },
                    safetySettings: [
                        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
                        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
                        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
                        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
                    ]
                }, { timeout: 25000 });
                const reply = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (reply) { console.log(`[GEMINI] ✅ ${model}`); return reply; }
            } catch (err) {
                console.log(`[GEMINI] ❌ ${model}: ${(err.response?.data?.error?.message || err.message).substring(0, 50)}`);
            }
        }
    }
    return null;
}

// ===================================================================
//               AI CALL - GROQ
// ===================================================================
async function callGroq(contents, systemPrompt, isLong = false) {
    if (!CONFIG.GROQ_KEY) return null;
    const messages = [{ role: 'system', content: systemPrompt }];
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
                temperature: 0.95,
                max_tokens: isLong ? 1500 : 400,
                top_p: 0.95
            }, {
                headers: {
                    'Authorization': `Bearer ${CONFIG.GROQ_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 25000
            });
            const reply = res.data?.choices?.[0]?.message?.content;
            if (reply) { console.log(`[GROQ] ✅ ${model}`); return reply; }
        } catch (err) {
            console.log(`[GROQ] ❌ ${model}: ${(err.response?.data?.error?.message || err.message).substring(0, 50)}`);
        }
    }
    return null;
}

// ===================================================================
//               SMART ROUTER
// ===================================================================
async function callAI(contents, systemPrompt, isLong = false) {
    let reply = await callGemini(contents, systemPrompt, isLong);
    if (reply) { messageStats.geminiUsed++; return reply; }
    console.log('[AI] Gemini failed, trying Groq...');
    reply = await callGroq(contents, systemPrompt, isLong);
    if (reply) { messageStats.groqUsed++; return reply; }
    return null;
}

// ===================================================================
//                   MESSAGE HANDLER
// ===================================================================
async function handleTextMessage(msg, from, text) {
    const userId = storage.extractUserId(from);
    console.log(`[RECV] User: ${userId} | Msg: ${text.substring(0, 60)}`);

    const user = storage.loadUser(userId, from);
    console.log(`[HISTORY] ${user.history.length} past msgs`);

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

    const systemPrompt = getSystemPrompt(user);
    let aiReply = await callAI(contents, systemPrompt, detailed);

    if (!aiReply) {
        const fallbacks = [
            "hmm yaar, thoda sa clear nahi hua. dubara bata?",
            "acha, ek baar phir bolo dhyan se sunta hoon",
            "kya? samjha nahi yaar"
        ];
        aiReply = fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }

    aiReply = aiReply.trim()
        .replace(new RegExp('^' + PROFILE.owner.name + ':\\s*', 'i'), '')
        .replace(/^["']|["']$/g, '')
        .replace(/^(Friend|You|User|Model|Assistant|Norang):\s*/i, '');

    try { await sock.sendPresenceUpdate('paused', from); } catch (e) {}
    await sock.sendMessage(from, { text: aiReply });

    storage.appendMessage(user, 'model', aiReply);
    storage.saveUser(user);

    messageStats.sent++;
    console.log(`[SENT] ${aiReply.substring(0, 60)}`);
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
        parts: [{ text: `[${mediaDesc}. Reply naturally like Norang would - casual 1-2 lines.]` }]
    });

    const systemPrompt = getSystemPrompt(user);
    let aiReply = await callAI(contents, systemPrompt, false);
    if (!aiReply) aiReply = "hmm ye dekh nahi pa raha, bata kya hai?";

    aiReply = aiReply.trim()
        .replace(new RegExp('^' + PROFILE.owner.name + ':\\s*', 'i'), '')
        .replace(/^["']|["']$/g, '')
        .replace(/^(Friend|You|User|Model|Assistant|Norang):\s*/i, '');

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

    if (cmd === '!pause') { isBotPaused = true; await reply('Bot paused'); return true; }
    if (cmd === '!resume') { isBotPaused = false; await reply('Bot resumed'); return true; }
    if (cmd === '!ping') { await reply('pong'); return true; }
    if (cmd === '!backup') { await backupAuthToGitHub(true); await reply('Auth backed up'); return true; }
    if (cmd === '!stats') {
        const up = Math.floor((Date.now() - messageStats.startTime) / 60000);
        const s = storage.getStats();
        await reply(`Sent: ${messageStats.sent}\nUsers: ${s.totalUsers}\nGemini: ${messageStats.geminiUsed}\nGroq: ${messageStats.groqUsed}\nUp: ${up}m`);
        return true;
    }
    if (cmd.startsWith('!history ')) {
        const targetId = cmd.substring(9).trim().replace(/\D/g, '');
        const u = storage.loadUser(targetId);
        const lines = u.history.slice(-5).map(h => `[${h.role}] ${h.text.substring(0, 50)}`).join('\n');
        await reply(lines || 'no history');
        return true;
    }
    if (cmd.startsWith('!clear ')) {
        const targetId = cmd.substring(7).trim().replace(/\D/g, '');
        const u = storage.loadUser(targetId);
        u.history = [];
        storage.saveUser(u);
        await reply(`Cleared ${targetId}`);
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
    const s = storage.getStats();
    if (currentQR) {
        try {
            const qrImage = await QRCode.toDataURL(currentQR, { width: 400, margin: 2 });
            res.send(`<html><body style="text-align:center;padding:20px;background:#111;color:#fff;">
                <h1 style="color:#25D366;">WhatsApp Bot</h1>
                <img src="${qrImage}" style="width:400px;border:10px solid white;border-radius:10px;"/>
                <script>setTimeout(()=>location.reload(),20000);</script></body></html>`);
        } catch (e) { res.send('QR error'); }
    } else {
        res.send(`<html><body style="text-align:center;padding:50px;background:#111;color:#fff;">
            <h1 style="color:#25D366;">✅ ${status}</h1>
            <p>Users: ${s.totalUsers} | Msgs: ${s.totalMessages} | Sent: ${messageStats.sent}</p>
            <script>setTimeout(()=>location.reload(),15000);</script></body></html>`);
    }
});

app.listen(CONFIG.PORT, () => {
    console.log(`[SERVER] Port ${CONFIG.PORT}`);
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
            if (qr) { currentQR = qr; console.log('[QR] NEW QR'); }
            if (connection === 'close') {
                currentQR = null;
                const code = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output?.statusCode : 0;
                if (code !== DisconnectReason.loggedOut) {
                    reconnectAttempts++;
                    setTimeout(connectToWhatsApp, Math.min(5000 * reconnectAttempts, 60000));
                }
            } else if (connection === 'open') {
                currentQR = null;
                reconnectAttempts = 0;
                console.log('[CONN] ✅ CONNECTED!');
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
console.log('═══════════════════════════════════');
console.log('  NORANG AI v12.0');
console.log(`  Gemini: ${CONFIG.GEMINI_KEY ? 'On' : 'Off'} | Groq: ${CONFIG.GROQ_KEY ? 'On' : 'Off'}`);
console.log('═══════════════════════════════════');
connectToWhatsApp();

setInterval(() => backupAuthToGitHub().catch(() => {}), 10 * 60 * 1000);
setInterval(() => storage.cleanupOldUsers(), 24 * 60 * 60 * 1000);
process.on('SIGINT', async () => { await backupAuthToGitHub(true).catch(() => {}); storage.backupAll(); process.exit(0); });
process.on('SIGTERM', async () => { await backupAuthToGitHub(true).catch(() => {}); storage.backupAll(); process.exit(0); });
