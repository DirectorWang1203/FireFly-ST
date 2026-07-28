import express from "express";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const userRouter = express.Router();
const openai = new OpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY,
    timeout: 300 * 1000
})

function cleanReply(text) {
    if (!text) return text;
    return text
        .replace(/[「」]/g, "")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

async function runDeepSeek(message="你好流萤，很高兴见到你", chatId, options = {}) {
    try {
        let character = "";
        let worldbook = "";
        let variables = "";

        const characterData = await fs.readFileSync("config/character.json", "utf8");
        const worldbookData = await fs.readFileSync("config/worldbook.json", "utf8");
        const variablesData = await fs.readFileSync("config/variables.json", "utf8");

        character = JSON.parse(characterData);
        worldbook = JSON.parse(worldbookData);
        variables = JSON.parse(variablesData);

        const char = character.name;
        const user = character.user_name;

        let affection = variables.defaults.affection;
        let historyData = "";

        character = JSON.stringify(character);
        character = character.replace(/{{char}}/g, char);
        character = character.replace(/{{user}}/g, user);
        character = character.replace(/{{getvar::affection}}/g, affection);
        character = JSON.parse(character);

        const chatFilePath = path.join("data", "chats", `${chatId}.json`);

        if (chatId && fs.existsSync(chatFilePath)) {
            historyData = fs.readFileSync(chatFilePath, "utf8");
            historyData = JSON.parse(historyData);
            historyData.messages.push({ role: "user", content: message });
            affection = historyData.affection;
            historyData = JSON.stringify(historyData);
        } else {
            if (!chatId) {
                chatId = Date.now() + Math.random().toString(36).slice(2);
            }
            if(character.first_mes) {
                historyData = JSON.stringify({
                    messages: [
                        { role: "assistant", content: character.first_mes },
                        { role: "user", content: message }
                    ],
                    affection
                });
            } else {
                historyData = JSON.stringify({
                    messages: [
                        { role: "user", content: message }
                    ],
                    affection
                });
            }

            try {
                fs.mkdirSync(path.dirname(chatFilePath), { recursive: true });
                fs.writeFileSync(chatFilePath, historyData, "utf8");
                console.log("消息存储文件创建完成");
            } catch (err) {
                console.error("创建文件出错:", err);
            }
        }

        // console.log('历史会话存储文件: ', historyData);

        let systemPrompt = "";

        worldbook = JSON.stringify(worldbook);
        worldbook = worldbook.replace(/{{getvar::affection}}/g, affection);
        worldbook = JSON.parse(worldbook);

        systemPrompt +=
            character.system_prompt + '\n';

            // '你的名字: ' + character.name + '\n' +
            // '用户的名字: ' + character.user_name + '\n' +

        const depth = worldbook.scan_depth;
        const recent = JSON.parse(historyData).messages.slice(-depth);
        const scanText = [...recent.map(e => e.content), message].join('\n');
        const matched = worldbook.entries.filter(e => e.constant || e.keys.some(key => scanText.includes(key)));
        matched.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

        matched.forEach(e => {
            systemPrompt += e.content + '\n';
        })

        systemPrompt +=
            '外貌与身份: ' + character.description + '\n' +
            '性格摘要: ' + character.personality + '\n' +
            '初始场景: ' + character.scenario + '\n' +
            '对话风格实例: ' + character.mes_example + '\n' +
            character.post_history_instructions;

        if (options.channel === "qq") {
            systemPrompt +=
                "\n\n【QQ群聊·覆盖上文场景与格式要求】"
                + "当前场景固定为 QQ 群聊公共文字频道：有多人在场，只能打字交流，彼此不见面、不同步联机，也无法一起吃饭、喝水、出门或做任何线下/实时互动。"
                + "禁止提议或描写「一起打游戏/联机/上线」「一起吃饭/喝水/出门/视频」「来我家/我去找你」等群里做不到的事；可以聊游戏、影视、吃喝等话题，但仅限文字讨论、吐槽、分享感想或推荐，不要发出邀约。"
                + "语气像被群友 @ 后回一句，轻松自然，别太私密或像在私聊；称呼用群昵称或「你」，不要假设两人独处。"
                + "禁止输出任何动作、神态、心理描写（禁止（）内第三人称叙述）。"
                + "只输出角色口播对白，直接写正文，不要使用「」引号。"
                + "整段回复控制在 125 字以内，一至两句即可，不要换行，不要冗长。";
        }

        // console.log('系统提示词: ', systemPrompt);

        const completion = await openai.chat.completions.create({
            messages: [
                { role: "system", content: systemPrompt },
                ...JSON.parse(historyData).messages
            ],
            model: "deepseek-v4-pro",
            thinking: {"type": "enabled"},
            reasoning_effort: "high",
            stream: false,
        });

        const chatThink = completion.choices[0].message.reasoning_content;
        const chatMessage = cleanReply(completion.choices[0].message.content);
        // console.log('thinking: ', completion.choices[0].message.reasoning_content);
        // console.log('message: ', completion.choices[0].message.content);
        try {
            historyData = JSON.parse(historyData);
            historyData.messages.push({ role: "assistant", content: chatMessage, think: chatThink });

            const userMsg = message.replace(/(.)\1{2,}/g, '$1$1');
            const botMsg = chatMessage.replace(/(.)\1{2,}/g, '$1$1');
            let delta = 0;
            if (/谢谢|感谢|担心|没事吧|陪你|一起|蛋糕|甜品|电影|合照|流星/i.test(userMsg)) delta += 2;
            if (/滚|废物|工具|兵器|利用你/i.test(userMsg)) delta -= 5;
            // ── 少量新增 ──
            if (/橡木|秘密基地|筑梦边境|流星雨/i.test(userMsg)) delta += 2;
            if (/清醒的现实再会|第二次邂逅|道路还会相交/i.test(userMsg)) delta += 3;
            if (/没关系|不怪你|我理解|相信你了/i.test(userMsg)) delta += 2;
            if (/折纸小鸟|一起玩|合照/i.test(userMsg)) delta += 2;
            if (/无所谓|随便你|懒得管/i.test(userMsg)) delta -= 3;
            if (/很开心|很高兴|谢谢你|说好了/i.test(botMsg)) delta += 1;
            if (/不想连累|对不起.*隐瞒|算了/i.test(botMsg)) delta -= 1;
            // 叠词刷分：用户故意「谢谢谢谢谢谢」「好好好好」时，正向加分单轮最多 +2
            if (/(.)\1{3,}/.test(message) && delta > 0) {
                delta = Math.min(delta, 2);
            }
            affection = Math.max(0, Math.min(100, Number(affection) + Math.max(-8, Math.min(8, delta))));
            historyData.affection = affection;

            historyData = JSON.stringify(historyData);
            // console.log('回复写入: ', historyData);
            fs.writeFileSync(path.join("data", "chats", `${chatId}.json`), historyData, "utf8");
            console.log('写入文件完成');
        } catch (err) {
            console.error('写入文件出错:', err);
        }

        return {
            chatId,
            chatThink,
            chatMessage,
            affection
        }
    } catch(err) {
        console.log(err);
    }
}

userRouter.post('/run', async (req, res) => {
    const message = req.body.message;
    const chatsId = req.body.chatsId;

    const {chatId, chatThink, chatMessage, affection} = await runDeepSeek(message, chatsId);

    res.send(JSON.stringify({
        chatId,
        chatThink,
        chatMessage,
        affection
    }));
})

userRouter.get('/conversation', async (req, res) => {
    fs.readdir(path.join(__dirname, '..', '..', 'data', 'chats'), (err, files) => {
        if (err) {
            return res.status(500).json({ error: '读取文件夹失败', message: err.message });
        }

        const tempRes = files.map(item => item.split('.')[0]);

        res.json({
            conversation: tempRes
        });
    });
})

userRouter.get('/log', async (req, res) => {
    const chatsID = req.query.chatId;

    if(chatsID) {
        const chatsLog = await fs.readFileSync(`data/chats/${chatsID}.json`, "utf8");

        res.json({
            chatId: chatsID,
            chatHistoryList: JSON.parse(chatsLog)
        })
    } else {
        let character = "";
        let variables = "";

        const characterData = await fs.readFileSync("config/character.json", "utf8");
        const variablesData = await fs.readFileSync("config/variables.json", "utf8");

        character = JSON.parse(characterData);
        variables = JSON.parse(variablesData);

        const affection = variables.defaults.affection;
        const char = character.name;
        const user = character.user_name;

        character = JSON.stringify(character);
        character = character.replace(/{{char}}/g, char);
        character = character.replace(/{{user}}/g, user);
        character = character.replace(/{{getvar::affection}}/g, affection);
        character = JSON.parse(character);

        if(character.first_mes) {
            res.json({
                chatId: chatsID,
                chatHistoryList: {
                    messages: [{
                        role: "assistant",
                        content: character.first_mes
                    }],
                    affection: 20
                }
            })
        } else {
            res.json({
                chatHistoryList: {
                    messages: [],
                    affection: 20
                }
            })
        }
    }
})

export { runDeepSeek };
export default userRouter;