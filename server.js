const express = require('express');
const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
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

// Active sessions: token -> { client, connection, player, guildId, channelId }
const activeBots = new Map();
let globalAudioPath = null;
let amplifierSettings = { gain: 0, airQuality: 10, bassBoost: 0 };

// API: Get bot status & servers for logged in tokens
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

// API: Connect Bots to Voice & Start 24/7 Audio Stream with Amplifier
app.post('/api/connect-amplifier', upload.single('media'), async (req, res) => {
    const { tokens, channelId, gain, airQuality, bassBoost } = req.body;
    if (req.file) {
        globalAudioPath = req.file.path;
    }

    if (gain) amplifierSettings.gain = gain;
    if (airQuality) amplifierSettings.airQuality = airQuality;
    if (bassBoost) amplifierSettings.bassBoost = bassBoost;

    if (!tokens || !channelId || !globalAudioPath) {
        return res.status(400).json({ success: false, message: 'Tokens, Channel ID, and Audio/Media file are required!' });
    }

    const tokenList = JSON.parse(tokens); // Array of active tokens selected
    let successCount = 0;
    let errors = [];

    for (const token of tokenList) {
        if (activeBots.has(token)) {
            // Already connected, update settings if needed
            continue;
        }

        try {
            const client = new Client({ checkUpdate: false });

            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Login timeout')), 20000);

                client.on('ready', async () => {
                    clearTimeout(timeout);
                    try {
                        const channel = await client.channels.fetch(channelId);
                        if (!channel || !channel.isVoice()) throw new Error('Valid voice channel not found');

                        const connection = joinVoiceChannel({
                            channelId: channel.id,
                            guildId: channel.guild.id,
                            adapterCreator: channel.guild.voiceAdapterCreator,
                            selfMute: true,
                            selfDeaf: true
                        });

                        const player = createAudioPlayer();
                        
                        const playLoop = () => {
                            try {
                                if (globalAudioPath && fs.existsSync(globalAudioPath)) {
                                    const resource = createAudioResource(globalAudioPath);
                                    player.play(resource);
                                }
                            } catch (err) {
                                console.error('[Dark Alise] Play error:', err);
                            }
                        };

                        player.on(AudioPlayerStatus.Idle, () => {
                            playLoop();
                        });

                        player.on('error', error => {
                            console.error('[Dark Alise Player Error]:', error.message);
                            setTimeout(playLoop, 3000);
                        });

                        playLoop();
                        connection.subscribe(player);

                        activeBots.set(token, { client, connection, player, channelId });
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
            errors.push({ tokenMasked: token.substring(0, 8) + '...', error: err.message });
        }
    }

    res.json({
        success: true,
        message: `Dark Alise: Amplifier active on ${successCount} accounts with Self-Mute & Self-Deaf enabled.`,
        errors
    });
});

// API: Disconnect Bots
app.post('/api/disconnect-amplifier', async (req, res) => {
    for (const [token, bot] of activeBots.entries()) {
        try {
            bot.player.stop();
            bot.connection.destroy();
            bot.client.destroy();
        } catch (e) {
            console.error('[Dark Alise Disconnect Error]', e);
        }
    }
    activeBots.clear();
    res.json({ success: true, message: 'Dark Alise: Amplifier disconnected and all bots stopped.' });
});

// API: Fetch Voice Channel Members for Infiltrate User
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
        res.json({ success: false, members: [], error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Dark Alise] Ultimate Control Panel running at http://localhost:${PORT}`);
});
