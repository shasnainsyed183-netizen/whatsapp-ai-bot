// ===================================================================
//  STORAGE.JS - Per-User Conversation History Manager
//  Har user ki chat history alag file mein save hoti hai
// ===================================================================

const fs = require('fs');
const path = require('path');

// Data folder paths
const DATA_DIR = path.join(__dirname, 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const BACKUP_DIR = path.join(DATA_DIR, 'backup');

// Config
const CONFIG = {
    MAX_HISTORY_PER_USER: 30,      // Har user ke liye max 30 messages (user + AI)
    CLEANUP_DAYS: 90,              // 90 din se purane inactive users delete
    BACKUP_ON_START: true          // Bot start hone par backup
};

// ===================================================================
//                    FOLDER INITIALIZATION
// ===================================================================
function ensureFolders() {
    [DATA_DIR, USERS_DIR, BACKUP_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`[STORAGE] Created folder: ${dir}`);
        }
    });
}

ensureFolders();

// ===================================================================
//                    FILE PATH HELPERS
// ===================================================================
function getUserFilePath(userId) {
    // userId = clean number (e.g., "923153643080")
    return path.join(USERS_DIR, `${userId}.json`);
}

function extractUserId(jid) {
    // "923153643080@s.whatsapp.net" -> "923153643080"
    // "923153643080:12@s.whatsapp.net" -> "923153643080"
    return jid.split('@')[0].split(':')[0].replace(/\D/g, '');
}

// ===================================================================
//                    USER PROFILE TEMPLATE
// ===================================================================
function createEmptyUser(userId, jid) {
    return {
        userId: userId,
        jid: jid,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        messageCount: 0,
        history: [],          // [{ role: "user"/"model", text: "...", timestamp }]
        metadata: {
            name: null,
            note: null,
            closeness: 'normal',  // normal / close
            language: null
        }
    };
}

// ===================================================================
//                    LOAD USER HISTORY
// ===================================================================
function loadUser(userId, jid = null) {
    const filePath = getUserFilePath(userId);

    try {
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            // Ensure backward compatibility
            if (!data.history) data.history = [];
            if (!data.metadata) data.metadata = { closeness: 'normal' };
            return data;
        }
    } catch (err) {
        console.error(`[STORAGE] Error loading user ${userId}:`, err.message);
        // Backup corrupted file
        try {
            const backupPath = path.join(BACKUP_DIR, `${userId}_corrupted_${Date.now()}.json`);
            fs.copyFileSync(filePath, backupPath);
            console.log(`[STORAGE] Corrupted file backed up: ${backupPath}`);
        } catch (e) {}
    }

    // Return fresh user
    return createEmptyUser(userId, jid);
}

// ===================================================================
//                    SAVE USER HISTORY
// ===================================================================
// Concurrency safe: multiple writes ke liye queue
const writeQueue = {};
let isWriting = {};

function saveUser(user) {
    const userId = user.userId;
    const filePath = getUserFilePath(userId);

    // Update lastSeen
    user.lastSeen = new Date().toISOString();

    // Agar pehle se write chal raha hai, to queue karo
    if (isWriting[userId]) {
        writeQueue[userId] = user;
        return;
    }

    isWriting[userId] = true;

    try {
        // Atomic write: pehle .tmp file mein likho, phir rename karo
        const tmpPath = filePath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(user, null, 2));
        fs.renameSync(tmpPath, filePath);
    } catch (err) {
        console.error(`[STORAGE] Error saving user ${userId}:`, err.message);
    }

    isWriting[userId] = false;

    // Agar queue mein pending hai, to process karo
    if (writeQueue[userId]) {
        const queued = writeQueue[userId];
        delete writeQueue[userId];
        saveUser(queued);
    }
}

