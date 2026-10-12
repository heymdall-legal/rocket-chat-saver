import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// наш чат использует серты минцифры
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const configPath = process.argv[2];
if (!configPath) {
    console.error('Usage: node index.js <config.json>');
    process.exit(1);
}

let config;
try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
} catch (err) {
    console.error(`Failed to read config: ${err.message}`);
    process.exit(1);
}
const {
    baseUrl,
    channels = [],
    historyDays,
    dmLimit = 100,
    outputDir = './export',
} = config;

if (!baseUrl || !historyDays) {
    console.error('Config must include: baseUrl, historyDays');
    process.exit(1);
}
if (!channels.length && !dmLimit) {
    console.error('Config must have non-empty channels or dmLimit > 0');
    process.exit(1);
}

const rcToken = process.env.RC_TOKEN;
const userId = process.env.RC_USER_ID;
if (!rcToken || !userId) {
    console.error('Set RC_TOKEN and RC_USER_ID environment variables');
    process.exit(1);
}
const outDir = resolve(outputDir);
mkdirSync(outDir, { recursive: true });
console.log(`Saving chats to: ${outDir}`);

const headers = { 'X-Auth-Token': rcToken, 'X-User-Id': userId };

async function apiCall(path) {
    await new Promise(r => setTimeout(r, 200));
    const res = await fetch(`${baseUrl}/api/v1/${path}`, { headers });
    if (!res.ok) throw new Error(`API ${path}: ${res.status} ${res.statusText}`);
    return res.json();
}

// Replacement for resolveChannel() in rocket-chat-saver/index.js.
// It resolves both public channels and private groups by display name
// and then uses the internal Rocket.Chat room ID.

let roomCache;

async function resolveChannel(name) {
    try {
        const data = await apiCall(
            `channels.info?roomName=${encodeURIComponent(name)}`
        );

        return {
            id: data.channel._id,
            type: 'channels',
            name: data.channel.name,
        };
    } catch (err) {
        if (!err.message.includes('400') && !err.message.includes('404')) {
            throw err;
        }
    }

    if (!roomCache) {
        const [channelsData, groupsData] = await Promise.all([
            apiCall('channels.list?count=100'),
            apiCall('groups.list?count=100'),
        ]);

        roomCache = [
            ...(channelsData.channels || []).map(room => ({
                ...room,
                type: 'channels',
            })),
            ...(groupsData.groups || []).map(room => ({
                ...room,
                type: 'groups',
            })),
        ];
    }

    const normalize = value =>
        String(value || '').trim().toLocaleLowerCase('ru-RU');

    const room = roomCache.find(room =>
        normalize(room.name) === normalize(name) ||
        normalize(room.fname) === normalize(name)
    );

    if (!room) {
        throw new Error(`Room not found: ${name}`);
    }

    return {
        id: room._id,
        type: room.type,
        name: room.name || room.fname || name,
    };
}

async function fetchMessages(channelId, channelType, oldest) {
    const allMessages = [];
    let latest = new Date().toISOString();

    while (true) {
        const data = await apiCall(
            `${channelType}.history?roomId=${channelId}&oldest=${oldest}&latest=${latest}&count=100`
        );
        const messages = data.messages;
        if (!messages || messages.length === 0) break;

        allMessages.push(...messages);
        const prevLatest = latest;
        latest = messages[messages.length - 1].ts;

        if (latest === prevLatest || messages.length < 100) break;
    }

    allMessages.reverse();
    return allMessages;
}

async function fetchThread(messageId) {
    const data = await apiCall(
        `chat.getThreadMessages?tmid=${messageId}&count=100`
    );
    return data.messages || [];
}

function formatMessage(msg, thread) {
    let md = '';
    md += '```\n';
    md += `date: ${msg.ts}\n`;
    md += `author: ${msg.u?.username || 'unknown'}\n`;
    md += `msgId: ${msg._id}\n`;
    md += '```\n';
    md += `${msg.msg || ''}\n`;

    if (thread && thread.length > 0) {
        const replies = thread.filter(t => t._id !== msg._id);
        if (replies.length > 0) {
            md += '\n<details>\n';
            md += `<summary>Thread, (${replies.length} messages)</summary>\n`;
            for (const reply of replies) {
                md += `\n**${reply.u?.username || 'unknown'}:**\n`;
                md += `${reply.msg || ''}\n`;
            }
            md += '\n</details>\n';
        }
    }

    md += '\n';
    return md;
}

function saveMarkdown(filePath, markdown) {
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, markdown);
    renameSync(temporaryPath, filePath);
}

const cutoffDate = new Date();
cutoffDate.setDate(cutoffDate.getDate() - historyDays);
const cutoff = cutoffDate.toISOString();

for (const channelName of channels) {
    console.log(`Processing: ${channelName}`);
    try {
        const channel = await resolveChannel(channelName);
        const filePath = join(outDir, `${channel.name}.md`);
        const messages = await fetchMessages(channel.id, channel.type, cutoff);
        let markdown = `# ${channel.name}\n\n`;

        let threadCount = 0;
        let saved = 0;
        for (const msg of messages) {
            // Skip system messages (user joined, left, etc.)
            if (msg.t) continue;

            let thread = null;
            if (msg.tcount && msg.tcount > 0) {
                thread = await fetchThread(msg._id);
                threadCount++;
            }
            markdown += formatMessage(msg, thread);
            saved++;
        }

        saveMarkdown(filePath, markdown);
        console.log(`  Saved ${saved} messages (${threadCount} with threads), skipped ${messages.length - saved} system`);
    } catch (err) {
        console.error(`  Error processing ${channelName}: ${err.message}`);
    }
}

// Process direct messages
if (dmLimit > 0) {
    const meData = await apiCall('me');
    const myUsername = meData.username;
    console.log(`Authenticated as: ${myUsername}`);
    console.log(`Discovering DMs (limit: ${dmLimit})...`);
    try {
        const dmData = await apiCall(`im.list?count=${dmLimit}&sort=${encodeURIComponent('{"ls":-1}')}`);
        const dmRooms = dmData.ims || [];
        console.log(`Found ${dmRooms.length} DM rooms`);

        for (const room of dmRooms) {
            const otherUsers = (room.usernames || []).filter(u => u !== myUsername);
            if (otherUsers.length === 0) {
                // Self-DM, skip
                continue;
            }
            const otherUsername = otherUsers[0];
            console.log(`Processing DM: ${otherUsername}`);

            try {
                const filePath = join(outDir, `dm-${otherUsername}.md`);
                const messages = await fetchMessages(room._id, 'im', cutoff);
                let markdown = `# DM with ${otherUsername}\n\n`;

                let threadCount = 0;
                let saved = 0;
                for (const msg of messages) {
                    if (msg.t) continue;

                    let thread = null;
                    if (msg.tcount && msg.tcount > 0) {
                        thread = await fetchThread(msg._id);
                        threadCount++;
                    }
                    markdown += formatMessage(msg, thread);
                    saved++;
                }

                saveMarkdown(filePath, markdown);
                console.log(`  Saved ${saved} messages (${threadCount} with threads), skipped ${messages.length - saved} system`);
            } catch (err) {
                console.error(`  Error processing DM ${otherUsername}: ${err.message}`);
            }
        }
    } catch (err) {
        console.error(`Failed to discover DMs: ${err.message}`);
    }
}

console.log('Done');
