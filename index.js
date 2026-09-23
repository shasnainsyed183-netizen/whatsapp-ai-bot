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