// ===================================================================
//                    APPEND MESSAGE TO HISTORY
// ===================================================================
function appendMessage(user, role, text) {
    // role: "user" (from friend) ya "model" (AI reply)
    user.history.push({
        role: role,
        text: text,
        timestamp: Date.now()
    });

    // Trim old messages if exceeds limit
    if (user.history.length > CONFIG.MAX_HISTORY_PER_USER) {
        user.history = user.history.slice(-CONFIG.MAX_HISTORY_PER_USER);
    }

    user.messageCount = (user.messageCount || 0) + 1;
}

// ===================================================================
//                    BUILD GEMINI CONTENTS ARRAY
// ===================================================================
// Ye function user ki history ko Gemini API ke "contents" format mein convert karta hai
function buildGeminiContents(user) {
    const contents = [];

    for (const msg of user.history) {
        // Gemini uses "user" and "model" roles
        const role = msg.role === 'user' ? 'user' : 'model';
        contents.push({
            role: role,
            parts: [{ text: msg.text }]
        });
    }

    return contents;
}

// ===================================================================
//                    GET ALL USERS STATS
// ===================================================================
function getStats() {
    try {
        const files = fs.readdirSync(USERS_DIR).filter(f => f.endsWith('.json'));
        let totalMessages = 0;
        let activeUsers = 0;
        const now = Date.now();

        for (const file of files) {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(USERS_DIR, file), 'utf8'));
                totalMessages += data.messageCount || 0;
                const lastSeen = new Date(data.lastSeen).getTime();
                if (now - lastSeen < 7 * 24 * 60 * 60 * 1000) activeUsers++;
            } catch (e) {}
        }

        return {
            totalUsers: files.length,
            activeUsers: activeUsers,
            totalMessages: totalMessages
        };
    } catch (err) {
        return { totalUsers: 0, activeUsers: 0, totalMessages: 0 };
    }
}

// ===================================================================
//                    CLEANUP OLD USERS
// ===================================================================
function cleanupOldUsers() {
    try {
        const files = fs.readdirSync(USERS_DIR).filter(f => f.endsWith('.json'));
        const now = Date.now();
        const cutoff = CONFIG.CLEANUP_DAYS * 24 * 60 * 60 * 1000;
        let cleaned = 0;

        for (const file of files) {
            try {
                const filePath = path.join(USERS_DIR, file);
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                const lastSeen = new Date(data.lastSeen).getTime();

                // Agar 90 din se inactive aur 5 se kam messages
                if ((now - lastSeen) > cutoff && (data.messageCount || 0) < 5) {
                    // Backup before delete
                    const backupPath = path.join(BACKUP_DIR, file);
                    fs.copyFileSync(filePath, backupPath);
                    fs.unlinkSync(filePath);
                    cleaned++;
                }
            } catch (e) {}
        }

        if (cleaned > 0) {
            console.log(`[STORAGE] Cleaned up ${cleaned} inactive users`);
        }
        return cleaned;
    } catch (err) {
        console.error('[STORAGE] Cleanup error:', err.message);
        return 0;
    }
}

// ===================================================================
//                    BACKUP ALL DATA
// ===================================================================
function backupAll() {
    try {
        const files = fs.readdirSync(USERS_DIR).filter(f => f.endsWith('.json'));
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFolder = path.join(BACKUP_DIR, `snapshot_${timestamp}`);
        fs.mkdirSync(backupFolder, { recursive: true });

        for (const file of files) {
            fs.copyFileSync(
                path.join(USERS_DIR, file),
                path.join(backupFolder, file)
            );
        }
        console.log(`[STORAGE] Backup created: ${backupFolder} (${files.length} users)`);
    } catch (err) {
        console.error('[STORAGE] Backup error:', err.message);
    }
}

// ===================================================================
//                    EXPORTS
// ===================================================================
module.exports = {
    loadUser,
    saveUser,
    appendMessage,
    buildGeminiContents,
    extractUserId,
    getStats,
    cleanupOldUsers,
    backupAll,
    CONFIG
};
