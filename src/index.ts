import Database from "better-sqlite3";
import fs from "fs";
import yargs from "yargs";
import askClaude from "./actions/ask_claude.ts";
import follow_room from "./actions/follow_room.ts";
import mute_room from "./actions/mute_room.ts";
import unfollow_room from "./actions/unfollow_room.ts";
import unmute_room from "./actions/unmute_room.ts";
import { SqliteDatabaseAdapter } from "./adapters/sqlite.ts";
import { DiscordClient } from "./clients/discord/index.ts";
import DirectClient from "./clients/direct/index.ts";
import { TelegramClient } from "./clients/telegram/src/index.ts"; // Added Telegram import
import { defaultActions } from "./core/actions.ts";
import defaultCharacter from "./core/defaultCharacter.ts";
import { AgentRuntime } from "./core/runtime.ts";
import settings from "./core/settings.ts";
import { Character, IAgentRuntime } from "./core/types.ts"; // Added IAgentRuntime
import boredomProvider from "./providers/boredom.ts";
import timeProvider from "./providers/time.ts";
import { wait } from "./clients/twitter/utils.ts";
import { TwitterSearchClient } from "./clients/twitter/search.ts";
import { TwitterInteractionClient } from "./clients/twitter/interactions.ts";
import { TwitterGenerationClient } from "./clients/twitter/generate.ts";
import { TwitterOAuthClient } from "./clients/twitter_oauth/base.ts";
import TwitterOAuthIntegration from "./clients/twitter_oauth/index.ts";

// Add at the top of the file
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  console.error('Stack:', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise);
  console.error('Reason:', reason);
});

// Use import.meta.url for module paths instead of module.paths
console.log('Current directory:', process.cwd());
console.log('Script path:', import.meta.url);
console.log('Node version:', process.version);
console.log('Env:', process.env.NODE_ENV);

// Add ONNX cleanup handler
process.on('exit', () => {
  // Clean up ONNX runtime resources
  try {
    if (global.ort) {
      global.ort.cleanupRuntime();
    }
  } catch (error) {
    console.error('Error cleaning up ONNX runtime:', error);
  }
});

interface Arguments {
  character?: string;
  characters?: string;
  discord?: boolean;
  telegram?: boolean;
  port?: number;
}

let argv: Arguments = {
  character: "./src/agent/default_character.json",
  characters: "",
  port: 3000,
};

try {
  // Parse command line arguments
  argv = yargs(process.argv.slice(2))
    .option("character", {
      type: "string",
      description: "Path to the character JSON file",
    })
    .option("characters", {
      type: "string",
      description: "Comma separated list of paths to character JSON files",
    })
    .option("telegram", {
      type: "boolean",
      description: "Enable Telegram client",
      default: false,
    })
    .option("port", {
      type: "number",
      description: "Port number for the server",
      default: 3000,
    })
    .parseSync() as Arguments;
} catch (error) {
  console.log("Error parsing arguments:");
  console.log(error);
}

// Load character
const characterPath = argv.character || argv.characters;

console.log("characterPath", characterPath);

const characterPaths = argv.characters?.split(",").map((path) => path.trim());

console.log("characterPaths", characterPaths);

const characters = [];

const directClient = new DirectClient();
directClient.start(argv.port);

if (characterPaths?.length > 0) {
  for (const path of characterPaths) {
    try {
      const character = JSON.parse(fs.readFileSync(path, "utf8"));
      console.log("character", character.name);
      characters.push(character);
    } catch (e) {
      console.log(`Error loading character from ${path}: ${e}`);
    }
  }
}

