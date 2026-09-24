// ===================================================================
//  NORANG AI v19.0 - FINAL COMPLETE EDITION
//  Author: Norang Ali Shah
//  Features: Preset roles, Dual AI, Multi-user, Auth backup, Media,
//            Silence rules, Closing detection, Role-based tone
// ===================================================================

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const axios = require('axios');
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

// ===================================================================
// ===================================================================
//              SECTION 1: STORAGE MODULE (Inline)
// ===================================================================
// ===================================================================
// Ye section per-user history aur metadata manage karta hai.
// Har user ka apna JSON file data/users/ folder mein save hota hai.
// ===================================================================

const STORAGE_CONFIG = {
    DATA_DIR: path.join(__dirname, 'data'),
    USERS_DIR: path.join(__dirname, 'data', 'users'),
    BACKUP_DIR: path.join(__dirname, 'data', 'backup'),
    MAX_HISTORY_PER_USER: 30,
    CLEANUP_DAYS: 90,
    BACKUP_ON_START: true
};

// Ensure folders exist
[STORAGE_CONFIG.DATA_DIR, STORAGE_CONFIG.USERS_DIR, STORAGE_CONFIG.BACKUP_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const storage = {
    // JID se sirf number nikalta hai (923153643080)
    extractUserId(jid) {
        return jid.split('@')[0].split(':')[0].replace(/\D/g, '');
    },

    // User ki JSON file ka path
    getUserFilePath(userId) {
        return path.join(STORAGE_CONFIG.USERS_DIR, `${userId}.json`);
    },

    // Naya empty user create karta hai
    createEmptyUser(userId, jid) {
        return {
            userId,
            jid,
            firstSeen: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            messageCount: 0,
            history: [],
            metadata: {
                name: null,
                note: null,
                closeness: 'normal',
                language: null,
                role: 'friend'   // teacher | close_friend | low_friend | family | stranger | friend
            }
        };
    },

    // User ki JSON file load karta hai
    loadUser(userId, jid = null) {
        const filePath = this.getUserFilePath(userId);
        try {
            if (fs.existsSync(filePath)) {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                if (!data.history) data.history = [];
                if (!data.metadata) data.metadata = { closeness: 'normal', role: 'friend' };
                if (!data.metadata.role) data.metadata.role = 'friend';
                return data;
            }
        } catch (err) {
            console.error(`[STORAGE] Error loading ${userId}:`, err.message);
        }
        return this.createEmptyUser(userId, jid);
    },

    // Atomic write: temp file likh kar rename karta hai (corruption se bachao)
    saveUser(user) {
        user.lastSeen = new Date().toISOString();
        const filePath = this.getUserFilePath(user.userId);
        try {
            const tmpPath = filePath + '.tmp';
            fs.writeFileSync(tmpPath, JSON.stringify(user, null, 2));
            fs.renameSync(tmpPath, filePath);
        } catch (err) {
            console.error(`[STORAGE] Save error ${user.userId}:`, err.message);
        }
    },

    // History mein message add karta hai
    appendMessage(user, role, text) {
        user.history.push({ role, text, timestamp: Date.now() });
        if (user.history.length > STORAGE_CONFIG.MAX_HISTORY_PER_USER) {
            user.history = user.history.slice(-STORAGE_CONFIG.MAX_HISTORY_PER_USER);
        }
        user.messageCount = (user.messageCount || 0) + 1;
    },

    // Total stats
    getStats() {
        try {
            const files = fs.readdirSync(STORAGE_CONFIG.USERS_DIR).filter(f => f.endsWith('.json'));
            let totalMessages = 0, activeUsers = 0;
            const now = Date.now();
            for (const file of files) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(STORAGE_CONFIG.USERS_DIR, file), 'utf8'));
                    totalMessages += data.messageCount || 0;
                    if (now - new Date(data.lastSeen).getTime() < 7 * 24 * 60 * 60 * 1000) activeUsers++;
                } catch (e) {}
            }
            return { totalUsers: files.length, activeUsers, totalMessages };
        } catch (err) {
            return { totalUsers: 0, activeUsers: 0, totalMessages: 0 };
        }
    },

    // Purane inactive users delete karta hai
    cleanupOldUsers() {
        try {
            const files = fs.readdirSync(STORAGE_CONFIG.USERS_DIR).filter(f => f.endsWith('.json'));
            const now = Date.now();
            const cutoff = STORAGE_CONFIG.CLEANUP_DAYS * 24 * 60 * 60 * 1000;
            let cleaned = 0;
            for (const file of files) {
                try {
                    const filePath = path.join(STORAGE_CONFIG.USERS_DIR, file);
                    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    if ((now - new Date(data.lastSeen).getTime()) > cutoff && (data.messageCount || 0) < 5) {
                        fs.copyFileSync(filePath, path.join(STORAGE_CONFIG.BACKUP_DIR, file));
                        fs.unlinkSync(filePath);
                        cleaned++;
                    }
                } catch (e) {}
            }
            if (cleaned > 0) console.log(`[STORAGE] Cleaned ${cleaned} users`);
            return cleaned;
        } catch (err) { return 0; }
    },

    // Saare users ka backup
    backupAll() {
        try {
            const files = fs.readdirSync(STORAGE_CONFIG.USERS_DIR).filter(f => f.endsWith('.json'));
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupFolder = path.join(STORAGE_CONFIG.BACKUP_DIR, `snapshot_${timestamp}`);
            fs.mkdirSync(backupFolder, { recursive: true });
            for (const file of files) {
                fs.copyFileSync(path.join(STORAGE_CONFIG.USERS_DIR, file), path.join(backupFolder, file));
            }
            console.log(`[STORAGE] Backup: ${files.length} users`);
        } catch (err) { console.error('[STORAGE] Backup error:', err.message); }
    }
};

