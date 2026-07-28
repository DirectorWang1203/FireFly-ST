import express from "express";
import fs from "fs";
import { runDeepSeek } from "./chats.js";

const router = express.Router();

const ONEBOT_HTTP_URL = (process.env.ONEBOT_HTTP_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const ONEBOT_TOKEN = (process.env.ONEBOT_TOKEN || "").trim();
const BOT_QQ = (process.env.BOT_QQ || "").trim();
const ALLOWED_GROUPS = (process.env.QQ_ALLOWED_GROUPS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const pendingChats = new Map();

function isAtBot(message, botQq) {
    if (!botQq) return false;
    if (typeof message === "string") {
        return message.includes(`@${botQq}`);
    }
    if (!Array.isArray(message)) return false;
    return message.some(
        (seg) => seg.type === "at" && String(seg.data?.qq) === String(botQq)
    );
}

function extractTextWithoutAt(message) {
    if (typeof message === "string") {
        return message.replace(/@\d+/g, "").trim();
    }
    if (!Array.isArray(message)) return "";
    return message
        .filter((seg) => seg.type === "text")
        .map((seg) => seg.data?.text ?? "")
        .join("")
        .trim();
}

function getChatId(event) {
    return `qq_g${event.group_id}_u${event.user_id}`;
}

function oneBotHeaders() {
    const headers = { "Content-Type": "application/json" };
    if (ONEBOT_TOKEN) {
        headers.Authorization = `Bearer ${ONEBOT_TOKEN}`;
    }
    return headers;
}

async function oneBotCall(action, params) {
    const url = ONEBOT_TOKEN
        ? `${ONEBOT_HTTP_URL}/${action}?access_token=${encodeURIComponent(ONEBOT_TOKEN)}`
        : `${ONEBOT_HTTP_URL}/${action}`;

    const res = await fetch(url, {
        method: "POST",
        headers: oneBotHeaders(),
        body: JSON.stringify(params),
    });
    const text = await res.text();
    const trimmed = text.trim();

    if (!res.ok) {
        if (res.status === 403 && text.includes("token verify failed")) {
            throw new Error(
                "OneBot Token 校验未通过。请确认 .env 的 ONEBOT_TOKEN 是 NapCat「HTTP 服务端」的 Token，不是 WebUI Token。"
            );
        }
        throw new Error(`OneBot ${action} 失败: ${res.status} ${text.slice(0, 200)}`);
    }

    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        throw new Error(
            `OneBot ${action} 返回了 HTML 而非 JSON。当前 ONEBOT_HTTP_URL=${ONEBOT_HTTP_URL}，` +
            "说明该端口不是 NapCat HTTP 服务端（可能被其他程序占用）。请重启 NapCat 并核对端口配置。" +
            ` 响应开头: ${trimmed.slice(0, 80)}`
        );
    }

    return JSON.parse(text);
}

const QQ_MAX_CHARS = 125;
const QQ_MAX_CHARS_LUoxi = 180;

let charMetaCache = null;
function getCharMeta() {
    if (charMetaCache) return charMetaCache;
    try {
        charMetaCache = JSON.parse(fs.readFileSync("config/character.json", "utf8"));
    } catch {
        charMetaCache = { name: "", user_name: "群友" };
    }
    return charMetaCache;
}

function getQQMaxChars() {
    return getCharMeta().name === "洛茜" ? QQ_MAX_CHARS_LUoxi : QQ_MAX_CHARS;
}

function stripActions(text) {
    return text
        .replace(/（[^）]*）/g, "")
        .replace(/\([^)]*\)/g, "")
        .replace(/[「」]/g, "")
        .replace(/\n+/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
}

function truncateForQQ(text, max = QQ_MAX_CHARS) {
    const chars = [...text];
    if (chars.length <= max) return text;

    let cut = chars.slice(0, max).join("");
    const punct = Math.max(
        cut.lastIndexOf("。"),
        cut.lastIndexOf("！"),
        cut.lastIndexOf("？"),
        cut.lastIndexOf("\n")
    );
    if (punct > max * 0.4) {
        cut = cut.slice(0, punct + 1);
    }
    return cut;
}

function formatQQReply(text) {
    return truncateForQQ(stripActions(text), getQQMaxChars());
}

function splitMessage(text, maxLen = 1500) {
    const chunks = [];
    let remaining = text;
    while (remaining.length > maxLen) {
        let cut = remaining.lastIndexOf("\n", maxLen);
        if (cut <= 0) cut = maxLen;
        chunks.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut).trimStart();
    }
    if (remaining) chunks.push(remaining);
    return chunks.length ? chunks : [""];
}