async function startAgent(character: Character) {
  console.log("Starting agent for character " + character.name);
  const token = character.settings?.secrets?.OPENAI_API_KEY ||
  (settings.OPENAI_API_KEY as string)

  console.log("token", token);
  const db = new SqliteDatabaseAdapter(new Database("./db.sqlite"))
  const runtime = new AgentRuntime({
    databaseAdapter: db,
    token:
      token,
    serverUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
    evaluators: [],
    character,
    providers: [timeProvider, boredomProvider],
    actions: [
      ...defaultActions,
      askClaude,
      follow_room,
      unfollow_room,
      unmute_room,
      mute_room,
    ],
  });
  console.log("runtime", runtime);
  const directRuntime = new AgentRuntime({
    databaseAdapter: db,
    token:
      character.settings?.secrets?.OPENAI_API_KEY ??
      (settings.OPENAI_API_KEY as string),
    serverUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    evaluators: [],
    character,
    providers: [timeProvider, boredomProvider],
    actions: [
      ...defaultActions,
    ],
  });

  function startDiscord(runtime: IAgentRuntime) {
    const discordClient = new DiscordClient(runtime);
    return discordClient;
  }

  async function startTelegram(runtime: IAgentRuntime, character: Character) {
    console.log("🔍 Attempting to start Telegram bot...");
    
    const botToken =
      character.settings?.secrets?.TELEGRAM_BOT_TOKEN ??
      settings.TELEGRAM_BOT_TOKEN;
  
    if (!botToken) {
      console.error(
        `❌ Telegram bot token is not set for character ${character.name}.`
      );
      return null;
    }
  
    console.log("✅ Bot token found, initializing Telegram client...");
  
    try {
      console.log("Creating new TelegramClient instance...");
      const telegramClient = new TelegramClient(runtime, botToken);
      
      console.log("Calling start() on TelegramClient...");
      await telegramClient.start();
      
      console.log(`✅ Telegram client successfully started for character ${character.name}`);
      return telegramClient;
    } catch (error) {
      console.error(`❌ Error creating/starting Telegram client for ${character.name}:`, error);
      return null;
    }
  }

  async function startTwitter(runtime) {
   console.log("Starting search client");
   const twitterSearchClient = new TwitterSearchClient(runtime);
   await wait();
   console.log("Starting interaction client");
   const twitterInteractionClient = new TwitterInteractionClient(runtime);
   await wait();
   console.log("Starting generation client");
   const twitterGenerationClient = new TwitterGenerationClient(runtime);
  
   return {
     twitterInteractionClient,
     twitterSearchClient,
     twitterGenerationClient,
   };
  }

  if (!character.clients) {
    return console.error("No clients found for character " + character.name);
  }

  const clients = [];

  if (character.clients.map((str) => str.toLowerCase()).includes("discord")) {
    const discordClient = startDiscord(runtime);
    clients.push(discordClient);
  }

  // Add Telegram client initialization
  if (
    (argv.telegram || character.clients.map((str) => str.toLowerCase()).includes("telegram"))
  ) {
    console.log("🔄 Telegram client enabled, starting initialization...");
    const telegramClient = await startTelegram(runtime, character);
    if (telegramClient) {
      console.log("✅ Successfully added Telegram client to active clients");
      clients.push(telegramClient);
    } else {
      console.log("❌ Failed to initialize Telegram client");
    }
  }

  if (character.clients.map((str) => str.toLowerCase()).includes("twitter")) {
   const {
     twitterInteractionClient,
     twitterSearchClient,
     twitterGenerationClient,
   } = await startTwitter(runtime);
   clients.push(
     twitterInteractionClient, twitterSearchClient, twitterGenerationClient,
   );
  }

  if (character.clients.map((str) => str.toLowerCase()).includes("twitter_oauth")) {
    console.log("🔄 Initializing Twitter OAuth client...");
    try {
      const twitterConfig = {
        accessToken: character.settings?.secrets?.TWITTER_ACCESS_TOKEN,
        refreshToken: character.settings?.secrets?.TWITTER_REFRESH_TOKEN,
        username: character.settings?.secrets?.TWITTER_USERNAME,
      };

      if (twitterConfig.accessToken && twitterConfig.refreshToken && twitterConfig.username) {
        console.log("🔄 Twitter OAuth client configuration:", {
          username: twitterConfig.username,
          nodeVersion: process.version,
          cwd: process.cwd(),
        });
        
        try {
          const twitterClient = new TwitterOAuthIntegration(
            { runtime: runtime },
            twitterConfig
          );
          clients.push(twitterClient); 
          console.log("✅ Twitter OAuth client initialized successfully");
        } catch (initError) {
          console.error("❌ Twitter client initialization failed:", initError);
          // Continue without Twitter client
        }
      } else {
        console.log("❌ Missing Twitter OAuth credentials");
      }
    } catch (error) {
      console.error("❌ Error in Twitter OAuth setup:", error);
      // Continue without Twitter client
    }
  }

  directClient.registerAgent(directRuntime);

  return clients;
}

const startAgents = async () => {
  if (characters.length === 0) {
    console.log("No characters found, using default character");
    characters.push(defaultCharacter);
  }
  for (const character of characters) {
    await startAgent(character);
  }
};

startAgents();

import readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function chat() {
  rl.question('You: ', async (input) => {
    if (input.toLowerCase() === 'exit') {
      rl.close();
      return;
    }

    const agentId = characters[0].name.toLowerCase(); // Assuming we're using the first character
    const response = await fetch(`http://localhost:3000/${agentId}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: input,
        userId: 'user',
        userName: 'User',
      }),
    });

    const data = await response.json();
    console.log(`${characters[0].name}: ${data.text}`);
    chat();
  });
}

console.log("Chat started. Type 'exit' to quit.");
chat();