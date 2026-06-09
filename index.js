import { readFileSync, mkdtempSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

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
const { baseUrl, repo, channels = [], historyDays, dmLimit = 100 } = config;

if (!baseUrl || !repo || !historyDays) {
    console.error('Config must include: baseUrl, repo, historyDays');
    process.exit(1);
}
if (!channels.length && !dmLimit) {
    console.error('Config must have non-empty channels or dmLimit > 0');
    process.exit(1);
}

const rcToken = process.env.RC_TOKEN;
const userId = process.env.RC_USER_ID;
const ghToken = process.env.GH_TOKEN;
if (!rcToken || !userId) {
    console.error('Set RC_TOKEN and RC_USER_ID environment variables');
    process.exit(1);
}
if (!ghToken) {
    console.error('Set GH_TOKEN environment variable');
    process.exit(1);
}
const PREFIX = 'rocket-saver'
const authUrl = buildAuthUrl(repo, ghToken);
const outDir = mkdtempSync(join(tmpdir(), `${PREFIX}`));
console.log(`Cloning ${repo} ...`);
try {
    git(['clone', '--depth', '1', authUrl, outDir], undefined, ghToken);
} catch (err) {
    console.error(`Failed to clone repo: ${err.message}`);
    process.exit(1);
}

const headers = { 'X-Auth-Token': rcToken, 'X-User-Id': userId };

function sanitizeGitError(err, token) {
    const msg = err.stderr?.toString() || err.message || String(err);
    return msg.replaceAll(token, '***');
}

function git(args, cwd, ghToken) {
    try {
        return execFileSync('git', args, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        }).toString().trim();
    } catch (err) {
        throw new Error(sanitizeGitError(err, ghToken));
    }
}

function buildAuthUrl(repo, token) {
    const url = new URL(repo);
    url.username = 'x-access-token';
    url.password = token;
    return url.toString();
}

async function apiCall(path) {
    await new Promise(r => setTimeout(r, 200));
    const res = await fetch(`${baseUrl}/api/v1/${path}`, { headers });
    if (!res.ok) throw new Error(`API ${path}: ${res.status} ${res.statusText}`);
    return res.json();
}

async function resolveChannel(name) {
    try {
        const data = await apiCall(`channels.info?roomName=${encodeURIComponent(name)}`);
        return { id: data.channel._id, type: 'channels', name: data.channel.name };
    } catch (err) {
        if (!err.message.includes('400') && !err.message.includes('404')) throw err;
        const data = await apiCall(`groups.info?roomName=${encodeURIComponent(name)}`);
        return { id: data.group._id, type: 'groups', name: data.group.name };
    }
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

function getLastTimestamp(filePath) {
    try {
        const content = readFileSync(filePath, 'utf-8');
        const matches = [...content.matchAll(/```\ndate: (.+)\nauthor: .+\nmsgId: .+\n```/g)];
        if (matches.length === 0) return null;
        return matches[matches.length - 1][1];
    } catch {
        return null;
    }
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

const cutoffDate = new Date();
cutoffDate.setDate(cutoffDate.getDate() - historyDays);
const cutoff = cutoffDate.toISOString();

for (const channelName of channels) {
    console.log(`Processing: ${channelName}`);
    try {
        const channel = await resolveChannel(channelName);
        const filePath = join(outDir, `${channel.name}.md`);

        const lastTs = getLastTimestamp(filePath);
        let oldest = cutoff;
        if (lastTs && lastTs > cutoff) {
            // Bump by 1ms to avoid re-fetching the last saved message
            const d = new Date(lastTs);
            d.setMilliseconds(d.getMilliseconds() + 1);
            oldest = d.toISOString();
        }

        const messages = await fetchMessages(channel.id, channel.type, oldest);
        if (messages.length === 0) {
            console.log(`  No new messages`);
            continue;
        }

        if (!existsSync(filePath)) {
            appendFileSync(filePath, `# ${channel.name}\n\n`);
        }

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
            appendFileSync(filePath, formatMessage(msg, thread));
            saved++;
        }

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

                const lastTs = getLastTimestamp(filePath);
                let oldest = cutoff;
                if (lastTs && lastTs > cutoff) {
                    const d = new Date(lastTs);
                    d.setMilliseconds(d.getMilliseconds() + 1);
                    oldest = d.toISOString();
                }

                const messages = await fetchMessages(room._id, 'im', oldest);
                if (messages.length === 0) {
                    console.log(`  No new messages`);
                    continue;
                }

                if (!existsSync(filePath)) {
                    appendFileSync(filePath, `# DM with ${otherUsername}\n\n`);
                }

                let threadCount = 0;
                let saved = 0;
                for (const msg of messages) {
                    if (msg.t) continue;

                    let thread = null;
                    if (msg.tcount && msg.tcount > 0) {
                        thread = await fetchThread(msg._id);
                        threadCount++;
                    }
                    appendFileSync(filePath, formatMessage(msg, thread));
                    saved++;
                }

                console.log(`  Saved ${saved} messages (${threadCount} with threads), skipped ${messages.length - saved} system`);
            } catch (err) {
                console.error(`  Error processing DM ${otherUsername}: ${err.message}`);
            }
        }
    } catch (err) {
        console.error(`Failed to discover DMs: ${err.message}`);
    }
}

// Check for changes and push
const status = git(['status', '--porcelain'], outDir, ghToken);
if (status) {
    console.log('Committing and pushing changes...');
    const date = new Date().toISOString().split('T')[0];
    git(['add', '.'], outDir, ghToken);
    git(
        ['-c', `user.name=${PREFIX}`, '-c', `user.email=${PREFIX}@noreply`, 'commit', '-m', `Update ${date}`],
        outDir,
        ghToken
    );
    try {
        git(['push'], outDir, ghToken);
        console.log('Pushed successfully');
    } catch (err) {
        console.error(`Failed to push: ${err.message}`);
    }
} else {
    console.log('No changes to push');
}

console.log('Done');