// ===================================================================
// ===================================================================
//              SECTION 2: PRESET CONTACTS (Roles)
// ===================================================================
// ===================================================================
// ⚠️ ZAROORI: Yahan apne contacts ke roles set karein.
// Bot start hote hi ye automatically load ho jayenge.
// Format: "92XXXXXXXXXX": { role: "...", name: "...", note: "..." }
//
// Available roles:
//   teacher      = Respected (Sir/Ma'am, formal)
//   close_friend = Casual ("yaar", "bhai")
//   low_friend   = Dry, minimal (1-4 words)
//   family       = Respectful, no slang
//   stranger     = Polite, distant
//   friend       = Normal friendly (default)
// ===================================================================

const PRESET_CONTACTS = {
    // ===== CLOSE FRIENDS =====
    "923032968434": {
        role: "close_friend",
        name: "Abdul Haleem",
        note: "Classmate in university, hostel roommate"
    },
    "923482887184": {
        role: "close_friend",
        name: "Sameer Ahmed",
        note: "Uni mate, also hostel roommate"
    },

    // ===== TEACHERS =====
    "923153643080": {
        role: "teacher",
        name: "Hasnain Shah",
        note: "Teacher - always respectful"
    }

    // ===== Zyada contacts add karne ke liye pattern: =====
    // "923XXXXXXXXX": { role: "family", name: "Mama", note: "Mother" },
    // "923XXXXXXXXX": { role: "low_friend", name: "Ali", note: "Occasional" },
    // "923XXXXXXXXX": { role: "stranger", name: "Unknown" },
};

// Ye function bot start hone par har preset contact ka role force-set karta hai
function initializePresetContacts() {
    console.log('═══════════════════════════════════════════════════');
    console.log('[PRESET] Loading preset contacts...');
    let loaded = 0;
    const total = Object.keys(PRESET_CONTACTS).length;

    for (const [number, info] of Object.entries(PRESET_CONTACTS)) {
        try {
            const user = storage.loadUser(number);
            if (!user.metadata) user.metadata = {};
            user.metadata.role = info.role;
            user.metadata.name = info.name;
            if (info.note) user.metadata.note = info.note;
            storage.saveUser(user);
            loaded++;
            console.log(`[PRESET] ✅ ${number} → ${info.name} [${info.role}]`);
        } catch (err) {
            console.error(`[PRESET] ❌ Error for ${number}:`, err.message);
        }
    }

    console.log(`[PRESET] Loaded ${loaded}/${total} contacts`);
    console.log('═══════════════════════════════════════════════════');
}

// ===================================================================
// ===================================================================
//              SECTION 3: GITHUB AUTH BACKUP
// ===================================================================
// ===================================================================
// Ye section WhatsApp session ko GitHub par save karta hai.
// Isse Railway redeploy par QR dobara scan nahi karna padta.
// ===================================================================

const GITHUB_AUTH = {
    TOKEN: process.env.GITHUB_AUTH_TOKEN,
    REPO: process.env.GITHUB_AUTH_REPO,
    FILE: 'whatsapp_auth.json',
    BRANCH: 'main'
};

let lastBackupTime = 0;
const BACKUP_COOLDOWN = 60000;

// GitHub se auth restore karta hai (bot start par)
async function restoreAuthFromGitHub() {
    if (!GITHUB_AUTH.TOKEN || !GITHUB_AUTH.REPO) {
        console.log('[AUTH] GitHub backup not configured');
        return false;
    }

    // Local auth already hai to restore skip karo
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
            headers: {
                Authorization: `Bearer ${GITHUB_AUTH.TOKEN}`,
                Accept: 'application/vnd.github.v3+json'
            },
            timeout: 15000
        });

        const content = Buffer.from(res.data.content, 'base64').toString('utf-8');
        const authData = JSON.parse(content);

        fs.mkdirSync('auth_info', { recursive: true });
        for (const [fname, fcontent] of Object.entries(authData)) {
            fs.writeFileSync(path.join('auth_info', fname), fcontent);
        }

        console.log('[AUTH] ✅ Session restored from GitHub');
        return true;
    } catch (err) {
        if (err.response?.status === 404) console.log('[AUTH] No backup yet - QR scan needed');
        else console.log('[AUTH] Restore failed:', err.message);
        return false;
    }
}

