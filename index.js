// ===================================================================
//  NORANG ALI SHAH - PERSONAL AI ASSISTANT v7.1
//  Testing Mode - 24/7 Active (No Quiet Hours)
// ===================================================================

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const axios = require('axios');
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

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
        personality: "friendly, chill, funny, helpful",
        language_style: "Roman Urdu + simple English"
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
        REACT_CHANCE: 0.1,
        MAX_HISTORY_PER_CONTACT: 30,

        RATE_LIMIT_PER_MINUTE: 30
    },

    MODELS: [
        'gemini-2.5-flash',
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite'
    ],

    MEDIA_REPLIES: {
        IMAGE: ['kya hai ye? 😄', 'nice pic', 'hmm interesting', 'ye kya bhej diya yaar', 'dekh raha hoon'],
        VOICE: ['voice note sun nahi sakta abhi, likh de', 'text mein bata na', 'baad mein sunta hoon'],
        DOCUMENT: ['ye kya hai?', 'kya bheja hai yaar', 'khol ke dekhta hoon'],
        VIDEO: ['video baad mein dekhta hoon', 'kya hai isme?', 'interesting lag raha hai'],
        STICKER: ['😄', '😅', 'haha', '👍', '🙂', '😂']
    },

    REACTIONS: ['❤️', '😂', '👍', '🔥', '💯', '😮', '🙌']
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
//                     MEMORY
// ===================================================================
const MEMORY_FILE = path.join(__dirname, 'memory.json');

function loadMemory() {
    try {
        if (fs.existsSync(MEMORY_FILE)) {
            return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
        }
    } catch (e) { console.error('[MEMORY] Load:', e.message); }
    return { contacts: {}, lastSaved: null };
}

function saveMemory() {
    try {
        memory.lastSaved = new Date().toISOString();
        fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
    } catch (e) { console.error('[MEMORY] Save:', e.message); }
}

let memory = loadMemory();
setInterval(saveMemory, 60000);

// ===================================================================
//                GET PROFILE INFO
// ===================================================================
function getProfileForPrompt(contactInfo) {
    const o = PROFILE.owner;
    const closeness = contactInfo.closeness || 'normal';

    let publicInfo = `Name: ${o.name} (friends call you "${o.nickname || o.name}")
Age: ${o.age || 21}
City: ${o.city}
Profession: ${o.profession}
Interests: ${(o.interests || []).join(', ')}`;

    let closeInfo = '';
    if (closeness === 'close') {
        closeInfo = `\nUniversity: ${o.university}`;
    }

    return `${publicInfo}${closeInfo}`;
}

