const express = require('express');
const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const { Streamer } = require('@dank074/discord-video-stream');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const upload = multer({ dest: 'uploads/' });

// Active sessions: token -> { client, connection, player, streamer, channelId, guildId, isMuted, isDeaf, isCamOn, mediaPath }
const activeBots = new Map();
let globalMediaPath = null;

app.post('/api/fetch-account-info', async (req, res) => {
    const { tokens } = req.body;
    if (!tokens) return res.status(400).json({ success: false, message: 'No tokens provided' });

    const tokenList = tokens.split(/\r?\n|,/).map(t => t.trim()).filter(Boolean);
    let accountsData = [];

    for (const token of tokenList) {
        try {
            const tempClient = new Client({ checkUpdate: false });
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Timeout')), 10000);
                tempClient.on('ready', () => {
                    clearTimeout(timer);
                    resolve();
                });
                tempClient.login(token).catch(reject);
            });

            const guilds = tempClient.guilds.cache.map(g => ({
                id: g.id,
                name: g.name,
                icon: g.iconURL() || 'https://cdn.discordapp.com/embed/avatars/0.png'
            }));

            accountsData.push({
                token,
                username: tempClient.user.tag,
                avatar: tempClient.user.displayAvatarURL(),
                guilds
            });

            tempClient.destroy();
        } catch (err) {
            console.error('[Dark Alise] Failed to fetch token info:', err.message);
        }
    }

    res.json({ success: true, accounts: accountsData });
});

// API: Connect Amplifier & Stream (Audio or Video with Self-Mute & Self-Deaf)
app.post('/api/connect-amplifier', upload.single('media'), async (req, res) => {
    const { tokens, channelId, gain, airQuality, bassBoost, selfMute, selfDeaf, camOn } = req.body;
    if (req.file) {
        globalMediaPath = req.file.path;
    }

    if (!tokens || !channelId || !globalMediaPath) {
        return res.status(400).json({ success: false, message: 'Tokens, Channel ID, and Media file are required!' });
    }

    const tokenList = JSON.parse(tokens);
    const isMuted = selfMute === 'true' || selfMute === true;
    const isDeaf = selfDeaf === 'true' || selfDeaf === true;
    const isCam = camOn === 'true' || camOn === true;
    const isVideoFile = globalMediaPath && (globalMediaPath.endsWith('.mp4') || globalMediaPath.endsWith('.webm') || isCam);

    let successCount = 0;

    for (const token of tokenList) {
        if (activeBots.has(token)) continue;

        try {
            const client = new Client({ checkUpdate: false });

            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Login timeout')), 20000);

                client.on('ready', async () => {
                    clearTimeout(timeout);
                    try {
                        const channel = await client.channels.fetch(channelId);
                        if (!channel || !channel.isVoice()) throw new Error('Valid voice channel not found');

                        let streamer = null;
                        let connection = null;
                        let player = null;

                        if (isVideoFile || isCam) {
                            streamer = new Streamer(client);
                            await streamer.joinVoice(channel.guild.id, channel.id, {
                                selfMute: isMuted,
                                selfDeaf: isDeaf,
                                videoQuality: 1080
                            });
                            if (fs.existsSync(globalMediaPath) && !globalMediaPath.endsWith('.mp3') && !globalMediaPath.endsWith('.wav')) {
                                await streamer.playVideo(globalMediaPath);
                            }
                        } else {
                            connection = joinVoiceChannel({
                                channelId: channel.id,
                                guildId: channel.guild.id,
                                adapterCreator: channel.guild.voiceAdapterCreator,
                                selfMute: isMuted,
                                selfDeaf: isDeaf
                            });
                            player = createAudioPlayer();
                            const playLoop = () => {
                                try {
                                    if (globalMediaPath && fs.existsSync(globalMediaPath)) {
                                        player.play(createAudioResource(globalMediaPath));
                                    }
                                } catch (err) { console.error(err); }
                            };
                            player.on(AudioPlayerStatus.Idle, playLoop);
                            player.on('error', () => { setTimeout(playLoop, 3000); });
                            playLoop();
                            connection.subscribe(player);
                        }

                        activeBots.set(token, {
                            client, connection, player, streamer, channelId, guildId: channel.guild.id,
                            isMuted, isDeaf, isCamOn: isCam, mediaPath: globalMediaPath
                        });
                        resolve();
                    } catch (err) {
                        client.destroy();
                        reject(err);
                    }
                });

                client.login(token).catch(reject);
            });
            successCount++;
        } catch (err) {
            console.error('[Dark Alise Error]', err.message);
        }
    }

    res.json({
        success: true,
        message: `Dark Alise: Amplifier active on ${successCount} accounts (Muted: ${isMuted}, Deaf: ${isDeaf}, Cam: ${isCam}).`
    });
});