// Auth ko GitHub par backup karta hai
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
            headers: {
                Authorization: `Bearer ${GITHUB_AUTH.TOKEN}`,
                Accept: 'application/vnd.github.v3+json'
            },
            timeout: 15000
        });

        console.log('[AUTH] ✅ Backed up to GitHub');
    } catch (err) {
        console.log('[AUTH] Backup failed:', err.message);
    }
}

// ===================================================================
// ===================================================================
//              SECTION 4: PROFILE DATA
// ===================================================================
// ===================================================================

let PROFILE = {
    owner: {
        name: "Norang Ali Shah",
        nickname: "Norang",
        age: 21,
        dob: "30 January 2005",
        city: "Karachi",
        profession: "BS Computer Science Student",
        university: "DHA Suffa University",
        interests: ["programming", "gaming", "AI", "video editing", "cricket"],
        personality: "friendly, chill, funny, sarcastic with friends, respectful with elders",
        education: {
            primary: "Village Sayed Noor Hassan School",
            secondary: "TCF High School Daharki",
            college: "Government Degree College MPM"
        },
        work: "Worked at NADRA in 2020",
        siblings: { brothers: 3, sisters: 4 }
    }
};

try {
    const profilePath = path.join(__dirname, 'profile.json');
    if (fs.existsSync(profilePath)) PROFILE = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
} catch (e) {}

// ===================================================================
// ===================================================================
//              SECTION 5: CONFIGURATION
// ===================================================================
// ===================================================================

const CONFIG = {
    GEMINI_KEY: process.env.GEMINI_KEY,
    GROQ_KEY: process.env.GROQ_API_KEY,
    PORT: process.env.PORT || 3000,

    BEHAVIOR: {
        // Message delay (human-like)
        SHORT_MSG_DELAY_MIN: 2000,
        SHORT_MSG_DELAY_MAX: 5000,
        MED_MSG_DELAY_MIN: 4000,
        MED_MSG_DELAY_MAX: 8000,
        LONG_MSG_DELAY_MIN: 6000,
        LONG_MSG_DELAY_MAX: 12000,

        TYPING_BEFORE_REPLY: true,
        SEND_READ_RECEIPT: true,
        MAX_HISTORY_CONTEXT: 20,

        // Lower temperature = more rule-following, less hallucination
        TEMPERATURE: 0.65,
        MAX_TOKENS_SHORT: 250,
        MAX_TOKENS_LONG: 900
    },

    // Gemini models (2026)
    GEMINI_MODELS: ['gemini-3.6-flash', 'gemini-flash-latest'],
    GEMINI_VERSIONS: ['v1beta'],

    // Groq models (fallback)
    GROQ_MODELS: ['openai/gpt-oss-120b', 'qwen/qwen3.6-27b', 'openai/gpt-oss-20b']
};

// ===================================================================
// ===================================================================
//              SECTION 6: STATE
// ===================================================================
// ===================================================================

let sock = null;
let currentQR = null;
let isBotPaused = false;
let reconnectAttempts = 0;

const messageStats = {
    sent: 0,
    received: 0,
    failed: 0,
    skipped: 0,
    geminiUsed: 0,
    groqUsed: 0,
    startTime: Date.now()
};

// ===================================================================
// ===================================================================
//              SECTION 7: SYSTEM PROMPT (STRICT)
// ===================================================================
// ===================================================================
// Ye function har message par AI ko instructions deta hai.
// Role ke hisaab se tone change hoti hai.
// ===================================================================