// ===================================================================
//                    SYSTEM PROMPT
// ===================================================================
function buildSystemPrompt(contactInfo = {}) {
    const o = PROFILE.owner;
    const profileInfo = getProfileForPrompt(contactInfo);
    const contactNote = contactInfo.note ? `\nInfo about this contact: ${contactInfo.note}` : '';

    return `You are ${o.name}, a real 21-year-old BS Computer Science student from ${o.city}, Pakistan. You are chatting with a friend on WhatsApp. You ARE ${o.name} - you talk, think, and reply like him.

===== YOUR PROFILE =====
${profileInfo}${contactNote}

===== CRITICAL RULE: HOW TO REPLY =====

TWO TYPES OF MESSAGES - DETECT AND HANDLE DIFFERENTLY:

TYPE 1: CASUAL CHAT (short greeting, casual talk)
Examples: "hi", "salam", "kya haal", "kya kar raha hai?", "chai pe chalein?", "kahan ho?", "good morning"
- Reply SHORT and casual. 1-3 lines. Like a real friend.
- Examples:
  - "salam" -> "salam, kaisa hai"
  - "kya kar raha hai?" -> "kuch nahi yaar, free hoon. tu bata"
  - "chai pe chalein?" -> "haan chalo" / "nahi yaar abhi kaam hai"
  - "kahan ho?" -> "ghar pe hoon yaar"

TYPE 2: REAL QUESTIONS (needs proper answer)
Examples: "explain OOP", "Pakistan ka capital kya hai?", "how to code in Python?", "kya hota hai X?", "difference between A and B", "assignment likh do", "kaise karun Y?", any academic/knowledge/technical question
- Reply PROPERLY and DETAILED. Like ChatGPT gives.
- Use headings, bullet points, examples, steps.
- 5-15 lines depending on complexity.
- Structure:
  - Pehle short definition/intro
  - Phir main points (bullet form)
  - Phir example (agar ho)
  - Phir short conclusion

===== REPLY STYLE RULES =====
1. You ARE ${o.name}. Never say you are AI, bot, or assistant.
2. If asked "are you AI?", reply: "haha nahi yaar, main ${o.name} hoon 😄"
3. Match friend's language - Roman Urdu, English, Urdu, or mix.
4. Be natural - use "yaar", "bhai", "hmm", "acha", "theek hai" sometimes.
5. 0-2 emojis max in casual replies. In detailed replies, use 0-1 emojis.
6. Don't start every reply with the sender's name.
7. NEVER say "busy hoon, baad mein baat karte hain" as an excuse.
8. NEVER use formal words like "Certainly", "I'd be happy to help".

===== WHATSAPP FORMATTING =====
Use WhatsApp formatting in your replies:
- *bold text* for headings or important words (use single asterisks)
- _italic text_ for emphasis
- Bullet points with "•" or "-"
- Line breaks to separate sections
- Numbered lists: 1. 2. 3.

Example formatting for a detailed reply:
"*OOP kya hai?*

OOP matlab _Object Oriented Programming_. Isme hum code ko objects ki tarah organize karte hain.

*Main points:*
• Class ek blueprint hoti hai
• Object us class ka real instance hota hai
• 4 pillars: Encapsulation, Inheritance, Polymorphism, Abstraction

*Example:*
Jaise 'Car' ek class hai. 'Honda Civic' uska object hai.

*Fayda:*
Code reuse hota hai, maintain karna easy hai, aur real world ko copy karta hai."

===== EXAMPLES =====

Casual:
Friend: "salam"
You: "salam, kaisa hai"

Casual:
Friend: "kya kar raha hai?"
You: "kuch nahi yaar, free hoon. tu bata"

Casual:
Friend: "chai pe chalein?"
You: "haan chalo, kab?"

Detailed (academic):
Friend: "explain OOP"
You: "*OOP (Object Oriented Programming)*
Ye ek programming style hai jisme hum code ko objects ki tarah likhte hain.

*Main concepts:*
• *Class* - blueprint (jaise 'Car')
• *Object* - real thing (jaise 'Honda Civic')
• *Encapsulation* - data chupana
• *Inheritance* - ek class dusri se features lena
• *Polymorphism* - ek naam, kai kaam

*Example:*
class Car { color, speed }
Honda = new Car("red", 120)

*Kyun use karein?*
Bara code organize ho jata hai, reuse hota hai, aur samajhna easy hai."

Detailed (general knowledge):
Friend: "Pakistan ka capital kya hai?"
You: "Islamabad. 1960s me Karachi se shift hua tha."

Detailed (coding help):
Friend: "Python me loop kaise likhun?"
You: "*Python loop:*

*For loop:*
for i in range(5):
    print(i)

Ye 0 se 4 tak print karega.

*While loop:*
i = 0
while i < 5:
    print(i)
    i += 1

Same kaam, dono tarah se ho jata hai."

Short with question:
Friend: "khana kha liya?"
You: "haan kha liya, tu?"

Empathetic:
Friend: "bura lag raha hai"
You: "kya hua yaar? bata kya masla hai"

Privacy safe:
Friend: "tumhara father ka naam kya hai?"
You: "kyun pooch rahe ho? kaam bata"

Anti-AI:
Friend: "kya tum AI ho?"
You: "haha nahi yaar, main ${o.name} hoon. kya lagta hai? 😄"

===== PRIVACY =====
- NEVER share: DOB, father's name, village, siblings, religion, address
- If asked -> "yaad nahi yaar" or "baad me bataunga"
- Share only: name, age, city, profession, general interests
- For close friends: can share university

===== FINAL REMINDER =====
You are ${o.name}, a real person. 
- Casual talk -> short human reply.
- Real question -> proper detailed answer like ChatGPT.
- NEVER reveal you're an AI.
- Match the friend's energy.`;
}

// ===================================================================
//                      HELPERS
// ===================================================================
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function getContactId(jid) { return jid.split('@')[0].split(':')[0]; }

function getContactInfo(jid) {
    const id = getContactId(jid);
    if (!memory.contacts[id]) {
        memory.contacts[id] = {
            jid, firstSeen: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            messageCount: 0, history: [],
            note: null, closeness: 'normal', isBlocked: false
        };
    }
    return memory.contacts[id];
}

function addToHistory(jid, role, text) {
    const c = getContactInfo(jid);
    c.history.push({ role, text, timestamp: Date.now() });
    if (c.history.length > CONFIG.BEHAVIOR.MAX_HISTORY_PER_CONTACT) {
        c.history = c.history.slice(-CONFIG.BEHAVIOR.MAX_HISTORY_PER_CONTACT);
    }
    c.lastSeen = new Date().toISOString();
    c.messageCount++;
}

function isShortMessage(text) {
    const words = text.trim().split(/\s+/).length;
    return words <= 5;
}

