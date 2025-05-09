const Discord = require("discord.js");
const fs = require("fs");
const path = require("path");
const AntiSpam = require("discord-anti-spam");
const winston = require("winston");
const flatted = require("flatted");

process.send = process.send || function () {};

const logger = winston.createLogger({
    level: "info",
    format: winston.format.json(),
    defaultMeta: { service: "user-service" },
    transports: [
        new winston.transports.File({
            filename: path.join(__dirname, "/errors.log"),
            level: "error",
            format: winston.format.combine(
                winston.format.timestamp({
                    format: "YYYY-MM-DD hh:mm:ss A ZZ"
                }),
                winston.format.json()
            )
        }),
        new winston.transports.File({ filename: "combined.log" })
    ]
});
const Holder = {};
Holder.Bot = new Discord.Client({
    intents: [
        Discord.Intents.FLAGS.GUILDS,
        Discord.Intents.FLAGS.GUILD_MEMBERS,
        Discord.Intents.FLAGS.GUILD_BANS,
        Discord.Intents.FLAGS.GUILD_EMOJIS_AND_STICKERS,
        Discord.Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
        Discord.Intents.FLAGS.GUILD_VOICE_STATES,
        Discord.Intents.FLAGS.GUILD_MESSAGES,
        Discord.Intents.FLAGS.GUILD_MESSAGE_TYPING
    ]
});

Holder.MsgHandler = require("./Handlers/Message");
Holder.EventHandler = require("./Handlers/Events");
Holder.usercache = require("./Data/usercache");
Holder.Cache = require("./Data/varcache");
Holder.Discord = Discord;

Holder.SettingsFile = require("./Data/Settings/Settings.json");
Holder.RulesFile = require("./Data/Settings/Rules.json");
Holder.EventsFile = require("./Data/commands/events");
Holder.CommandsFile = require("./Data/commands/commands");
Holder.UserFile = __dirname + "/Data/user/user.json";

Holder.antiSpam = new AntiSpam(Holder.RulesFile.obj);
Holder.antiSpam.options.warnEnabled = Holder.RulesFile.obj.warnEnabled;
Holder.antiSpam.options.kickEnabled = Holder.RulesFile.obj.kickEnabled;
Holder.antiSpam.options.banEnabled = Holder.RulesFile.obj.banEnabled;
Holder.antiSpam.options.muteEnabled = false;
Holder.antiSpam.options.errorMessages = false;
Holder.antiSpam.options.verbose = false;

Holder.slashCommands = [];
Holder.buttons = [];
Holder.selects = [];

Holder.Mods = new Map();
Holder.loadMods = async function () {
    let dir = require("path").join(__dirname, "mods");
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir);
    }
    require("fs")
        .readdirSync(require("path").join(__dirname, "mods"))
        .forEach(mod => {
            const fetchedMod = require(require("path").join(__dirname, `mods/${mod}`));
            fetchedMod.init(Holder);
            if (fetchedMod.isEvent) {
                Holder.Bot.on(fetchedMod.name, fetchedMod.mod.bind(null, Holder.Bot));
            } else if (fetchedMod.isResponse) {
                Holder.Mods.set(fetchedMod.name, fetchedMod);
            }
        });
};

Holder.checkMessage = async function (message) {
    const prefix = Holder.SettingsFile.prefix;
    if (message.author.bot) return;

    try {
        let messageVars = {};
        messageVars.guild = message.guild;
        messageVars.member = message.member;
        messageVars.message = message;
        Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "Any Message", messageVars);
        if (Holder.RulesFile.enabled) {
            Holder.antiSpam.message(message);
        }

        if (!message.content.startsWith(prefix)) return;
        const args = message.content.slice(prefix.length).trim().split(/ +/g);
        const command = args.shift();
        var hasPermission = false;

        for (const commandF of Holder.CommandsFile.command) {
            if (commandF.name == command) {
                if (!commandF.perms || commandF.perms.length === 0) {
                    hasPermission = true;
                } else {
                    message.member.roles.cache.forEach(role => {
                        commandF.perms.forEach(perm => {
                            if (role.name.toLowerCase() === perm.toLowerCase()) {
                                hasPermission = true;
                            }
                        });
                    });
                }

                if (hasPermission) {
                    if (commandF.actions.length > 0) {
                        Holder.callNextAction(commandF, message, args, 0);
                    }
                }
            }
        }
        fs.writeFileSync(
            Holder.UserFile,
            JSON.stringify(Holder.usercache.memoryCache, null, 2),
            function (err) {
                if (err) return console.log(err);
            }
        );
        fs.writeFileSync(
            __dirname + "/Data/variables/servervars.json",
            flatted.stringify(Holder.serverVars, null, 2),
            function (err) {
                if (err) return console.log(err);
            }
        );
        fs.writeFileSync(
            __dirname + "/Data/variables/globalvars.json",
            flatted.stringify(Holder.globalVars, null, 2),
            function (err) {
                if (err) return console.log(err);
            }
        );
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Check Message: " + "[" + message.content + "] " + error.stack
        });
    }
};