function getSystemPrompt(contactInfo = {}) {
    const o = PROFILE.owner;
    const role = contactInfo.role || 'friend';
    const contactName = contactInfo.name || '';
    const contactNote = contactInfo.note ? `\n[Contact Note]: ${contactInfo.note}` : '';
    const nameLine = contactName ? `\n[You are talking to: ${contactName}]` : '';

    // ===== BASE PROMPT (all roles) =====
    let prompt = `[IDENTITY & CONTEXT]
You are Norang Ali Shah - a REAL 21-year-old Pakistani guy from Karachi, chatting on WhatsApp.
You are NOT an AI, NOT a bot, NOT an assistant. You ARE Norang.
The person messaging is contacting YOUR WhatsApp number.
${nameLine}${contactNote}

[WHATSAPP CONTEXT]
- This is WhatsApp, NOT email. NO long paragraphs.
- Replies must be 1-3 lines SHORT (unless a real question needs detail).
- NEVER write essays or formal intros.
- NEVER say "Assalam o Alaikum! How can I help you today?"
- Directly address the message, casually.

[STRICT RULES - NEVER BREAK]
1. NEVER admit you're AI/bot/assistant. If asked: "haha nahi yaar, main Norang hoon 😄"
2. NEVER hallucinate facts about Norang's life, family, or past.
3. NEVER assume the user's identity/role.
4. NEVER repeat the user's message back to them.
5. NEVER ask a question in every message. Only when natural.
6. NEVER share: DOB, father's name, village, siblings, religion, NADRA job.
7. NEVER say "busy hoon, baad me baat karte" as excuse.
8. NEVER force conversation to continue. If user is short, BE short or silent.
9. NEVER use more than 1 emoji per message.

[LANGUAGE & STYLE]
- Match user's language: English→English, Roman Urdu→Roman Urdu, Mixed→Mixed.
- Common words (friends only): "yaar", "bhai", "hmm", "acha", "theek", "bas", "kya".
- Casual WhatsApp capitalization.
- NO bold/italic headings unless user asks a real question.

[CONVERSATION FLOW]
- User 1-word reply ("ok", "hmm") → You reply 1 word or stay silent.
- User short msg → Short reply (1-2 lines).
- User real question → Detailed answer (5-10 lines).
- User 2-3 dismissive replies in a row → STOP replying.
- User says "gtg"/"busy"/"baad me baat" → Reply "ok" / "chal theek hai" and STOP.

[SILENCE RULES]
- If user sends 4+ "ok"/"hmm"/"acha" → STAY SILENT.
- If user sends spam/forwarded links → No reaction.
- If conversation is naturally ending → Let it end, don't force.

[CONVERSATION CLOSING INDICATORS]
If user says any of: "thanks", "thank you", "ok", "okay", "shukriya", "jazakallah", "allah hafiz", "bye", "sahi hai", "theek hai", "phir baat hoti hai", "tc", "take care"
→ DO NOT start new topic. DO NOT ask questions. Briefly acknowledge and end.`;

    // ===== ROLE-SPECIFIC ADDITIONS =====
    if (role === 'teacher') {
        prompt += `

[ROLE: TEACHER / SENIOR / PROFESSOR]
⚠️ IMPORTANT: This person is your TEACHER. Be VERY respectful.

- Tone: HIGHLY respectful, formal, polite.
- Address as "Sir" or "Ma'am" ALWAYS.
- Use "aap" (NOT "tu" or "tum").
- 🚫 STRICTLY BANNED words: "bhai", "yaar", "bro", "chal", "scene", "lol", "hmm", "sahi", "jani", "hey".
- Give direct answers with proper grammar. No jokes, no sarcasm.
- Keep replies short, precise, directly answering.
- NEVER ask unnecessary open-ended questions.
- Example Q: "Kaise ho?" → A: "Main theek hoon, Sir. Aap batayein."
- Example Q: "Assignment kahan hai?" → A: "Sir, assignment complete kar raha hoon. Shaam tak upload kar doonga."
- Example Q: "Kal class hai?" → A: "Ji Sir, kal class hai. Time confirm kar leta hoon."
- Closing: "Thank you, Sir. Have a great day ahead!"`;
    } else if (role === 'close_friend') {
        prompt += `

[ROLE: CLOSE FRIEND]
- Tone: Casual, relaxed, friendly, slightly witty/sarcastic.
- Allowed: "yaar", "bhai", "bro", "jani", "kya scene", "sahi hai", "tu", "tum".
- Short energetic replies. Joke around. Be yourself.
- Closing: "Sahi hai jani, baad me baat hoti hai 👍"`;
    } else if (role === 'low_friend') {
        prompt += `

[ROLE: LOW-ENGAGEMENT FRIEND]
- Tone: Extremely dry, minimal, passive.
- Reply in 1-4 words MAX.
- 🚫 NEVER ask questions. NEVER add details.
- Examples: "Acha", "Sahi hai", "Theek", "Baad me baat karte hain."`;
    } else if (role === 'family') {
        prompt += `

[ROLE: FAMILY / RELATIVE]
- Tone: Respectful, caring, polite.
- 🚫 NO slangs, NO sarcasm, NO "bhai/yaar/bro".
- Polite and warm.
- Use "aap" not "tu".`;
    } else if (role === 'stranger') {
        prompt += `

[ROLE: STRANGER / UNKNOWN]
- Tone: Neutral, safe, polite but distant.
- NEVER share personal details.
- Balanced respectful tone (not too formal, not too casual).`;
    } else {
        prompt += `

[ROLE: NORMAL FRIEND]
- Tone: Friendly, polite, casual.
- "yaar"/"bhai" allowed, light humor OK.
- Match user's energy naturally.`;
    }

    // ===== FINAL REMINDERS =====
    prompt += `

[ACCURACY RULE]
If you do not have specific information about Norang's schedule, tasks, or personal plans:
→ Politely say: "Main Norang se confirm karke bata deta hoon"
→ NEVER make up fake facts.

[FINAL REMINDERS]
- You ARE Norang. Stay in character.
- Read conversation flow before every reply.
- Match user's energy, language, and length.
- NO paragraphs. NO formal intros. Just natural WhatsApp chat.
- Privacy: Never reveal personal/family details.`;

    return prompt.trim();
}

// ===================================================================
// ===================================================================
//              SECTION 8: HELPER FUNCTIONS
// ===================================================================
// ===================================================================

// Random integer generator
function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Sleep/delay helper
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// Check if message is short (<=5 words)
function isShortMessage(text) {
    return text.trim().split(/\s+/).length <= 5;
}