// API: Live Toggle Controls (Mute, Deaf, Cam)
app.post('/api/control-toggle', async (req, res) => {
    const { action, value } = req.body; // action: 'mute', 'deaf', 'cam' | value: true/false
    let successCount = 0;

    for (const [token, bot] of activeBots.entries()) {
        try {
            if (action === 'mute') bot.isMuted = value;
            if (action === 'deaf') bot.isDeaf = value;
            if (action === 'cam') bot.isCamOn = value;

            // Rejoin voice with updated settings
            if (bot.streamer) {
                await bot.streamer.joinVoice(bot.guildId, bot.channelId, {
                    selfMute: bot.isMuted,
                    selfDeaf: bot.isDeaf,
                    videoQuality: 1080
                });
                if (bot.isCamOn && bot.mediaPath) {
                    await bot.streamer.playVideo(bot.mediaPath);
                } else if (!bot.isCamOn && bot.streamer) {
                    bot.streamer.stop();
                }
            } else if (bot.connection) {
                bot.connection.destroy();
                const client = bot.client;
                const channel = await client.channels.fetch(bot.channelId);
                const newConn = joinVoiceChannel({
                    channelId: channel.id,
                    guildId: channel.guild.id,
                    adapterCreator: channel.guild.voiceAdapterCreator,
                    selfMute: bot.isMuted,
                    selfDeaf: bot.isDeaf
                });
                if (bot.player) newConn.subscribe(bot.player);
                bot.connection = newConn;
            }
            successCount++;
        } catch (err) {
            console.error('[Dark Alise Control Error]', err);
        }
    }

    res.json({ success: true, message: `Dark Alise: Updated ${action} to ${value} on ${successCount} active bots.` });
});

// API: Disconnect Bots
app.post('/api/disconnect-amplifier', async (req, res) => {
    for (const [token, bot] of activeBots.entries()) {
        try {
            if (bot.player) bot.player.stop();
            if (bot.streamer) { bot.streamer.stop(); await bot.streamer.leaveVoice(); }
            if (bot.connection) bot.connection.destroy();
            bot.client.destroy();
        } catch (e) {
            console.error('[Dark Alise Disconnect Error]', e);
        }
    }
    activeBots.clear();
    res.json({ success: true, message: 'Dark Alise: Amplifier disconnected and all bots stopped.' });
});

// API: Fetch Voice Channel Members
app.post('/api/fetch-members', async (req, res) => {
    const { token, channelId } = req.body;
    if (!token || !channelId) return res.status(400).json({ success: false, members: [] });

    try {
        const tempClient = new Client({ checkUpdate: false });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Timeout')), 10000);
            tempClient.on('ready', () => { clearTimeout(timer); resolve(); });
            tempClient.login(token).catch(reject);
        });

        const channel = await tempClient.channels.fetch(channelId);
        let members = [];
        if (channel && channel.isVoice()) {
            members = channel.members.map(m => ({
                id: m.user.id,
                username: m.user.tag,
                avatar: m.user.displayAvatarURL()
            }));
        }
        tempClient.destroy();
        res.json({ success: true, members });
    } catch (err) {
        res.json({ success: false, members: [] });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Dark Alise] Control Panel running at http://localhost:${PORT}`);
});