Holder.callNextAction = async function (command, message, args, index) {
    try {
        var action = command.actions[index];
        var fetchedAction;
        if (action) {
            if (action.type) {
                fetchedAction = Holder.Mods.get(action.type);
            } else {
                fetchedAction = null;
            }

            if (!fetchedAction) {
                var msg = message;
                Holder.MsgHandler.Message_Handle(Holder, msg, command, index, args);
            } else {
                fetchedAction.mod(Holder, message, action, args, command, index);
            }
        }
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Call next action: " + "[" + message.content + "] " + error.stack
        });
    }
};

Holder.callNextEventAction = async function (type, varsE, index) {
    Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, index, type, varsE);
};

Holder.startBot = async function () {
    await Holder.Bot.login(Holder.SettingsFile.token)
        .then(value => {
            process.send("success");
        })
        .catch(e => {
            Holder.logError({
                level: "error",
                message: "Bot login: " + e
            });
        });

    Holder.registerSlashCommands();
    Holder.registerButtonsAndSelects();
    Holder.CheckIfLoaded();
};

Holder.registerButtonsAndSelects = async function () {
    let buttonsAndSelects = deepSearchItems(Holder.CommandsFile.command, "rowtype", (k, v) => k === "rowtype");
    let eventButtonsAndSelects = deepSearchItems(Holder.EventsFile.command, "rowtype", (k, v) => k === "rowtype");
    setEphemeralStatus(buttonsAndSelects);
    setEphemeralStatus(eventButtonsAndSelects);
};

function setEphemeralStatus(buttonsAndSelects) {
    buttonsAndSelects.forEach(item => {
        if (item.rowtype === "select") {
            let ephem = item.ephemeral ? true : false;
            Holder.selects[item.customid] = { ephemeral: ephem };
        }
        else if (item.rowtype === "button") {
            item.buttons.forEach(button => {
                let ephem = button.ephemeral ? true : false;
                Holder.buttons[button.customid] = { ephemeral: ephem };
            });
        }
    });
}

Holder.registerSlashCommands = async function () {
    let data = [];
    Holder.CommandsFile.command.forEach(command => {
        if (command.description) {
            data.push(command);
            let ephem = command.ephemeral ? true : false;
            Holder.slashCommands[command.name] = { ephemeral: ephem };
        }
    });
    if (data.length > 0) {
        await Holder.Bot.application?.commands.set(data);
    }
}

Holder.LoadedGuilds = [];

Holder.CheckIfLoaded = async function () {
    Holder.Bot.guilds.cache.forEach(async (guild) => {
        if (guild.available) {
            if (!Holder.LoadedGuilds.includes(guild.name)) {
                Holder.LoadedGuilds.push(guild.name);
                var serverObj = {};
                serverObj.guild = guild;
                Holder.callNextEventAction("Bot Initialization", serverObj, 0);
            }
        } else {
            setTimeout(Holder.CheckIfLoaded, 500);
        }
    });
};

Holder.loadBot = async function () {
    await Holder.loadMods().catch(e => {
        Holder.logError({
            level: "error",
            message: "Loading mods: " + e
        });
    });
    await Holder.startBot();
};