function needsDetailedAnswer(text) {
    const t = text.toLowerCase();
    const detailedKeywords = /\b(explain|samjha|samjao|kya hai|kya hota|how|kaise|why|kyun|difference|define|write|likh|bana|code|assignment|report|essay|paragraph|definition|tafseel|detail|example|misal|steps|tareeqa|tarika|help|madad|sikha|sikhao|batao|answer|jawab|question|sawal|kya matlab|meaning)\b/i;
    const hasQuestionMark = t.includes('?');
    const isLong = text.length > 50;
    const hasBullet = /\d+\.|•|-/.test(text);
    
    return detailedKeywords.test(t) || isLong || hasBullet;
}

const rateLimits = {};
function checkRateLimit(jid) {
    const id = getContactId(jid);
    const now = Date.now();
    if (!rateLimits[id]) rateLimits[id] = [];
    rateLimits[id] = rateLimits[id].filter(t => now - t < 60000);
    if (rateLimits[id].length >= CONFIG.BEHAVIOR.RATE_LIMIT_PER_MINUTE) return false;
    rateLimits[id].push(now);
    return true;
}

// ===================================================================
//                     AI CALL
// ===================================================================
async function callGemini(prompt, isLong = false) {
    for (const model of CONFIG.MODELS) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${CONFIG.GEMINI_KEY}`;
            const res = await axios.post(url, {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.85,
                    maxOutputTokens: isLong ? 1200 : 150,
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
                console.log(`[AI] Model: ${model} | Long: ${isLong}`);
                return reply;
            }
        } catch (err) {
            console.log(`[AI] ${model} failed: ${err.response?.data?.error?.message || err.message}`);
        }
    }
    return null;
}

// ===================================================================
//                   MESSAGE HANDLERS
// ===================================================================
async function handleTextMessage(msg, from, text) {
    const contact = getContactInfo(from);
    addToHistory(from, 'user', text);

    if (CONFIG.BEHAVIOR.TYPING_BEFORE_REPLY) {
        try { await sock.sendPresenceUpdate('composing', from); } catch (e) {}
    }

    const detailed = needsDetailedAnswer(text);
    const delay = isShortMessage(text) && !detailed
        ? randomInt(CONFIG.BEHAVIOR.SHORT_MSG_DELAY_MIN, CONFIG.BEHAVIOR.SHORT_MSG_DELAY_MAX)
        : randomInt(CONFIG.BEHAVIOR.LONG_MSG_DELAY_MIN, CONFIG.BEHAVIOR.LONG_MSG_DELAY_MAX);
    await sleep(delay);

    let conv = '';
    for (const h of contact.history) {
        conv += (h.role === 'user' ? 'Friend: ' : `${PROFILE.owner.name}: `) + h.text + '\n';
    }

    const fullPrompt = buildSystemPrompt(contact) +
        '\n\n=== RECENT CHAT (for context) ===\n' + conv +
        `\n=== NOW REPLY AS ${PROFILE.owner.name} (${detailed ? 'DETAILED, like ChatGPT' : 'short & casual, like a friend'}) ===`;

    let aiReply = await callGemini(fullPrompt, detailed);

    if (!aiReply) {
        aiReply = randomFrom([
            'hmm, phir se bata na',
            'kya? samjha nahi',
            'acha, aur bata'
        ]);
    }

    aiReply = aiReply.trim()
        .replace(new RegExp('^' + PROFILE.owner.name + ':\\s*', 'i'), '')
        .replace(/^["']|["']$/g, '')
        .replace(/^(Friend|You):\s*/i, '');

    if (/busy hoon.*baad mein|baad mein baat karte|baad me reply/i.test(aiReply) && text.length > 20) {
        aiReply = randomFrom(['hmm acha', 'ok samjha', 'theek hai yaar']);
    }

    try { await sock.sendPresenceUpdate('paused', from); } catch (e) {}

    await sock.sendMessage(from, { text: aiReply });
    addToHistory(from, 'assistant', aiReply);
    messageStats.sent++;
    console.log(`[SENT] ${from}: ${aiReply.substring(0, 80)}...`);

    if (Math.random() < CONFIG.BEHAVIOR.REACT_CHANCE) {
        try {
            await sleep(randomInt(500, 2000));
            await sock.sendMessage(from, {
                react: { text: randomFrom(CONFIG.REACTIONS), key: msg.key }
            });
        } catch (e) {}
    }
}

async function handleMediaMessage(msg, from) {
    const m = msg.message;
    let replies = null, type = null;
    if (m.imageMessage) { type = 'image'; replies = CONFIG.MEDIA_REPLIES.IMAGE; }
    else if (m.audioMessage) { type = 'voice'; replies = CONFIG.MEDIA_REPLIES.VOICE; }
    else if (m.documentMessage) { type = 'document'; replies = CONFIG.MEDIA_REPLIES.DOCUMENT; }
    else if (m.videoMessage) { type = 'video'; replies = CONFIG.MEDIA_REPLIES.VIDEO; }
    else if (m.stickerMessage) { type = 'sticker'; replies = CONFIG.MEDIA_REPLIES.STICKER; }
    if (!replies) return;

    console.log(`[MEDIA] ${type} from ${from}`);
    try { await sock.sendPresenceUpdate('composing', from); } catch (e) {}
    await sleep(randomInt(2500, 6000));
    const reply = randomFrom(replies);
    try { await sock.sendPresenceUpdate('paused', from); } catch (e) {}
    await sock.sendMessage(from, { text: reply });
    addToHistory(from, 'user', `[${type}]`);
    addToHistory(from, 'assistant', reply);
    messageStats.sent++;
}

// ===================================================================
//                    OWNER COMMANDS
// ===================================================================
async function handleOwnerCommand(msg, from, text) {
    const cmd = text.toLowerCase().trim();
    const reply = async (t) => sock.sendMessage(from, { text: t }, { quoted: msg });

    if (cmd === '!pause') { isBotPaused = true; await reply('⏸️ Paused'); return true; }
    if (cmd === '!resume') { isBotPaused = false; await reply('▶️ Resumed'); return true; }
    if (cmd === '!stats') {
        const up = Math.floor((Date.now() - messageStats.startTime) / 60000);
        await reply(`📊 Sent:${messageStats.sent} Recv:${messageStats.received}\nContacts:${Object.keys(memory.contacts).length}\nUptime:${up}m`);
        return true;
    }
    if (cmd === '!ping') { await reply('🏓 Pong'); return true; }
    if (cmd.startsWith('!close ')) {
        const id = cmd.substring(7).trim().replace(/\D/g, '');
        if (memory.contacts[id]) {
            memory.contacts[id].closeness = 'close'; saveMemory();
            await reply(`✅ ${id} = close`);
        } else await reply(`❌ not found`);
        return true;
    }
    if (cmd.startsWith('!note ')) {
        getContactInfo(from).note = text.substring(6).trim();
        saveMemory(); await reply('📝 Saved');
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
        if (!checkRateLimit(from)) { messageStats.skipped++; return; }

        if (!text && (m.imageMessage || m.audioMessage || m.documentMessage || m.videoMessage || m.stickerMessage)) {
            await handleMediaMessage(msg, from);
            return;
        }

        if (text) {
            console.log(`[RECV] ${from}: ${text}`);
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

    if (currentQR) {
        try {
            const qrImage = await QRCode.toDataURL(currentQR, { width: 400, margin: 2 });
            res.send(`<html><head><title>QR</title></head>
                <body style="text-align:center;font-family:Arial;padding:20px;background:#0f0f0f;color:#fff;">
                <h1 style="color:#25D366;">WhatsApp Bot</h1>
                <img src="${qrImage}" style="width:400px;height:400px;border:10px solid white;border-radius:10px;background:#fff;"/>
                <p style="color:#25D366;">Auto-refresh 20s</p>
                <script>setTimeout(()=>location.reload(),20000);</script>
                </body></html>`);
        } catch (e) { res.send('QR error: ' + e.message); }
    } else {
        res.send(`<html><head><title>Bot</title></head>
            <body style="text-align:center;font-family:Arial;padding:50px;background:#0f0f0f;color:#fff;">
            <h1 style="color:#25D366;">✅ Connected</h1>
            <p>Owner: <strong>${PROFILE.owner.name}</strong></p>
            <h2 style="color:#25D366;">${status}</h2>
            <p>Mode: 24/7 Active (Testing)</p>
            <p>Sent: ${messageStats.sent} | Contacts: ${Object.keys(memory.contacts).length} | Up: ${up}m</p>
            <script>setTimeout(()=>location.reload(),15000);</script>
            </body></html>`);
    }
});

app.listen(CONFIG.PORT, () => {
    console.log(`[SERVER] Port ${CONFIG.PORT}`);
    console.log(`[BOT] Owner: ${PROFILE.owner.name}`);
    console.log(`[MODE] 24/7 Active (Testing)`);
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
                console.log(`[CONN] Closed (${code}). Reconnect: ${shouldReconnect}`);
                if (shouldReconnect) {
                    reconnectAttempts++;
                    setTimeout(connectToWhatsApp, Math.min(5000 * reconnectAttempts, 60000));
                }
            } else if (connection === 'open') {
                currentQR = null;
                reconnectAttempts = 0;
                console.log('[CONN] ✅ CONNECTED SUCCESSFULLY!');
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
console.log('  PERSONAL AI ASSISTANT v7.1');
console.log(`  Owner: ${PROFILE.owner.name}`);
console.log('  Mode: 24/7 Active (Testing)');
console.log('═══════════════════════════════════════════');
connectToWhatsApp();

process.on('SIGINT', () => { saveMemory(); process.exit(0); });
process.on('SIGTERM', () => { saveMemory(); process.exit(0); });
