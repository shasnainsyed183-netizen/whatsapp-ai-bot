const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const WA_TOKEN = process.env.WA_TOKEN; // WhatsApp Access Token
const PHONE_ID = process.env.PHONE_ID; // Phone Number ID
const GEMINI_KEY = process.env.GEMINI_KEY; // Gemini API Key
const VERIFY_TOKEN = "my_verify_token_123"; // Ye aapki marzi ka password hai

// Webhook Verification
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('WEBHOOK_VERIFIED');
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// Webhook Message Handling
app.post('/webhook', async (req, res) => {
    res.sendStatus(200); // Foran acknowledge karein

    try {
        const entry = req.body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        const message = value?.messages?.[0];

        if (!message) return;

        const from = message.from;
        const text = message.text?.body;

        if (!text) return;

        console.log(`Message from ${from}: ${text}`);

        // Gemini AI ko call karein (2 models try karega, jo pehle kaam kare)
        const models = ['gemini-2.0-flash', 'gemini-1.5-flash'];
        let aiReply = null;

        for (const model of models) {
            try {
                const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
                const geminiResponse = await axios.post(geminiUrl, {
                    contents: [{
                        parts: [{ text: `You are a helpful WhatsApp assistant. Answer in the same language as the user. Keep it short, friendly and to the point. User says: ${text}` }]
                    }]
                });
                aiReply = geminiResponse.data.candidates[0].content.parts[0].text;
                console.log(`AI replied using model: ${model}`);
                break; // Agar jawab mil gaya to loop se bahar
            } catch (err) {
                console.log(`Model ${model} failed, trying next...`);
            }
        }

        if (!aiReply) {
            aiReply = "Sorry, main abhi jawab nahi de pa raha. Thodi der baad try karein.";
        }

        // WhatsApp par jawab bhejein
        const waUrl = `https://graph.facebook.com/v20.0/${PHONE_ID}/messages`;
        await axios.post(waUrl, {
            messaging_product: 'whatsapp',
            to: from,
            type: 'text',
            text: { body: aiReply }
        }, {
            headers: {
                Authorization: `Bearer ${WA_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        console.log(`Replied to ${from}: ${aiReply}`);

    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