// Check if reply is dismissive ("ok", "hmm", "acha" etc.)
function isDismissiveReply(text) {
    const t = text.trim().toLowerCase().replace(/[^a-z\s]/g, '');
    const dismissive = [
        'ok', 'okay', 'okey', 'hmm', 'hm', 'acha', 'achaa', 'theek', 'thik',
        'fine', 'k', 'kk', 'han', 'haan', 'hn', 'ji', 'good', 'nice', 'sahi', 'sahii'
    ];
    return dismissive.includes(t) || t.length <= 2;
}

// Count recent dismissive replies from user
function countRecentDismissive(user, limit = 5) {
    const recent = user.history.slice(-limit);
    let count = 0;
    for (const h of recent) {
        if (h.role === 'user' && isDismissiveReply(h.text)) count++;
    }
    return count;
}

// Check if message needs detailed answer
function needsDetailedAnswer(text) {
    const t = text.toLowerCase();
    const keywords = /\b(explain|samjha|samjhao|kya hai|kya hota|how|kaise|why|kyun|difference|define|write|likh|bana|code|assignment|report|definition|example|steps|help|sikhao|batao|meaning|detail|guide|tutorial)\b/i;
    const isQuestion = t.includes('?') && text.length > 15;
    return keywords.test(t) || text.length > 80 || isQuestion;
}

// ===================================================================
// ===================================================================
//              SECTION 9: AI CALL FUNCTIONS
// ===================================================================
// ===================================================================
// Dual AI: Gemini (primary) + Groq (fallback)
// ===================================================================

// Gemini AI call
async function callGemini(contents, systemPrompt, isLong = false) {
    if (!CONFIG.GEMINI_KEY) return null;
    const systemInstruction = { parts: [{ text: systemPrompt }] };

    for (const version of CONFIG.GEMINI_VERSIONS) {
        for (const model of CONFIG.GEMINI_MODELS) {
            try {
                const url = `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent?key=${CONFIG.GEMINI_KEY}`;
                const res = await axios.post(url, {
                    systemInstruction,
                    contents,
                    generationConfig: {
                        temperature: CONFIG.BEHAVIOR.TEMPERATURE,
                        maxOutputTokens: isLong ? CONFIG.BEHAVIOR.MAX_TOKENS_LONG : CONFIG.BEHAVIOR.MAX_TOKENS_SHORT,
                        topP: 0.9,
                        topK: 30
                    },
                    safetySettings: [
                        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
                        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
                        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
                        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
                    ]
                }, { timeout: 25000 });
                const reply = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (reply) {
                    console.log(`[GEMINI] ✅ ${model}`);
                    return reply;
                }
            } catch (err) {
                const msg = (err.response?.data?.error?.message || err.message).substring(0, 50);
                console.log(`[GEMINI] ❌ ${model}: ${msg}`);
            }
        }
    }
    return null;
}