Holder.Bot.on("messageCreate", message => Holder.checkMessage(message));
Holder.Bot.on("guildMemberAdd", member => {
    try {
        Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "User Joins Server", member);
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Guild member add: " + error.stack
        });
    }
});
Holder.Bot.on("guildMemberRemove", member => {
    try {
        Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "User Kicked", member);
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Guild member remove: " + error.stack
        });
    }
});
Holder.Bot.on("guildBanAdd", (guild, user) => {
    let banVars = {};
    banVars.guild = guild;
    banVars.user = user;
    try {
        Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "User Banned", banVars);
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Guild ban add: " + error.stack
        });
    }
});
Holder.Bot.on("channelCreate", channel => {
    let channelVars = {};
    channelVars.guild = channel.guild;
    channelVars.channel = channel;
    try {
        Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "Channel Create", channelVars);
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Channel create: " + error.stack
        });
    }
});
Holder.Bot.on("channelDelete", channel => {
    let channelVars = {};
    channelVars.guild = channel.guild;
    channelVars.channel = channel;
    try {
        Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "Channel Delete", channelVars);
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Channel delete: " + error.stack
        });
    }
});
Holder.Bot.on("channelPinsUpdate", (channel, time) => {
    let channelVars = {};
    channelVars.guild = channel.guild;
    channelVars.channel = channel;
    try {
        Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "Channel Pins Update", channelVars);
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Channel pins update: " + error.stack
        });
    }
});
Holder.Bot.on("channelUpdate", (oldchannel, newchannel) => {
    let channelVars = {};
    channelVars.guild = newchannel.guild;
    channelVars.oldchannel = oldchannel;
    channelVars.newchannel = newchannel;
    try {
        Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "Channel Update", channelVars);
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Channel update: " + error.stack
        });
    }
});
Holder.Bot.on("emojiCreate", emoji => {
    let emojiVars = {};
    emojiVars.guild = emoji.guild;
    emojiVars.emoji = emoji;
    try {
        Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "Emoji Create", emojiVars);
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Emoji create: " + error.stack
        });
    }
});
Holder.Bot.on("emojiDelete", emoji => {
    let emojiVars = {};
    emojiVars.guild = emoji.guild;
    emojiVars.emoji = emoji;
    try {
        Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "Emoji Delete", emojiVars);
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Emoji delete: " + error.stack
        });
    }
});
Holder.Bot.on("emojiUpdate", (oldemoji, newemoji) => {
    let emojiVars = {};
    emojiVars.guild = newemoji.guild;
    emojiVars.oldemoji = oldemoji;
    emojiVars.newemoji = newemoji;
    try {
        Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "Emoji Update", emojiVars);
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Emoji update: " + error.stack
        });
    }
});
Holder.Bot.on("guildBanRemove", (guild, user) => {
    let emojiVars = {};
    emojiVars.guild = guild;
    emojiVars.user = user;
    try {
        Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "Guild Ban Remove", emojiVars);
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Guild ban remove: " + error.stack
        });
    }
});
Holder.Bot.on("guildCreate", guild => {
    let guildVars = {};
    guildVars.guild = guild;
    try {
        Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "Guild Create", guildVars);
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Guild create: " + error.stack
        });
    }
});
Holder.Bot.on("guildDelete", guild => {
    let guildVars = {};
    guildVars.guild = guild;
    try {
        Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "Guild Delete", guildVars);
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Guild delete: " + error.stack
        });
    }
});
Holder.Bot.on("guildMemberAvailable", member => {
    let guildVars = {};
    guildVars.guild = member.guild;
    guildVars.member = member;
    try {
        Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "Guild Member Available", guildVars);
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Guild member available: " + error.stack
        });
    }
});
Holder.Bot.on("guildMemberSpeaking", (member, speaking) => {
    let guildVars = {};
    guildVars.guild = member.guild;
    guildVars.member = member;
    try {
        Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "Guild Member Speaking", guildVars);
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Guild member speaking: " + error.stack
        });
    }
});
Holder.Bot.on("guildMemberUpdate", (oldmember, newmember) => {
    let guildVars = {};
    guildVars.guild = newmember.guild;
    guildVars.oldmember = oldmember;
    guildVars.newmember = newmember;
    try {
        Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "Guild Member Update", guildVars);
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Guild member update: " + error.stack
        });
    }
});
Holder.Bot.on("guildUnavailable", guild => {
    let guildVars = {};
    guildVars.guild = guild;
    try {
        Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "Guild Unavailable", guildVars);
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Guild unavailable: " + error.stack
        });
    }
});
Holder.Bot.on("guildUpdate", (oldguild, newguild) => {
    let guildVars = {};
    guildVars.guild = newguild;
    guildVars.oldguild = oldguild;
    guildVars.newguild = newguild;
    try {
        Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "Guild Update", guildVars);
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Guild update: " + error.stack
        });
    }
});
Holder.Bot.on("messageDelete", message => {
    let guildVars = {};
    guildVars.guild = message.guild;
    guildVars.message = message;
    try {
        Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "Message Delete", guildVars);
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Message delete: " + error.stack
        });
    }
});
Holder.Bot.on("messageUpdate", (oldmessage, newmessage) => {
    let guildVars = {};
    guildVars.guild = newmessage.guild;
    guildVars.newmessage = newmessage;
    guildVars.oldmessage = oldmessage;
    try {
        Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "Message Update", guildVars);
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Message update: " + error.stack
        });
    }
});
Holder.Bot.on("roleCreate", role => {
    let guildVars = {};
    guildVars.guild = role.guild;
    guildVars.role = role;
    try {
        Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "Role Create", guildVars);
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Role create: " + error.stack
        });
    }
});
Holder.Bot.on("roleDelete", role => {
    let guildVars = {};
    guildVars.guild = role.guild;
    guildVars.role = role;
    try {
        Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "Role Delete", guildVars);
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Role delete: " + error.stack
        });
    }
});
Holder.Bot.on("roleUpdate", (oldrole, newrole) => {
    let guildVars = {};
    guildVars.guild = newrole.guild;
    guildVars.oldrole = oldrole;
    guildVars.newrole = newrole;
    try {
        Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "Role Update", guildVars);
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Role update: " + error.stack
        });
    }
});
Holder.Bot.on("typingStart", (typing) => {
    let guildVars = {};
    guildVars.guild = typing.channel.guild;
    guildVars.channel = typing.channel;
    guildVars.user = typing.user;
    try {
        Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "Typing Start", guildVars);
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Typing start: " + error.stack
        });
    }
});
Holder.Bot.on("userUpdate", (olduser, newuser) => {
    let guildVars = {};
    guildVars.guild = newuser.guild;
    guildVars.olduser = olduser;
    guildVars.newuser = newuser;
    try {
        Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "User Update", guildVars);
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "User Update: " + error.stack
        });
    }
});
Holder.Bot.on("interactionCreate", async interaction => {
    let guildVars = {};
    guildVars.guild = interaction.guild;
    try {
        if (interaction.isButton()) {
            await interaction.deferReply({ ephemeral: Holder.buttons[interaction.customId]["ephemeral"] });
            guildVars.buttoninteraction = interaction;
            Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "Button Interaction", guildVars);
        } else if (interaction.isSelectMenu()) {
            await interaction.deferReply({ ephemeral: Holder.selects[interaction.customId]["ephemeral"] });
            guildVars.selectinteraction = interaction;
            Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "Select Interaction", guildVars);
        }
        else {
            await interaction.deferReply({ ephemeral: Holder.slashCommands[interaction.commandName]["ephemeral"] });
            guildVars.commandinteraction = interaction;
            Holder.EventHandler.Event_Handle(Holder, Holder.EventsFile, 0, "Command Interaction", guildVars);
        }
    } catch (error) {
        Holder.logError({
            level: "error",
            message: "Interaction Create: " + error.stack
        });
    }
});