async function sendGroupReply(groupId, text, replyToMessageId) {
    const chunks = splitMessage(text);
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        let message = chunk;
        if (i === 0 && replyToMessageId) {
            message = [
                { type: "reply", data: { id: String(replyToMessageId) } },
                { type: "text", data: { text: chunk } },
            ];
        }
        await oneBotCall("send_group_msg", { group_id: Number(groupId), message });
    }
}

async function handleGroupMessage(event) {
    if (!BOT_QQ) {
        console.warn("[QQ] 请在 .env 中设置 BOT_QQ（机器人 QQ 号）");
        return;
    }

    if (!isAtBot(event.message, BOT_QQ)) return;

    if (ALLOWED_GROUPS.length && !ALLOWED_GROUPS.includes(String(event.group_id))) {
        return;
    }

    const text = extractTextWithoutAt(event.message);
    if (!text) return;

    const chatId = getChatId(event);
    const userName = event.sender?.card || event.sender?.nickname || "群友";
    const meta = getCharMeta();
    const isLuoxi = meta.name === "洛茜";
    const userLabel = isLuoxi ? (meta.user_name || "管理员") : "群友";
    const message = `【QQ群聊·${userLabel} @ 你】${userName}：${text}`;
    const { group_id: groupId, message_id: messageId } = event;

    const prev = pendingChats.get(chatId);
    const work = (async () => {
        if (prev) await prev.catch(() => {});

        const result = await runDeepSeek(message, chatId, {
            channel: "qq",
            intimateQQ: isLuoxi,
        });
        if (!result?.chatMessage) {
            await sendGroupReply(groupId, "（抱歉，能 @ 我再说一次吗？）", messageId);
            return;
        }

        await sendGroupReply(groupId, formatQQReply(result.chatMessage), messageId);
    })();

    pendingChats.set(chatId, work);
    await work.finally(() => {
        if (pendingChats.get(chatId) === work) pendingChats.delete(chatId);
    });
}

router.get("/test-onebot", async (req, res) => {
    try {
        const r = await fetch(`${ONEBOT_HTTP_URL}/get_login_info`, {
            method: "POST",
            headers: oneBotHeaders(),
            body: "{}",
        });
        const body = await r.text();
        res.json({
            ok: r.ok,
            status: r.status,
            onebotTokenConfigured: Boolean(ONEBOT_TOKEN),
            hint: r.ok
                ? "OneBot 连接正常，可以发消息"
                : "Token 或端口不对。ONEBOT_TOKEN 必须填 NapCat「HTTP 服务端」Token，不是 WebUI Token",
            body: body.slice(0, 300),
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

router.get("/status", (req, res) => {
    res.json({
        ok: true,
        botQq: BOT_QQ || null,
        onebotUrl: ONEBOT_HTTP_URL,
        onebotTokenConfigured: Boolean(ONEBOT_TOKEN),
        allowedGroups: ALLOWED_GROUPS.length ? ALLOWED_GROUPS : "all",
        trigger: "@bot only",
        maxReplyChars: getQQMaxChars(),
        character: getCharMeta().name || null,
    });
});

router.post("/webhook", (req, res) => {
    res.json({ status: "ok" });

    const event = req.body;
    if (!event || event.post_type !== "message" || event.message_type !== "group") {
        return;
    }

    handleGroupMessage(event).catch((err) => {
        console.error("[QQ] 处理群消息失败:", err);
    });
});

export default router;