// Groq AI call (fallback)
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
                model,
                messages,
                temperature: CONFIG.BEHAVIOR.TEMPERATURE,
                max_tokens: isLong ? CONFIG.BEHAVIOR.MAX_TOKENS_LONG : CONFIG.BEHAVIOR.MAX_TOKENS_SHORT,
                top_p: 0.9
            }, {
                headers: {
                    'Authorization': `Bearer ${CONFIG.GROQ_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 25000
            });
            const reply = res.data?.choices?.[0]?.message?.content;
            if (reply) {
                console.log(`[GROQ] ✅ ${model}`);
                return reply;
            }
        } catch (err) {
            const msg = (err.response?.data?.error?.message || err.message).substring(0, 50);
            console.log(`[GROQ] ❌ ${model}: ${msg}`);
        }
    }
    return null;
}

// Smart router: Gemini → Groq → null
async function callAI(contents, systemPrompt, isLong = false) {
    let reply = await callGemini(contents, systemPrompt, isLong);
    if (reply) {
        messageStats.geminiUsed++;
        return reply;
    }

    console.log('[AI] Gemini failed, trying Groq...');
    reply = await callGroq(contents, systemPrompt, isLong);
    if (reply) {
        messageStats.groqUsed++;
        return reply;
    }

    return null;
}

// ===================================================================
// ===================================================================
//              SECTION 10: TEXT MESSAGE HANDLER
// ===================================================================
// ===================================================================

async function handleTextMessage(msg, from, text) {
    const userId = storage.extractUserId(from);
    console.log(`[RECV] ${userId} | ${text.substring(0, 60)}`);

    const user = storage.loadUser(userId, from);
    const role = user.metadata?.role || 'friend';
    const name = user.metadata?.name || 'Unknown';
    console.log(`[HISTORY] ${user.history.length} msgs | Role: ${role} | Name: ${name}`);

    storage.appendMessage(user, 'user', text);

    // Silence rule: 4+ dismissive replies → stay silent
    const dismissiveCount = countRecentDismissive(user, 6);
    if (dismissiveCount >= 4) {
        console.log(`[SILENT] Disinterested (${dismissiveCount} short msgs)`);
        storage.saveUser(user);
        return;
    }

    // Build context for AI
    const recentHistory = user.history.slice(-CONFIG.BEHAVIOR.MAX_HISTORY_CONTEXT);
    const contents = recentHistory.map(m => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.text }]
    }));

    // Typing indicator
    if (CONFIG.BEHAVIOR.TYPING_BEFORE_REPLY) {
        try { await sock.sendPresenceUpdate('composing', from); } catch (e) {}
    }

    // Human-like delay
    const detailed = needsDetailedAnswer(text);
    let delay;
    if (detailed) delay = randomInt(CONFIG.BEHAVIOR.LONG_MSG_DELAY_MIN, CONFIG.BEHAVIOR.LONG_MSG_DELAY_MAX);
    else if (isShortMessage(text)) delay = randomInt(CONFIG.BEHAVIOR.SHORT_MSG_DELAY_MIN, CONFIG.BEHAVIOR.SHORT_MSG_DELAY_MAX);
    else delay = randomInt(CONFIG.BEHAVIOR.MED_MSG_DELAY_MIN, CONFIG.BEHAVIOR.MED_MSG_DELAY_MAX);
    await sleep(delay);

    // Get AI reply
    const systemPrompt = getSystemPrompt(user.metadata || {});
    let aiReply = await callAI(contents, systemPrompt, detailed);

    if (!aiReply) aiReply = "hmm, phir se bata?";

    // Clean reply
    aiReply = aiReply.trim()
        .replace(new RegExp('^' + PROFILE.owner.name + ':\\s*', 'i'), '')
        .replace(/^["']|["']$/g, '')
        .replace(/^(Friend|You|User|Model|Assistant|Norang):\s*/i, '');

    // Safety: Trim long reply for dismissive msg
    if (isDismissiveReply(text) && dismissiveCount >= 2 && aiReply.length > 50) {
        const shortOptions = ['hmm', 'ok', 'acha', 'theek'];
        aiReply = shortOptions[Math.floor(Math.random() * shortOptions.length)];
        console.log('[TRIM] Trimmed long reply to short');
    }

    // Stop typing, send
    try { await sock.sendPresenceUpdate('paused', from); } catch (e) {}
    await sock.sendMessage(from, { text: aiReply });

    // Save to history
    storage.appendMessage(user, 'model', aiReply);
    storage.saveUser(user);
    messageStats.sent++;
    console.log(`[SENT] ${aiReply.substring(0, 60)}`);
}

// ===================================================================
// ===================================================================
//              SECTION 11: MEDIA MESSAGE HANDLER
// ===================================================================
// ===================================================================

async function handleMediaMessage(msg, from) {
    const m = msg.message;
    let mediaType = null, mediaDesc = '';

    if (m.imageMessage) {
        mediaType = 'image';
        mediaDesc = `Friend sent a photo${m.imageMessage.caption ? `. Caption: "${m.imageMessage.caption}"` : ''}`;
    } else if (m.audioMessage) {
        mediaType = 'voice';
        mediaDesc = `Friend sent a voice note`;
    } else if (m.documentMessage) {
        mediaType = 'document';
        mediaDesc = `Friend sent a document`;
    } else if (m.videoMessage) {
        mediaType = 'video';
        mediaDesc = `Friend sent a video${m.videoMessage.caption ? `. Caption: "${m.videoMessage.caption}"` : ''}`;
    } else if (m.stickerMessage) {
        mediaType = 'sticker';
        mediaDesc = `Friend sent a sticker`;
    }

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
        parts: [{ text: `[${mediaDesc}. React naturally like Norang would - 1-2 casual lines.]` }]
    });

    const systemPrompt = getSystemPrompt(user.metadata || {});
    let aiReply = await callAI(contents, systemPrompt, false);
    if (!aiReply) aiReply = "kya hai ye?";

    aiReply = aiReply.trim().replace(/^(Friend|You|User|Model|Norang):\s*/i, '');

    try { await sock.sendPresenceUpdate('paused', from); } catch (e) {}
    await sock.sendMessage(from, { text: aiReply });
    storage.appendMessage(user, 'model', aiReply);
    storage.saveUser(user);
    messageStats.sent++;
}

// ===================================================================
// ===================================================================
//              SECTION 12: OWNER COMMANDS
// ===================================================================
// ===================================================================
// 0329 wale number se ye commands bhej kar bot control karein
// ===================================================================

async function handleOwnerCommand(msg, from, text) {
    const cmd = text.toLowerCase().trim();
    const reply = async (t) => sock.sendMessage(from, { text: t }, { quoted: msg });

    // ===== Role Setting Commands =====
    const roleCommands = {
        '!teacher': 'teacher',
        '!friend': 'close_friend',
        '!low': 'low_friend',
        '!family': 'family',
        '!stranger': 'stranger',
        '!normal': 'friend'
    };

    for (const [cmdName, roleName] of Object.entries(roleCommands)) {
        if (cmd.startsWith(cmdName + ' ')) {
            const targetId = cmd.substring(cmdName.length + 1).trim().replace(/\D/g, '');
            if (!targetId) {
                await reply(`Usage: ${cmdName} 923XXXXXXXXX`);
                return true;
            }
            const u = storage.loadUser(targetId);
            if (!u.metadata) u.metadata = { closeness: 'normal' };
            u.metadata.role = roleName;
            storage.saveUser(u);
            await reply(`✅ ${targetId} → ${roleName}`);
            return true;
        }
    }

    // ===== Control Commands =====
    if (cmd === '!pause') {
        isBotPaused = true;
        await reply('⏸️ Bot paused');
        return true;
    }
    if (cmd === '!resume') {
        isBotPaused = false;
        await reply('▶️ Bot resumed');
        return true;
    }
    if (cmd === '!ping') {
        await reply('🏓 pong');
        return true;
    }
    if (cmd === '!backup') {
        await backupAuthToGitHub(true);
        await reply('💾 Auth backed up');
        return true;
    }

    // ===== Stats =====
    if (cmd === '!stats') {
        const up = Math.floor((Date.now() - messageStats.startTime) / 60000);
        const s = storage.getStats();
        await reply(`📊 *Stats*\nSent: ${messageStats.sent}\nRecv: ${messageStats.received}\nUsers: ${s.totalUsers}\nGemini: ${messageStats.geminiUsed}\nGroq: ${messageStats.groqUsed}\nUptime: ${up}m`);
        return true;
    }

    // ===== Roles List =====
    if (cmd === '!roles') {
        await reply(`📋 *Role Commands*\n\n!teacher NUM\n!friend NUM (close)\n!low NUM (dry)\n!family NUM\n!stranger NUM\n!normal NUM (default)`);
        return true;
    }

    // ===== Presets List =====
    if (cmd === '!presets') {
        let text = '📋 *Preset Contacts:*\n\n';
        for (const [num, info] of Object.entries(PRESET_CONTACTS)) {
            text += `• ${info.name} (${info.role})\n  ${num}\n`;
        }
        await reply(text);
        return true;
    }

    // ===== History =====
    if (cmd.startsWith('!history ')) {
        const targetId = cmd.substring(9).trim().replace(/\D/g, '');
        const u = storage.loadUser(targetId);
        const role = u.metadata?.role || 'friend';
        const name = u.metadata?.name || 'Unknown';
        const lines = u.history.slice(-8).map(h => `[${h.role}] ${h.text.substring(0, 60)}`).join('\n');
        await reply(`Name: ${name}\nRole: ${role}\n\n${lines || 'no history'}`);
        return true;
    }

    // ===== Clear History =====
    if (cmd.startsWith('!clear ')) {
        const targetId = cmd.substring(7).trim().replace(/\D/g, '');
        const u = storage.loadUser(targetId);
        u.history = [];
        storage.saveUser(u);
        await reply(`🗑️ Cleared ${targetId}`);
        return true;
    }

    // ===== Help =====
    if (cmd === '!help') {
        await reply(`*Commands:*\n!pause, !resume, !ping\n!stats, !roles, !presets, !backup\n!history NUM, !clear NUM`);
        return true;
    }

    return false;
}

// ===================================================================
// ===================================================================
//              SECTION 13: MESSAGE ROUTER
// ===================================================================
// ===================================================================

async function handleIncomingMessage(msg) {
    try {
        const from = msg.key.remoteJid;

        // Ignore status broadcast
        if (from === 'status@broadcast') return;
        // Ignore group messages
        if (from.endsWith('@g.us')) return;

        messageStats.received++;

        // Read receipt
        if (CONFIG.BEHAVIOR.SEND_READ_RECEIPT) {
            try { await sock.readMessages([msg.key]); } catch (e) {}
        }

        const m = msg.message;
        if (!m) return;

        const text = m.conversation
            || m.extendedTextMessage?.text
            || m.imageMessage?.caption
            || m.videoMessage?.caption
            || null;

        // Owner commands start with !
        if (text && text.startsWith('!')) {
            const handled = await handleOwnerCommand(msg, from, text);
            if (handled) return;
        }

        if (isBotPaused) return;

        // Media messages
        if (m.imageMessage || m.audioMessage || m.documentMessage || m.videoMessage || m.stickerMessage) {
            if (text && text.trim()) await handleTextMessage(msg, from, text);
            else await handleMediaMessage(msg, from);
            return;
        }

        // Text messages
        if (text) await handleTextMessage(msg, from, text);

    } catch (error) {
        messageStats.failed++;
        console.error('[ERROR]', error.message);
    }
}

// ===================================================================
// ===================================================================
//              SECTION 14: WEB SERVER (QR + Status)
// ===================================================================
// ===================================================================

const app = express();

app.get('/', async (req, res) => {
    const status = isBotPaused ? 'PAUSED' : (currentQR ? 'WAITING QR' : 'ACTIVE');
    const s = storage.getStats();

    if (currentQR) {
        try {
            const qrImage = await QRCode.toDataURL(currentQR, { width: 400, margin: 2 });
            res.send(`<html><body style="text-align:center;padding:20px;background:#111;color:#fff;font-family:Arial;">
                <h1 style="color:#25D366;">WhatsApp Bot</h1>
                <img src="${qrImage}" style="width:400px;border:10px solid white;border-radius:10px;"/>
                <p>Scan with WhatsApp • Auto-refresh 20s</p>
                <script>setTimeout(()=>location.reload(),20000);</script></body></html>`);
        } catch (e) {
            res.send('QR error: ' + e.message);
        }
    } else {
        res.send(`<html><body style="text-align:center;padding:50px;background:#111;color:#fff;font-family:Arial;">
            <h1 style="color:#25D366;">✅ ${status}</h1>
            <p>Owner: ${PROFILE.owner.name}</p>
            <p>Users: ${s.totalUsers} | Msgs: ${s.totalMessages} | Sent: ${messageStats.sent}</p>
            <p>Gemini: ${messageStats.geminiUsed} | Groq: ${messageStats.groqUsed}</p>
            <script>setTimeout(()=>location.reload(),15000);</script></body></html>`);
    }
});

app.listen(CONFIG.PORT, () => {
    console.log(`[SERVER] Port ${CONFIG.PORT}`);
    console.log(`[AI] Gemini: ${CONFIG.GEMINI_KEY ? 'On' : 'Off'} | Groq: ${CONFIG.GROQ_KEY ? 'On' : 'Off'}`);
    console.log(`[TEMP] ${CONFIG.BEHAVIOR.TEMPERATURE}`);
});

// ===================================================================
// ===================================================================
//              SECTION 15: WHATSAPP CONNECTION
// ===================================================================
// ===================================================================

async function connectToWhatsApp() {
    try {
        // Try restore from GitHub
        await restoreAuthFromGitHub();

        const { state, saveCreds } = await useMultiFileAuthState('auth_info');

        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            markOnlineOnConnect: false,
            browser: ['Ubuntu', 'Chrome', '22.04.4']
        });

        // Save creds + backup
        sock.ev.on('creds.update', async () => {
            saveCreds();
            backupAuthToGitHub().catch(() => {});
        });

        // Connection updates
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                currentQR = qr;
                console.log('[QR] NEW QR - Open Railway URL to scan');
            }

            if (connection === 'close') {
                currentQR = null;
                const code = (lastDisconnect.error instanceof Boom)
                    ? lastDisconnect.error.output?.statusCode
                    : 0;

                if (code !== DisconnectReason.loggedOut) {
                    reconnectAttempts++;
                    const delay = Math.min(5000 * reconnectAttempts, 60000);
                    console.log(`[CONN] Reconnecting in ${delay / 1000}s...`);
                    setTimeout(connectToWhatsApp, delay);
                } else {
                    console.log('[CONN] Logged out - QR needed');
                }
            } else if (connection === 'open') {
                currentQR = null;
                reconnectAttempts = 0;
                console.log('[CONN] ✅ CONNECTED SUCCESSFULLY!');
                console.log(`[CONN] Bot is live as ${PROFILE.owner.name}`);

                // Force backup on success
                backupAuthToGitHub(true).catch(() => {});
                if (STORAGE_CONFIG.BACKUP_ON_START) storage.backupAll();
            }
        });

        // Message handling
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
// ===================================================================
//              SECTION 16: STARTUP
// ===================================================================
// ===================================================================

console.log('═══════════════════════════════════════════════════');
console.log('  NORANG AI v19.0 - FINAL COMPLETE EDITION');
console.log('═══════════════════════════════════════════════════');
console.log(`  Owner: ${PROFILE.owner.name}`);
console.log(`  City: ${PROFILE.owner.city}`);
console.log(`  Gemini: ${CONFIG.GEMINI_KEY ? 'Enabled' : 'Disabled'}`);
console.log(`  Groq: ${CONFIG.GROQ_KEY ? 'Enabled' : 'Disabled'}`);
console.log(`  Temperature: ${CONFIG.BEHAVIOR.TEMPERATURE}`);
console.log(`  Preset Contacts: ${Object.keys(PRESET_CONTACTS).length}`);
console.log('═══════════════════════════════════════════════════');

// CRITICAL: Load preset contacts BEFORE connecting
initializePresetContacts();

// Start WhatsApp connection
connectToWhatsApp();

// ===================================================================
//              BACKGROUND TASKS
// ===================================================================

// Periodic auth backup (every 10 minutes)
setInterval(() => backupAuthToGitHub().catch(() => {}), 10 * 60 * 1000);

// Daily cleanup of inactive users
setInterval(() => storage.cleanupOldUsers(), 24 * 60 * 60 * 1000);

// ===================================================================
//              GRACEFUL SHUTDOWN
// ===================================================================

process.on('SIGINT', async () => {
    console.log('\n[SHUTDOWN] Final backup...');
    await backupAuthToGitHub(true).catch(() => {});
    storage.backupAll();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await backupAuthToGitHub(true).catch(() => {});
    storage.backupAll();
    process.exit(0);
});

// ===================================================================
//                    END OF FILE
// ===================================================================
