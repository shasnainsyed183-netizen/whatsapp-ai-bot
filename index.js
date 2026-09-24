const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const axios = require('axios');
const express = require('express');
const qrcode = require('qrcode-terminal');

const GEMINI_KEY = process.env.GEMINI_KEY;
let sock;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n========================================');
            console.log('SCAN THIS QR CODE WITH YOUR WHATSAPP:');
            console.log('========================================\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('WHATSAPP CONNECTED SUCCESSFULLY!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message) return;
            if (msg.key.fromMe) return;

            const from = msg.key.remoteJid;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

            if (!text) return;
            console.log(`Message from ${from}: ${text}`);

            const models = ['gemini-2.0-flash', 'gemini-1.5-flash'];
            let aiReply = null;

            for (const model of models) {
                try {
                    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
                    const geminiResponse = await axios.post(geminiUrl, {
                        contents: [{
                            parts: [{ text: `You are a helpful WhatsApp assistant. Answer in the same language as the user. Keep it short and friendly. User says: ${text}` }]
                        }]
                    });
                    aiReply = geminiResponse.data.candidates[0].content.parts[0].text;
                    console.log(`AI replied using model: ${model}`);
                    break;
                } catch (err) {
                    console.log(`Model ${model} failed:`, err.response?.data?.error?.message || err.message);
                }
            }

            if (!aiReply) {
                aiReply = "Sorry, main abhi jawab nahi de pa raha. Thodi der baad try karein.";
            }

            await sock.sendMessage(from, { text: aiReply });
            console.log(`Replied to ${from}: ${aiReply}`);
        } catch (error) {
            console.error('Error:', error.message);
        }
    });
}

connectToWhatsApp();

const app = express();
app.get('/', (req, res) => res.send('WhatsApp Bot is running!'));
app.listen(process.env.PORT || 3000, () => {
    console.log(`Server is running on port ${process.env.PORT || 3000}`);
});