Holder.loadVars = async function () {
    Holder.serverVars = {};
    Holder.globalVars = {};
    try {
        var rawserverdata = fs.readFileSync(__dirname + "/Data/variables/servervars.json");
        var serverdata = flatted.parse(rawserverdata);
    } catch (error) {
        var serverdata = {};
    }

    try {
        var rawglobaldata = fs.readFileSync(__dirname + "/Data/variables/globalvars.json");
        var globaldata = flatted.parse(rawglobaldata);
    } catch (error) {
        var globaldata = {};
    }

    Holder.serverVars = serverdata;
    Holder.globalVars = globaldata;
};

Holder.loadVars();
Holder.loadBot();

function cleanExit() {
    try {
        Holder.Bot.destroy();
        process.exit(0);
    } catch (error) {
        console.log(error);
    }
}

process.on("message", msg => {
    if (msg.action === "STOP") {
        cleanExit();
    }
});

process.on("unhandledRejection", (error, p) => {
    Holder.logError({ level: "error", message: "Unhandled rejection: " + error.stack });
});

Holder.logError = async function (error) {
    logger.log(error);
    process.send(error.message);
};

function deepSearchItems(object, key, predicate) {
    let ret = [];
    if (object.hasOwnProperty(key) && predicate(key, object[key]) === true) {
        ret = [...ret, object];
    }
    if (Object.keys(object).length) {
        for (let i = 0; i < Object.keys(object).length; i++) {
            let value = object[Object.keys(object)[i]];
            if (typeof value === "object" && value != null) {
                let o = deepSearchItems(object[Object.keys(object)[i]], key, predicate);
                if (o != null && o instanceof Array) {
                    ret = [...ret, ...o];
                }
            }
        }
    }
    return ret;
}
